import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/lgpd/requests/bulk-redact
 *
 * Cria E aprova, num só passo, uma solicitação `redact` (scope contact) para
 * CADA contato não-anonimizado da org ativa — pensado pro caso "o número
 * conectado nesta conta estava errado, não faz sentido preservar histórico de
 * quem falou com ele". Não é o caminho `store_redact` (que marca
 * `organizations.status='redacted'`, pra desinstalação de loja inteira): esta
 * rota mantém a organização ativa e usável, só esvazia o histórico de
 * conversas dela.
 *
 * Reaproveita createLgpdRequest (lib/lgpd/repository.ts) e o MESMO efeito que
 * POST /lgpd/requests/[id]/approve produz (emit_event + status→processing) —
 * o worker (workers/lgpd-redact-worker.ts) processa cada uma normalmente.
 *
 * Auth: cookie session, role >= admin (mesmo padrão do approve — sem MFA: a
 * rota que EXIGE MFA é a anonimização direta de 1 contato via RPC; aprovar
 * pedidos LGPD nunca exigiu, e esta rota só reproduz esse efeito em lote).
 * Idempotency-Key obrigatório: reexecutar com a mesma chave não duplica.
 */
import { randomUUID, createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createLgpdRequest } from "@/lib/lgpd/repository";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  justification: z.string().min(10).max(500),
});

const REDACT_SLA_DAYS = 15;

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;
  const orgId = activeOrg.orgId;

  const idempotencyKey = req.headers.get("Idempotency-Key") ?? req.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail("missing_idempotency_key", t("Header Idempotency-Key é obrigatório."), 422, {
      requestId,
    });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      details: parsed.error.flatten(),
      requestId,
    });
  }
  const { justification } = parsed.data;

  const admin = createAdminClient();
  const endpoint = "/api/v1/lgpd/requests/bulk-redact";
  const requestHash = createHash("sha256").update(JSON.stringify({ orgId, justification })).digest("hex");

  const { data: existingKey } = await admin
    .from("idempotency_keys")
    .select("response_body")
    .eq("organization_id", orgId)
    .eq("key", idempotencyKey)
    .eq("endpoint", endpoint)
    .maybeSingle();
  if (existingKey) {
    return ok(existingKey.response_body as Record<string, unknown>, { requestId, status: 200 });
  }

  const { data: contacts, error: contactsErr } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_anonymized", false);
  if (contactsErr) {
    return fail("internal_error", contactsErr.message, 500, { requestId });
  }

  const { data: jaSolicitados } = await admin
    .from("lgpd_requests")
    .select("contact_id")
    .eq("organization_id", orgId)
    .eq("request_type", "redact")
    .in("status", ["received", "processing", "completed"]);
  const jaSolicitadosSet = new Set((jaSolicitados ?? []).map((r) => r.contact_id as string));

  const alvo = (contacts ?? []).filter((c) => !jaSolicitadosSet.has(c.id));

  const criados: string[] = [];
  for (const contato of alvo) {
    const { id: requestIdLgpd } = await createLgpdRequest({
      organizationId: orgId,
      requestType: "redact",
      source: "manual",
      contactId: contato.id,
      receivedAt: new Date(),
      slaDays: REDACT_SLA_DAYS,
      scope: "contact",
      payload: { motivo: "bulk_redact_admin", bulk_request_id: requestId },
    });

    const { error: emitErr } = await admin.rpc("emit_event", {
      p_event_type: "lgpd.redact_received",
      p_entity_kind: "lgpd_request",
      p_entity_id: requestIdLgpd,
      p_payload: {
        request_id: requestIdLgpd,
        organization_id: orgId,
        manually_approved: true,
        approved_by: authUser.id,
        approved_reason: justification,
        contact_id: contato.id,
      } as unknown as Record<string, unknown>,
      p_metadata: { manually_approved: true, bulk: true, idempotency_key: idempotencyKey },
      p_organization_id: orgId,
    });
    if (emitErr) {
      console.error("[lgpd-bulk-redact] emit_event failed", emitErr.message);
      // Não interrompe o lote — worker recupera via cron, mesma tolerância do approve individual.
    }

    await admin
      .from("lgpd_requests")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("organization_id", orgId)
      .eq("id", requestIdLgpd);

    criados.push(requestIdLgpd);
  }

  void audit({
    action: "lgpd.bulk_redact_requested",
    actorUserId: authUser.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: {
      justification,
      requested_count: criados.length,
      skipped_count: alvo.length - criados.length,
      already_requested_count: jaSolicitadosSet.size,
      request_ids: criados,
      idempotency_key: idempotencyKey,
    },
  });

  const responseBody = {
    requested: criados.length,
    skipped_already_requested: jaSolicitadosSet.size,
    request_ids: criados,
  };

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await admin.from("idempotency_keys").insert({
    organization_id: orgId,
    key: idempotencyKey,
    endpoint,
    request_hash: requestHash,
    response_body: responseBody as unknown as Record<string, unknown>,
    status_code: 200,
    expires_at: expiresAt,
  });

  return ok(responseBody, { requestId });
}

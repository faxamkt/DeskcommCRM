/**
 * PATCH  /api/v1/crm/webhooks/:id — liga/desliga uma entrada automática de
 *        contatos (integração Clinicfx). Body: { is_active: boolean }.
 * DELETE /api/v1/crm/webhooks/:id — remove a entrada.
 *
 * PATCH reaproveita `definirEntradaAtiva` (mesma regra da tela e do agente de
 * IA). Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import type { Actor } from "@/lib/api/handlers/types";
import { fail, noContent, ok } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { definirEntradaAtiva } from "@/lib/operacao/entradas-automaticas";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const patchSchema = z.object({ is_active: z.boolean() });

type Ctx = { params: Promise<{ id: string }> };

function actorDoToken(auth: { created_by: string | null; role: string; api_token_id: string }): Actor {
  return auth.created_by
    ? { type: "user", id: auth.created_by, role: auth.role }
    : { type: "webhook_source", id: auth.api_token_id };
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();
  try {
    const fonte = await definirEntradaAtiva(
      { supabase: admin, organizationId: auth.organization_id, actor: actorDoToken(auth), requestId },
      { id, ativa: parsed.data.is_active },
    );
    return ok(fonte, { requestId });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { details: err.details, requestId });
    return fail("internal_error", err instanceof Error ? err.message : "erro desconhecido", 500, { requestId });
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("webhook_sources")
    .select("id")
    .eq("id", id)
    .eq("organization_id", auth.organization_id)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", "Entrada não encontrada.", 404, { requestId });

  const { error } = await admin
    .from("webhook_sources")
    .delete()
    .eq("id", id)
    .eq("organization_id", auth.organization_id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "webhook.source_deleted",
    actorUserId: auth.created_by,
    actorApiTokenId: auth.api_token_id,
    organizationId: auth.organization_id,
    resourceType: "webhook_source",
    resourceId: id,
    requestId,
    metadata: { via: "clinicfx" },
  });

  return noContent(requestId);
}

/**
 * POST /api/v1/crm/contacts/find-or-create — acha (ou cria) o contato pelo
 * telefone e garante uma conversa aberta na sessão de WhatsApp ativa da org.
 * Pensado pro Clinicfx mandar um documento (atestado, receituário) direto pro
 * paciente sem o operador precisar abrir o inbox e caçar a conversa à mão.
 * Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { encontrarContatoPorTelefone } from "@/lib/channels/contato-por-telefone";
import { ensureConversation, sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  telefone: z.string().trim().min(8).max(30),
  nome: z.string().trim().min(1).max(200).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Telefone inválido.", 422, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();
  const sessionId = await sessaoProntaParaEnvio(admin, auth.organization_id);
  if (!sessionId) {
    return fail("whatsapp_not_connected", "Nenhum WhatsApp conectado nesta clínica.", 409, { requestId });
  }

  let contatoId: string;
  const existente = await encontrarContatoPorTelefone(admin, auth.organization_id, parsed.data.telefone);
  if (existente) {
    contatoId = existente.id;
  } else {
    const { data: criado, error: insErr } = await admin
      .from("contacts")
      .insert({
        organization_id: auth.organization_id,
        name: parsed.data.nome ?? null,
        display_name: parsed.data.nome ?? null,
        phone_number: canonicalPhoneBR(parsed.data.telefone),
        source: "clinicfx",
      })
      .select("id")
      .single();
    if (insErr) return fail("internal_error", insErr.message, 500, { requestId });
    contatoId = criado.id as string;

    void audit({
      action: "contact.created",
      actorUserId: auth.created_by,
      actorApiTokenId: auth.api_token_id,
      organizationId: auth.organization_id,
      resourceType: "contact",
      resourceId: contatoId,
      requestId,
      metadata: { via: "clinicfx", source: "clinicfx" },
    });
  }

  const conversaId = await ensureConversation(admin, auth.organization_id, contatoId, sessionId);

  return ok({ contato_id: contatoId, conversa_id: conversaId }, { requestId });
}

/**
 * GET  /api/v1/crm/inbox/[id]/estagio — estágio atual do funil pra essa
 *      conversa. Cria o lead na hora (sempre na 1ª etapa) se o contato ainda
 *      não tinha um lead aberto — nenhuma conversa do WhatsApp passa pelo
 *      formulário manual de criar lead, então essa é a única forma de nascer.
 * POST /api/v1/crm/inbox/[id]/estagio — move o lead da conversa pra outra
 *      etapa (mesmo pipeline). Body: { stage_id }.
 * Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizePhoneForDisplay } from "@/lib/messaging/contact-card";
import { garantirLeadDoContato, garantirPipelinePadrao } from "@/lib/crm-clinica/funil-padrao";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function carregarContexto(admin: ReturnType<typeof createAdminClient>, organizationId: string, conversationId: string) {
  const { data: conversa, error: convErr } = await admin
    .from("conversations")
    .select("id, contact_id, contacts(name, display_name, phone_number)")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (convErr) throw new Error(convErr.message);
  if (!conversa) return null;

  const pipeline = await garantirPipelinePadrao(admin, organizationId);
  if (!pipeline) return null;

  const contato = conversa.contacts as unknown as { name: string | null; display_name: string | null; phone_number: string | null } | null;
  const titulo = contato?.display_name || contato?.name
    || (contato?.phone_number ? normalizePhoneForDisplay(contato.phone_number) : "Contato do WhatsApp");

  const lead = await garantirLeadDoContato(admin, organizationId, pipeline.id, conversa.contact_id, titulo);
  return lead ? { lead, pipelineId: pipeline.id } : null;
}

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });
  const { id } = await params;

  const admin = createAdminClient();
  try {
    const ctx = await carregarContexto(admin, auth.organization_id, id);
    if (!ctx) return fail("not_found", "Conversa não encontrada.", 404, { requestId });
    return ok({ lead_id: ctx.lead.id, stage_id: ctx.lead.stage_id }, { requestId });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "erro", 500, { requestId });
  }
}

const bodySchema = z.object({ stage_id: z.string().uuid() });

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });
  const { id } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return fail("validation_failed", "stage_id inválido.", 422, { requestId, details: parsed.error.flatten() });

  const admin = createAdminClient();
  try {
    const ctx = await carregarContexto(admin, auth.organization_id, id);
    if (!ctx) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

    const { data: etapa, error: etapaErr } = await admin
      .from("crm_stages")
      .select("id")
      .eq("id", parsed.data.stage_id)
      .eq("organization_id", auth.organization_id)
      .eq("pipeline_id", ctx.pipelineId)
      .maybeSingle();
    if (etapaErr) return fail("internal_error", etapaErr.message, 500, { requestId });
    if (!etapa) return fail("validation_failed", "Essa etapa não pertence ao funil desta clínica.", 422, { requestId });

    const { error: updErr } = await admin
      .from("crm_leads")
      .update({ stage_id: etapa.id, last_activity_at: new Date().toISOString() })
      .eq("id", ctx.lead.id)
      .eq("organization_id", auth.organization_id);
    if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

    return ok({ lead_id: ctx.lead.id, stage_id: etapa.id }, { requestId });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "erro", 500, { requestId });
  }
}

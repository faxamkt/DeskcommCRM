/**
 * POST /api/v1/crm/kanban/leads/:id/mover — move um lead pra outra etapa do
 * mesmo pipeline (Clinicfx: clique na etapa, no funil ou no painel da
 * conversa). Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bodySchema = z.object({ stage_id: z.string().uuid() });

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });
  const { id } = await params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return fail("validation_failed", "stage_id inválido.", 422, { requestId, details: parsed.error.flatten() });

  const admin = createAdminClient();

  const { data: lead, error: leadErr } = await admin
    .from("crm_leads")
    .select("id, pipeline_id")
    .eq("id", id)
    .eq("organization_id", auth.organization_id)
    .maybeSingle();
  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead) return fail("not_found", "Lead não encontrado.", 404, { requestId });

  const { data: etapa, error: etapaErr } = await admin
    .from("crm_stages")
    .select("id")
    .eq("id", parsed.data.stage_id)
    .eq("organization_id", auth.organization_id)
    .eq("pipeline_id", lead.pipeline_id)
    .maybeSingle();
  if (etapaErr) return fail("internal_error", etapaErr.message, 500, { requestId });
  if (!etapa) return fail("validation_failed", "Essa etapa não pertence ao funil deste lead.", 422, { requestId });

  const { error: updErr } = await admin
    .from("crm_leads")
    .update({ stage_id: etapa.id, last_activity_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", auth.organization_id);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  return ok({ id, stage_id: etapa.id }, { requestId });
}

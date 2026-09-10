/**
 * GET /api/v1/crm/kanban — kanban do pipeline padrão da org, pra integração
 * Clinicfx. Auth por `X-Api-Key` (`autenticarApiKey`, lib/tenant-auth.ts) —
 * `organization_id` sai do token, nunca de query/body. Service role
 * (`createAdminClient`) bypassa RLS; o filtro `organization_id` abaixo é o
 * que faz a vez da RLS aqui (doutrina: NÃO NEGOCIÁVEL).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface LeadRow {
  id: string;
  stage_id: string;
  last_activity_at: string | null;
  created_at: string;
  contacts: { name: string | null; display_name: string | null } | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const admin = createAdminClient();

  const { data: pipeline, error: pipelineErr } = await admin
    .from("crm_pipelines")
    .select("id, name")
    .eq("organization_id", auth.organization_id)
    .eq("is_archived", false)
    .order("is_default", { ascending: false })
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (pipelineErr) return fail("internal_error", pipelineErr.message, 500, { requestId });
  if (!pipeline) return ok({ colunas: [] }, { requestId });

  const { data: stages, error: stagesErr } = await admin
    .from("crm_stages")
    .select("id, name")
    .eq("organization_id", auth.organization_id)
    .eq("pipeline_id", pipeline.id)
    .eq("is_archived", false)
    .order("position", { ascending: true });
  if (stagesErr) return fail("internal_error", stagesErr.message, 500, { requestId });

  const { data: leads, error: leadsErr } = await admin
    .from("crm_leads")
    .select("id, stage_id, last_activity_at, created_at, contacts(name, display_name)")
    .eq("organization_id", auth.organization_id)
    .eq("pipeline_id", pipeline.id)
    .eq("status", "open")
    .order("position_in_stage", { ascending: true });
  if (leadsErr) return fail("internal_error", leadsErr.message, 500, { requestId });

  const leadsByStage = new Map<string, LeadRow[]>();
  for (const lead of (leads ?? []) as unknown as LeadRow[]) {
    const list = leadsByStage.get(lead.stage_id) ?? [];
    list.push(lead);
    leadsByStage.set(lead.stage_id, list);
  }

  const colunas = (stages ?? []).map((stage) => ({
    id: stage.id,
    nome: stage.name,
    cards: (leadsByStage.get(stage.id) ?? []).map((lead) => ({
      id: lead.id,
      nome_contato: lead.contacts?.display_name || lead.contacts?.name || null,
      etapa: stage.name,
      ultimo_contato: lead.last_activity_at ?? lead.created_at,
    })),
  }));

  return ok({ colunas }, { requestId });
}

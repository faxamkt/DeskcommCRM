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

/**
 * Etapas padrão de uma clínica (a integração Clinicfx é sempre esse domínio —
 * diferente do `fn_seed_default_pipeline_for_org` do banco, que semeia um
 * funil de e-commerce ("Pedidos"/"Carrinho abandonado") pensado pra outro
 * tipo de organização e não se aplica aqui).
 */
const ETAPAS_PADRAO_CLINICA = [
  { name: "Novo contato", slug: "novo-contato", is_won: false, is_lost: false },
  { name: "Em conversa", slug: "em-conversa", is_won: false, is_lost: false },
  { name: "Agendado", slug: "agendado", is_won: false, is_lost: false },
  { name: "Compareceu", slug: "compareceu", is_won: true, is_lost: false },
  { name: "Não veio / Perdido", slug: "perdido", is_won: false, is_lost: true },
] as const;

/**
 * Cria o funil padrão pra clínicas provisionadas via Clinicfx. `organizations`
 * tem um trigger (`fn_seed_default_pipeline_for_org`) que semeia pipeline em
 * todo INSERT — mas o vocabulário dele é de e-commerce, e depende do trigger
 * estar de fato aplicado nesta instalação (self-host: migrations não são
 * automáticas, `pnpm db:migrate` é um placeholder). Sem isso o Funil do
 * Clinicfx ficava permanentemente vazio pra qualquer tenant novo — daí o
 * seed aqui, específico do vocabulário de clínica e independente do trigger.
 */
async function seedPipelinePadrao(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<{ id: string; name: string } | null> {
  const { data: pipeline, error: pipelineErr } = await admin
    .from("crm_pipelines")
    .insert({ organization_id: organizationId, name: "Funil da clínica", slug: "funil-da-clinica", is_default: true, position: 1000 })
    .select("id, name")
    .single();
  if (pipelineErr || !pipeline) {
    console.error("[crm.kanban] seed do funil padrão falhou", pipelineErr?.message);
    return null;
  }

  const stagesInsert = ETAPAS_PADRAO_CLINICA.map((etapa, i) => ({
    organization_id: organizationId,
    pipeline_id: pipeline.id,
    name: etapa.name,
    slug: etapa.slug,
    position: (i + 1) * 1000,
    is_won: etapa.is_won,
    is_lost: etapa.is_lost,
  }));
  const { error: stagesErr } = await admin.from("crm_stages").insert(stagesInsert);
  if (stagesErr) {
    console.error("[crm.kanban] seed das etapas padrão falhou", stagesErr.message);
    return null;
  }

  return pipeline;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const admin = createAdminClient();

  const { data: pipelineExistente, error: pipelineErr } = await admin
    .from("crm_pipelines")
    .select("id, name")
    .eq("organization_id", auth.organization_id)
    .eq("is_archived", false)
    .order("is_default", { ascending: false })
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (pipelineErr) return fail("internal_error", pipelineErr.message, 500, { requestId });

  const pipeline = pipelineExistente ?? (await seedPipelinePadrao(admin, auth.organization_id));
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

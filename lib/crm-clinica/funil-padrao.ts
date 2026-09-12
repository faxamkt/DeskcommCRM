import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Etapas padrão de uma clínica (a integração Clinicfx é sempre esse domínio —
 * diferente do `fn_seed_default_pipeline_for_org` do banco, que semeia um
 * funil de e-commerce ("Pedidos"/"Carrinho abandonado") pensado pra outro
 * tipo de organização e não se aplica aqui).
 */
export const ETAPAS_PADRAO_CLINICA = [
  { name: "Novo contato", slug: "novo-contato", is_won: false, is_lost: false },
  { name: "Fechando", slug: "fechando", is_won: false, is_lost: false },
  { name: "Agendado", slug: "agendado", is_won: false, is_lost: false },
  { name: "Paciente", slug: "paciente", is_won: true, is_lost: false },
  { name: "Retorno", slug: "retorno", is_won: false, is_lost: false },
] as const;

/**
 * Pipeline padrão da org — cria com as etapas de clínica na primeira chamada.
 * Reusado por toda rota que precisa "o funil desta clínica" (kanban, estágio
 * de uma conversa, gestão de etapas): nenhuma delas pode presumir que o
 * pipeline já existe.
 */
export async function garantirPipelinePadrao(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<{ id: string; name: string } | null> {
  const { data: existente, error: existenteErr } = await admin
    .from("crm_pipelines")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("is_archived", false)
    .order("is_default", { ascending: false })
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existenteErr) {
    console.error("[funil-padrao] leitura do pipeline falhou", existenteErr.message);
    return null;
  }
  if (existente) return existente;

  const { data: pipeline, error: pipelineErr } = await admin
    .from("crm_pipelines")
    .insert({ organization_id: organizationId, name: "Funil da clínica", slug: "funil-da-clinica", is_default: true, position: 1000 })
    .select("id, name")
    .single();
  if (pipelineErr || !pipeline) {
    console.error("[funil-padrao] seed do funil falhou", pipelineErr?.message);
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
    console.error("[funil-padrao] seed das etapas falhou", stagesErr.message);
    return null;
  }

  return pipeline;
}

/**
 * O lead "vivo" de um contato no funil padrão — cria na primeira vez que a
 * conversa precisa de um estágio, sempre na primeira etapa (doutrina: toda
 * conversa nasce "Novo contato"). Reaproveita um lead aberto existente do
 * mesmo contato em vez de duplicar.
 */
export async function garantirLeadDoContato(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  pipelineId: string,
  contactId: string,
  tituloFallback: string,
): Promise<{ id: string; stage_id: string } | null> {
  const { data: existente, error: existenteErr } = await admin
    .from("crm_leads")
    .select("id, stage_id")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", pipelineId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existenteErr) {
    console.error("[funil-padrao] leitura do lead falhou", existenteErr.message);
    return null;
  }
  if (existente) return existente;

  const { data: primeiraEtapa, error: etapaErr } = await admin
    .from("crm_stages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", pipelineId)
    .eq("is_archived", false)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (etapaErr || !primeiraEtapa) {
    console.error("[funil-padrao] sem etapa inicial", etapaErr?.message);
    return null;
  }

  const { data: criado, error: criarErr } = await admin
    .from("crm_leads")
    .insert({
      organization_id: organizationId,
      pipeline_id: pipelineId,
      stage_id: primeiraEtapa.id,
      contact_id: contactId,
      title: tituloFallback,
      source: "whatsapp",
    })
    .select("id, stage_id")
    .single();
  if (criarErr || !criado) {
    console.error("[funil-padrao] criação do lead falhou", criarErr?.message);
    return null;
  }
  return criado;
}

/**
 * POST /api/v1/crm/agents/create — cria e publica um agente de IA básico pra
 * clínica (integração Clinicfx). Pensado pro botão "Criar Agente de IA" da
 * tela — sem passar pelo construtor avançado (prompt/guardrails/versões
 * continuam lá).
 *
 * Pré-requisitos (retornam 409 com mensagem clara se faltarem):
 *  - WhatsApp conectado e no estado WORKING (`loadPrimaryChannelSession`) —
 *    `ai_agent_versions.channel_session_id` é NOT NULL e o publish exige a
 *    sessão saudável (fn_publish_ai_agent_version).
 *  - Um modelo ativo cadastrado em `ai_models` pro provider escolhido — o
 *    catálogo é sincronizado por cron; sem isso o publish rejeita com
 *    `model_not_found`.
 *
 * Credencial: usa a chave de PLATAFORMA (env ANTHROPIC_API_KEY desta
 * instalação, nunca uma chave da clínica) — mesmo caminho que
 * `publishAgentVersion` já valida (`chaveDePlataforma`). custo do modelo cai
 * na instalação, não na clínica — é o comportamento aceito aqui de propósito.
 *
 * Idempotente: se a org já tem um agente não arquivado, devolve ele (sem
 * duplicar) em vez de criar outro.
 *
 * Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadPrimaryChannelSession } from "@/lib/channels/primary-session";
import { STATUS_SAUDAVEL } from "@/lib/channels/health";
import { chaveDePlataforma } from "@/lib/ai/runtime/agent";
import { publishAgentVersion } from "@/lib/ai/agents/publish";

export const dynamic = "force-dynamic";

const PROVIDER = "anthropic" as const;

const DEFAULT_PROMPT =
  "Você é a assistente virtual de atendimento desta clínica pelo WhatsApp. " +
  "Seja simpática, objetiva e profissional. Ajude a esclarecer dúvidas sobre " +
  "procedimentos, horários e agendamento, e sempre que o paciente pedir para " +
  "falar com uma pessoa, ou o assunto exigir avaliação clínica, direcione o " +
  "atendimento para a equipe humana.";

const bodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  system_prompt: z.string().trim().min(1).max(8000).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch { /* body opcional */ }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();

  // Idempotência: já existe um agente vivo pra essa org.
  const { data: existente, error: existenteErr } = await admin
    .from("ai_agents")
    .select("id, name, published_version_id, paused_at")
    .eq("organization_id", auth.organization_id)
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existenteErr) return fail("internal_error", existenteErr.message, 500, { requestId });
  if (existente) {
    return ok(
      { id: existente.id, nome: existente.name, ativo: Boolean(existente.published_version_id) && !existente.paused_at, ja_existia: true },
      { requestId },
    );
  }

  const channel = await loadPrimaryChannelSession(admin, auth.organization_id).catch((err) => {
    console.error("[crm.agents.create] falha ao carregar canal", err);
    return null;
  });
  if (!channel) {
    return fail("resource_not_found", "Conecte o WhatsApp antes de criar o agente de IA.", 409, { requestId });
  }
  if (channel.status !== STATUS_SAUDAVEL) {
    return fail("state_conflict", "O WhatsApp ainda não está totalmente conectado — finalize a conexão antes de criar o agente.", 409, { requestId });
  }

  if (!chaveDePlataforma(PROVIDER)) {
    return fail("nao_configurado", "Esta instalação não tem uma chave de IA configurada.", 503, { requestId });
  }

  const { data: modelo, error: modeloErr } = await admin
    .from("ai_models")
    .select("model_id")
    .eq("provider", PROVIDER)
    .is("deprecated_at", null)
    .order("model_id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (modeloErr) return fail("internal_error", modeloErr.message, 500, { requestId });
  if (!modelo) {
    return fail("nao_configurado", "Nenhum modelo de IA disponível nesta instalação ainda.", 503, { requestId });
  }

  const nome = parsed.data.name?.trim() || "Atendimento IA";
  const prompt = parsed.data.system_prompt?.trim() || DEFAULT_PROMPT;

  const { data: agent, error: agentErr } = await admin
    .from("ai_agents")
    .insert({
      organization_id: auth.organization_id,
      name: nome,
      kind: "mcp_agent",
      system_prompt: prompt,
      created_by: auth.created_by,
    })
    .select("id, name")
    .single();
  if (agentErr || !agent) return fail("internal_error", agentErr?.message ?? "agent_insert_failed", 500, { requestId });

  const { data: version, error: versionErr } = await admin
    .from("ai_agent_versions")
    .insert({
      organization_id: auth.organization_id,
      agent_id: agent.id,
      version_number: 1,
      system_prompt: prompt,
      provider: PROVIDER,
      model: modelo.model_id,
      credential_id: null,
      channel_session_id: channel.id,
      status: "draft",
      created_by: auth.created_by,
    })
    .select("id")
    .single();
  if (versionErr || !version) return fail("internal_error", versionErr?.message ?? "version_insert_failed", 500, { requestId });

  const publish = await publishAgentVersion(admin, { orgId: auth.organization_id, agentId: agent.id, versionId: version.id });
  if (!publish.ok) {
    return fail(publish.code, `Agente criado, mas não foi possível publicar: ${publish.message}`, 422, { requestId });
  }

  void audit({
    action: "ai_agent.created",
    actorUserId: auth.created_by,
    actorApiTokenId: auth.api_token_id,
    organizationId: auth.organization_id,
    resourceType: "ai_agent",
    resourceId: agent.id,
    requestId,
    metadata: { via: "clinicfx", provider: PROVIDER, model: modelo.model_id },
  });

  return ok({ id: agent.id, nome: agent.name, ativo: true, ja_existia: false }, { requestId, status: 201 });
}

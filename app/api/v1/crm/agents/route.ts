/**
 * GET /api/v1/crm/agents — lista os agentes de IA da org (integração Clinicfx).
 * Visão resumida: nome, tipo, se está publicado/pausado e o modelo em vigor.
 * Edição fina (prompt, guardrails, versionamento) fica fora desta API —
 * continua exclusiva do painel avançado na VPS.
 *
 * Auth por `X-Api-Key` (`autenticarApiKey`, lib/tenant-auth.ts).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const AGENT_COLUMNS_COM_VERSAO =
  "id, name, kind, priority, published_version_id, paused_at, archived_at, created_at," +
  " versao_publicada:ai_agent_versions!ai_agents_published_version_id_fkey(provider, model)";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_agents")
    .select(AGENT_COLUMNS_COM_VERSAO)
    .eq("organization_id", auth.organization_id)
    .is("archived_at", null)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const agentes = (data ?? []).map((a) => ({
    id: a.id,
    nome: a.name,
    tipo: a.kind,
    ativo: Boolean(a.published_version_id) && !a.paused_at,
    pausado_em: a.paused_at,
    modelo: (a.versao_publicada as { provider?: string; model?: string } | null)?.model ?? null,
    provedor: (a.versao_publicada as { provider?: string; model?: string } | null)?.provider ?? null,
  }));

  return ok({ agentes }, { requestId });
}

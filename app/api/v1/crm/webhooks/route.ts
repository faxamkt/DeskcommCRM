/**
 * GET  /api/v1/crm/webhooks — lista as entradas automáticas de contatos
 *      (webhook_sources) da org (integração Clinicfx).
 * POST /api/v1/crm/webhooks — cria uma nova entrada apontando pro funil
 *      padrão da org (1ª etapa do funil padrão) — escolher outro funil/etapa
 *      continua exclusivo do painel avançado na VPS.
 *
 * Reaproveita `lib/operacao/entradas-automaticas.ts` (mesma regra da tela e
 * do agente de IA, BRIEFING §3 Decisão 4) — aqui só resolve auth + destino
 * padrão. Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import type { Actor } from "@/lib/api/handlers/types";
import { fail, ok } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { criarEntradaAutomatica, listarEntradasAutomaticas } from "@/lib/operacao/entradas-automaticas";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

function actorDoToken(auth: { created_by: string | null; role: string; api_token_id: string }): Actor {
  return auth.created_by
    ? { type: "user", id: auth.created_by, role: auth.role }
    : { type: "webhook_source", id: auth.api_token_id };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const admin = createAdminClient();
  try {
    const fontes = await listarEntradasAutomaticas({
      supabase: admin,
      organizationId: auth.organization_id,
      actor: actorDoToken(auth),
      requestId,
    });
    return ok({ webhooks: fontes }, { requestId });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { details: err.details, requestId });
    return fail("internal_error", err instanceof Error ? err.message : "erro desconhecido", 500, { requestId });
  }
}

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
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();

  const { data: pipeline, error: pipelineErr } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", auth.organization_id)
    .eq("is_archived", false)
    .order("is_default", { ascending: false })
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (pipelineErr) return fail("internal_error", pipelineErr.message, 500, { requestId });
  if (!pipeline) return fail("resource_not_found", "Nenhum funil configurado nesta organização.", 404, { requestId });

  const { data: stage, error: stageErr } = await admin
    .from("crm_stages")
    .select("id")
    .eq("organization_id", auth.organization_id)
    .eq("pipeline_id", pipeline.id)
    .eq("is_archived", false)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (stageErr) return fail("internal_error", stageErr.message, 500, { requestId });
  if (!stage) return fail("resource_not_found", "O funil padrão não tem etapas.", 404, { requestId });

  try {
    const fonte = await criarEntradaAutomatica(
      { supabase: admin, organizationId: auth.organization_id, actor: actorDoToken(auth), requestId },
      { name: parsed.data.name, default_pipeline_id: pipeline.id, default_stage_id: stage.id },
    );
    return ok(fonte, { requestId, status: 201 });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { details: err.details, requestId });
    return fail("internal_error", err instanceof Error ? err.message : "erro desconhecido", 500, { requestId });
  }
}

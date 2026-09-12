/**
 * POST /api/v1/crm/agents/:id/pause — pausa um agente de IA (integração
 * Clinicfx). Mesma semântica de /api/v1/ai/agents/:id/pause (Spec 10 §4.3):
 * só marca `paused_at` — `published_version_id` continua intacto, é o que
 * permite o /resume (irmão desta rota) religar o agente sem repassar pela
 * validação de publish. Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("ai_agents")
    .select("id, published_version_id, archived_at, paused_at")
    .eq("id", id)
    .eq("organization_id", auth.organization_id)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", "Agente não encontrado.", 404, { requestId });
  if (existing.archived_at) return fail("state_conflict", "Agente arquivado.", 409, { requestId });
  if (existing.paused_at) return ok({ id, paused_at: existing.paused_at }, { requestId });

  const previousVersionId = existing.published_version_id as string | null;
  const now = new Date().toISOString();

  const { error: updErr } = await admin
    .from("ai_agents")
    .update({ paused_at: now, updated_at: now })
    .eq("id", id)
    .eq("organization_id", auth.organization_id);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "ai_agent.paused",
    actorUserId: auth.created_by,
    actorApiTokenId: auth.api_token_id,
    organizationId: auth.organization_id,
    resourceType: "ai_agent",
    resourceId: id,
    requestId,
    metadata: { previous_version_id: previousVersionId, via: "clinicfx" },
  });

  return ok({ id, published_version_id: previousVersionId, paused_at: now }, { requestId });
}

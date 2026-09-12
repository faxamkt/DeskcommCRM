/**
 * POST /api/v1/crm/routers/:id/toggle — liga/desliga um roteador de intenção
 * (integração Clinicfx). Body: { is_active: boolean }. Flip simples do mesmo
 * campo do PATCH /api/v1/ai/routers/:id — não mexe em membros/config.
 * Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bodySchema = z.object({ is_active: z.boolean() });

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("ai_routers")
    .select("id, is_active")
    .eq("id", id)
    .eq("organization_id", auth.organization_id)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", "Roteador não encontrado.", 404, { requestId });

  if (existing.is_active === parsed.data.is_active) {
    return ok({ id, is_active: existing.is_active }, { requestId });
  }

  const { error: updErr } = await admin
    .from("ai_routers")
    .update({ is_active: parsed.data.is_active, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", auth.organization_id);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "ai.router_updated",
    actorUserId: auth.created_by,
    actorApiTokenId: auth.api_token_id,
    organizationId: auth.organization_id,
    resourceType: "ai_router",
    resourceId: id,
    requestId,
    metadata: { field: "is_active", value: parsed.data.is_active, via: "clinicfx" },
  });

  return ok({ id, is_active: parsed.data.is_active }, { requestId });
}

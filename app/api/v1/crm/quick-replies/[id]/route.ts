/**
 * DELETE /api/v1/crm/quick-replies/:id — remove uma resposta rápida
 * compartilhada da org (integração Clinicfx). Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, noContent } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("message_templates")
    .select("id")
    .eq("id", id)
    .eq("organization_id", auth.organization_id)
    .is("owner_user_id", null)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", "Resposta rápida não encontrada.", 404, { requestId });

  const { error } = await admin
    .from("message_templates")
    .delete()
    .eq("id", id)
    .eq("organization_id", auth.organization_id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "template.deleted",
    actorUserId: auth.created_by,
    actorApiTokenId: auth.api_token_id,
    organizationId: auth.organization_id,
    resourceType: "message_template",
    resourceId: id,
    requestId,
    metadata: { via: "clinicfx" },
  });

  return noContent(requestId);
}

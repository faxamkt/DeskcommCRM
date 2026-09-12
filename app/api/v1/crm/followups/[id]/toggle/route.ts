/**
 * POST /api/v1/crm/followups/:id/toggle — liga/desliga um fluxo de follow-up
 * (integração Clinicfx). Body: { enable: boolean }.
 *
 * Desligar é sempre seguro: só troca `status` para 'disabled', igual
 * /api/v1/ai/followup-flows/:id/disable. Ligar de volta só é permitido se o
 * fluxo já tem `active_version_id` (foi publicado alguma vez pelo painel
 * avançado) — sem isso reativar não teria o que rodar, e a criação/edição do
 * grafo continua fora desta API. Auth por `X-Api-Key`.
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
const bodySchema = z.object({ enable: z.boolean() });

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
    .from("followup_flow_pointers")
    .select("id, status, active_version_id")
    .eq("id", id)
    .eq("organization_id", auth.organization_id)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", "Fluxo não encontrado.", 404, { requestId });

  const targetStatus = parsed.data.enable ? "active" : "disabled";
  if (existing.status === targetStatus) return ok({ id, status: targetStatus }, { requestId });

  if (parsed.data.enable && !existing.active_version_id) {
    return fail(
      "state_conflict",
      "Este fluxo ainda não foi publicado — publique uma versão no painel avançado antes de ativar.",
      409,
      { requestId },
    );
  }

  const { data: updated, error: updErr } = await admin
    .from("followup_flow_pointers")
    .update({ status: targetStatus, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", auth.organization_id)
    .select("id, status, updated_at")
    .single();
  if (updErr || !updated) return fail("internal_error", updErr?.message ?? "toggle_failed", 500, { requestId });

  void audit({
    action: parsed.data.enable ? "followup_flow.updated" : "followup_flow.disabled",
    actorUserId: auth.created_by,
    actorApiTokenId: auth.api_token_id,
    organizationId: auth.organization_id,
    resourceType: "followup_flow_pointer",
    resourceId: id,
    requestId,
    metadata: { status: targetStatus, via: "clinicfx" },
  });

  return ok(updated, { requestId });
}

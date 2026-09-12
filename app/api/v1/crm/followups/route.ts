/**
 * GET /api/v1/crm/followups — lista os fluxos de follow-up da org + tamanho
 * da fila viva (integração Clinicfx). Editor de fluxo (nós, condições) fica
 * fora desta API — continua exclusivo do painel avançado na VPS.
 *
 * Auth por `X-Api-Key` (`autenticarApiKey`, lib/tenant-auth.ts).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const LIST_COLUMNS = "id, name, status, active_version_id, updated_at";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const admin = createAdminClient();

  const { data: flows, error: flowsErr } = await admin
    .from("followup_flow_pointers")
    .select(LIST_COLUMNS)
    .eq("organization_id", auth.organization_id)
    .order("updated_at", { ascending: false });
  if (flowsErr) return fail("internal_error", flowsErr.message, 500, { requestId });

  const { count: naFila, error: filaErr } = await admin
    .from("followup_enrollments")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", auth.organization_id)
    .in("status", ["active", "waiting_reply"]);
  if (filaErr) return fail("internal_error", filaErr.message, 500, { requestId });

  const fluxos = (flows ?? []).map((f) => ({
    id: f.id,
    nome: f.name,
    status: f.status,
    pode_ativar: Boolean(f.active_version_id),
    atualizado_em: f.updated_at,
  }));

  return ok({ fluxos, fila: { na_fila: naFila ?? 0 } }, { requestId });
}

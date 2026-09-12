/**
 * GET /api/v1/crm/routers — lista os roteadores de intenção da org, com
 * contagem de membros (integração Clinicfx). Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const ROUTER_LIST_COLUMNS = "id, name, channel_session_id, is_active, fallback_agent_id, updated_at";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const admin = createAdminClient();

  const { data: routers, error: routersErr } = await admin
    .from("ai_routers")
    .select(ROUTER_LIST_COLUMNS)
    .eq("organization_id", auth.organization_id)
    .order("created_at", { ascending: false });
  if (routersErr) return fail("internal_error", routersErr.message, 500, { requestId });

  const { data: memberRows, error: membersErr } = await admin
    .from("ai_router_members")
    .select("router_id")
    .eq("organization_id", auth.organization_id);
  if (membersErr) return fail("internal_error", membersErr.message, 500, { requestId });

  const counts = new Map<string, number>();
  for (const m of (memberRows ?? []) as Array<{ router_id: string }>) {
    counts.set(m.router_id, (counts.get(m.router_id) ?? 0) + 1);
  }

  const roteadores = (routers ?? []).map((r) => ({ ...r, member_count: counts.get(r.id) ?? 0 }));

  return ok({ roteadores }, { requestId });
}

/**
 * POST /api/v1/crm/inbox/[id]/marcar-lida — zera unread_count_for_assignee.
 * Reusa `markConversationReadHandler` (app/api/v1/conversations/_handler.ts),
 * o mesmo usado pelo inbox interno — só troca a auth de sessão por
 * `X-Api-Key` de tenant, igual ao resto das rotas /crm/*. O Clinicfx chama
 * isto ao abrir uma conversa, pra a bolinha de não lida sumir da lista.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/types";
import { markConversationReadHandler } from "@/app/api/v1/conversations/_handler";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });
  const { id } = await params;

  const admin = createAdminClient();
  try {
    const conv = await markConversationReadHandler(
      admin,
      {
        organization_id: auth.organization_id,
        actor: { type: "ai_agent", id: auth.api_token_id, role: auth.role, api_token_id: auth.api_token_id },
        requestId,
      },
      id,
    );
    return ok({ id: conv.id, unread_count: 0 }, { requestId });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    throw err;
  }
}

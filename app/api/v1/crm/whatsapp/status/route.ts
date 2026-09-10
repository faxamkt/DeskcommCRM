/**
 * GET /api/v1/crm/whatsapp/status — status da sessão WAHA da org, pra
 * integração Clinicfx. Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { STATUS_SAUDAVEL } from "@/lib/channels/health";
import { loadPrimaryChannelSession } from "@/lib/channels/primary-session";
import { createAdminClient } from "@/lib/supabase/admin";
import { autenticarApiKey } from "@/lib/tenant-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const admin = createAdminClient();
  let channel;
  try {
    channel = await loadPrimaryChannelSession(admin, auth.organization_id);
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "erro", 500, { requestId });
  }

  if (!channel) return ok({ conectado: false }, { requestId });
  return ok(
    { conectado: channel.status === STATUS_SAUDAVEL, numero: channel.phone_number ?? undefined },
    { requestId },
  );
}

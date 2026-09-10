/**
 * GET /api/v1/crm/whatsapp/qr — QR code da sessão WAHA da org, pra integração
 * Clinicfx exibir na própria UI (por isso base64 em JSON, e não bytes de
 * imagem como o proxy de onboarding — `app/api/v1/onboarding/whatsapp/qr/route.ts`,
 * de onde vem a chamada ao WAHA abaixo). Auth por `X-Api-Key`.
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
  if (!channel) return fail("resource_not_found", "Nenhum canal WhatsApp conectado.", 404, { requestId });
  if (channel.status === STATUS_SAUDAVEL) return ok({ conectado: true }, { requestId });

  const baseUrl = process.env.WAHA_API_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  if (!baseUrl || !apiKey || apiKey === "dev_plaintext_change_me") {
    return fail("nao_configurado", "WAHA não configurado nesta instalação.", 503, { requestId });
  }

  const upstream = await fetch(
    `${baseUrl}/api/${encodeURIComponent(channel.waha_session_name)}/auth/qr?format=image`,
    { headers: { "X-Api-Key": apiKey }, cache: "no-store" },
  );
  if (!upstream.ok) {
    return fail("resposta_inesperada", "WAHA não devolveu o QR code.", 502, { requestId });
  }

  const buf = await upstream.arrayBuffer();
  return ok({ qr_base64: Buffer.from(buf).toString("base64") }, { requestId });
}

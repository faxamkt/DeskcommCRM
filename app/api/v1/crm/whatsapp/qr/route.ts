/**
 * GET /api/v1/crm/whatsapp/qr — QR code da sessão WAHA da org, pra integração
 * Clinicfx exibir na própria UI (por isso base64 em JSON, e não bytes de
 * imagem como o proxy de onboarding — `app/api/v1/onboarding/whatsapp/qr/route.ts`,
 * de onde vem a chamada ao WAHA abaixo). Auth por `X-Api-Key`.
 *
 * Self-healing: uma clínica provisionada via Clinicfx nunca passou pelo
 * onboarding do Deskcomm (não tem login lá), então nunca ganhou um canal
 * WhatsApp — `fn_reserve_channel_connection` (usado por
 * `/api/v1/onboarding/whatsapp/session`) exige `auth.uid()` de sessão de
 * cookie e não serve aqui. Por isso esta rota cria o `channel_sessions` e
 * inicia a sessão remota na PRIMEIRA chamada sem canal, em vez de devolver
 * 404 pra sempre — mesma lógica de `/api/v1/crm/kanban` pro funil.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { STATUS_SAUDAVEL } from "@/lib/channels/health";
import { loadPrimaryChannelSession, type PrimaryChannelSession } from "@/lib/channels/primary-session";
import { createAdminClient } from "@/lib/supabase/admin";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { getWahaClient } from "@/lib/waha/client";

export const dynamic = "force-dynamic";

async function garantirCanalWhatsapp(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<PrimaryChannelSession | null> {
  const existente = await loadPrimaryChannelSession(admin, organizationId);
  if (existente) return existente;

  const waha = getWahaClient();
  if (!waha) return null; // sem WAHA configurado, nem tenta — a rota já trata isso a seguir

  // WAHA rejeita (400) nomes de sessão longos — medido nesta instalação: 50
  // chars passa, 55 já não. "org_" + uuid sem hífen (32) = 36 chars, com
  // folga. Um org só tem um canal "primário" aqui (é o que `garantirCanalWhatsapp`
  // garante), então não precisa de sufixo aleatório pra unicidade.
  const sessionName = `org_${organizationId.replace(/-/g, "")}`;
  const { data: created, error: insertErr } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: organizationId,
      waha_session_name: sessionName,
      engine: "NOWEB",
      // Mesmo placeholder que fn_reserve_channel_connection usa pro fluxo de
      // onboarding — o segredo real do webhook não é usado por este caminho.
      webhook_secret_encrypted: "\\x00",
      status: "STARTING",
      metadata: { onboarding: true, provisioned_via: "clinicfx" },
    })
    .select("id, status, phone_number, waha_session_name")
    .single();
  if (insertErr || !created) {
    throw new Error(`falha ao criar o canal do WhatsApp: ${insertErr?.message ?? "insert sem retorno"}`);
  }

  try {
    await waha.createSession(sessionName);
    const remote = await waha.startExistingSession(sessionName);
    const { data: updated } = await admin
      .from("channel_sessions")
      .update({ status: remote.status, last_status_change_at: new Date().toISOString() })
      .eq("id", created.id)
      .select("id, status, phone_number, waha_session_name")
      .single();
    return (updated ?? created) as PrimaryChannelSession;
  } catch (err) {
    await admin.from("channel_sessions").update({ status: "FAILED", status_reason: "connection_repair_required" }).eq("id", created.id);
    throw new Error(`falha ao iniciar a sessão do WhatsApp: ${err instanceof Error ? err.message : "erro desconhecido"}`);
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const admin = createAdminClient();
  let channel: PrimaryChannelSession | null;
  try {
    channel = await garantirCanalWhatsapp(admin, auth.organization_id);
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "erro", 500, { requestId });
  }
  if (!channel) return fail("nao_configurado", "WAHA não configurado nesta instalação.", 503, { requestId });
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

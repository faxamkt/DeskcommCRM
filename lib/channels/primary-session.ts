import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "./archived";

export interface PrimaryChannelSession {
  id: string;
  status: string;
  phone_number: string | null;
  waha_session_name: string;
}

const COLUNAS = "id, status, phone_number, waha_session_name";

/**
 * O canal (mais antigo, ativo) da organização — pra caminhos que precisam do
 * `waha_session_name` interno pra falar com o transporte (ex.: proxy de QR),
 * diferente de `listSelectableChannels` (que devolve vários e omite o nome
 * interno de propósito, porque é pra UI). `db` aceita client de usuário ou
 * admin; quem chama com admin é responsável pelo `organization_id`.
 */
export async function loadPrimaryChannelSession(
  db: SupabaseClient,
  organizationId: string,
): Promise<PrimaryChannelSession | null> {
  const base = () => db.from("channel_sessions").select(COLUNAS).eq("organization_id", organizationId);

  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).order("created_at", { ascending: true }).limit(1).maybeSingle(),
    () => base().order("created_at", { ascending: true }).limit(1).maybeSingle(),
  );
  if (error) throw new Error(`channel_sessions_primary_failed: ${error.message ?? "unknown"}`);
  return (data as PrimaryChannelSession | null) ?? null;
}

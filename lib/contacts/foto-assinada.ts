import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Assina em lote as fotos de contato pra devolver JÁ NA RESPOSTA da API
 * (integração Clinicfx). O bucket `whatsapp-media` é privado — mesma regra
 * de `/api/v1/contacts/[id]/avatar` (redirect com URL assinada) — mas um
 * `<img src>` não manda `X-Api-Key`, então essa rota não pode exigir auth
 * por header pra servir a imagem. Assinar aqui, dentro de uma rota que JÁ
 * validou a API key, resolve isso sem expor o bucket nem pedir chave na URL.
 *
 * TTL curto (mesmo motivo do endpoint de cookie): se vazar, expira sozinha —
 * inbox/kanban reconsultam a cada poll e recebem URL nova.
 */
const SIGNED_TTL_SECONDS = 300;

export async function assinarFotosDeContatos(
  admin: SupabaseClient,
  paths: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unicos = [...new Set(paths.filter((p): p is string => Boolean(p)))];
  if (unicos.length === 0) return new Map();

  const { data, error } = await admin.storage
    .from("whatsapp-media")
    .createSignedUrls(unicos, SIGNED_TTL_SECONDS);
  if (error || !data) return new Map();

  const mapa = new Map<string, string>();
  for (const item of data) {
    if (item.signedUrl && !item.error) mapa.set(item.path ?? "", item.signedUrl);
  }
  return mapa;
}

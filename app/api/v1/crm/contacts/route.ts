/**
 * GET /api/v1/crm/contacts — lista os contatos da org pra tela "Contatos" do
 * Clinicfx (nome, telefone, foto, e a conversa aberta correspondente — pra
 * cair direto no WhatsApp). Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { assinarFotosDeContatos } from "@/lib/contacts/foto-assinada";
import { normalizePhoneForDisplay } from "@/lib/messaging/contact-card";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const querySchema = z.object({ page: z.coerce.number().int().min(1).default(1) });

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) return fail("validation_error", "page inválido.", 400, { requestId });
  const from = (parsed.data.page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const admin = createAdminClient();
  const { data: contatos, error } = await admin
    .from("contacts")
    .select("id, name, display_name, phone_number, avatar_storage_path, is_anonymized")
    .eq("organization_id", auth.organization_id)
    .eq("is_anonymized", false)
    .order("display_name", { ascending: true, nullsFirst: false })
    .range(from, to);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const ids = (contatos ?? []).map((c) => c.id);
  const conversaPorContato = new Map<string, string>();
  if (ids.length > 0) {
    const { data: conversas } = await admin
      .from("conversations")
      .select("id, contact_id")
      .eq("organization_id", auth.organization_id)
      .in("contact_id", ids)
      .order("last_message_at", { ascending: false, nullsFirst: false });
    for (const c of conversas ?? []) {
      if (!conversaPorContato.has(c.contact_id)) conversaPorContato.set(c.contact_id, c.id);
    }
  }

  const fotos = await assinarFotosDeContatos(admin, (contatos ?? []).map((c) => c.avatar_storage_path));

  const lista = (contatos ?? []).map((c) => ({
    id: c.id,
    nome: c.display_name || c.name || (c.phone_number ? normalizePhoneForDisplay(c.phone_number) : "Sem nome"),
    telefone: c.phone_number ? normalizePhoneForDisplay(c.phone_number) : null,
    foto_url: c.avatar_storage_path ? fotos.get(c.avatar_storage_path) ?? null : null,
    conversa_id: conversaPorContato.get(c.id) ?? null,
  }));

  return ok({ contatos: lista }, { requestId });
}

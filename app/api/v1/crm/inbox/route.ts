/**
 * GET /api/v1/crm/inbox — lista conversas da org, paginado por página (não
 * cursor — contrato pedido pela integração Clinicfx, diferente do resto da
 * API). Auth por `X-Api-Key`, `organization_id` do token.
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

const PAGE_SIZE = 20;

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
});

interface ConversationRow {
  id: string;
  status: string;
  last_message_preview: string | null;
  last_message_at: string | null;
  created_at: string;
  contacts: {
    name: string | null;
    display_name: string | null;
    phone_number: string | null;
    avatar_storage_path: string | null;
    is_anonymized: boolean | null;
  } | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return fail("validation_error", "page inválido.", 400, { requestId });
  }
  const { page } = parsed.data;
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("conversations")
    .select("id, status, last_message_preview, last_message_at, created_at, contacts(name, display_name, phone_number, avatar_storage_path, is_anonymized)")
    .eq("organization_id", auth.organization_id)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .range(from, to);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const linhas = (data ?? []) as unknown as ConversationRow[];
  const fotos = await assinarFotosDeContatos(
    admin,
    linhas.map((c) => (c.contacts?.is_anonymized ? null : c.contacts?.avatar_storage_path)),
  );

  const conversas = linhas.map((c) => ({
    id: c.id,
    nome_contato: c.contacts?.display_name || c.contacts?.name
      || (c.contacts?.phone_number ? normalizePhoneForDisplay(c.contacts.phone_number) : null),
    foto_url: c.contacts?.avatar_storage_path && !c.contacts.is_anonymized
      ? fotos.get(c.contacts.avatar_storage_path) ?? null
      : null,
    ultima_mensagem: c.last_message_preview,
    timestamp: c.last_message_at ?? c.created_at,
    status: c.status,
  }));

  return ok({ conversas }, { requestId });
}

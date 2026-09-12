/**
 * GET/POST /api/v1/crm/inbox/[id]/notas — notas internas da conversa (nunca
 * vão pro WhatsApp — mesma tabela `conversation_notes` do painel avançado,
 * `/api/v1/conversations/[id]/notes`). Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ conteudo: z.string().trim().min(1).max(4000) });

async function conversaExiste(admin: ReturnType<typeof createAdminClient>, organizationId: string, id: string) {
  const { data } = await admin.from("conversations").select("id").eq("id", id).eq("organization_id", organizationId).maybeSingle();
  return Boolean(data);
}

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });
  const { id } = await params;

  const admin = createAdminClient();
  if (!(await conversaExiste(admin, auth.organization_id, id))) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  const { data, error } = await admin
    .from("conversation_notes")
    .select("id, body, created_by_name, created_at")
    .eq("conversation_id", id)
    .eq("organization_id", auth.organization_id)
    .order("created_at", { ascending: true });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const notas = (data ?? []).map((n) => ({ id: n.id, conteudo: n.body, autor: n.created_by_name, criado_em: n.created_at }));
  return ok({ notas }, { requestId });
}

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });
  const { id } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return fail("validation_failed", "conteudo é obrigatório.", 422, { requestId, details: parsed.error.flatten() });

  const admin = createAdminClient();
  if (!(await conversaExiste(admin, auth.organization_id, id))) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  const { data: nota, error } = await admin
    .from("conversation_notes")
    .insert({
      organization_id: auth.organization_id,
      conversation_id: id,
      body: parsed.data.conteudo,
      created_by_user_id: auth.created_by,
      created_by_name: "Equipe (Clinicfx)",
    })
    .select("id, body, created_by_name, created_at")
    .single();
  if (error || !nota) return fail("internal_error", error?.message ?? "note_insert_failed", 500, { requestId });

  return ok({ id: nota.id, conteudo: nota.body, autor: nota.created_by_name, criado_em: nota.created_at }, { requestId, status: 201 });
}

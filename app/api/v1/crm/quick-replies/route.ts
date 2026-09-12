/**
 * GET  /api/v1/crm/quick-replies — lista as respostas rápidas COMPARTILHADAS
 *      da org (integração Clinicfx). Templates pessoais (owner_user_id != null)
 *      ficam de fora: a chave do tenant não representa uma pessoa específica
 *      do time, então só o que é compartilhado com todo mundo faz sentido aqui.
 * POST /api/v1/crm/quick-replies — cria um template compartilhado.
 *
 * Auth por `X-Api-Key` (`autenticarApiKey`, lib/tenant-auth.ts) — mesmo padrão
 * de /api/v1/crm/kanban. Service role bypassa RLS; o filtro organization_id
 * abaixo é o que faz a vez da RLS aqui (doutrina: NÃO NEGOCIÁVEL).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLS = "id, title, body, shortcut, created_at, updated_at";

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
  shortcut: z.string().trim().max(50).optional().nullable(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("message_templates")
    .select(COLS)
    .eq("organization_id", auth.organization_id)
    .is("owner_user_id", null)
    .order("updated_at", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok({ respostas: data ?? [] }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("message_templates")
    .insert({
      organization_id: auth.organization_id,
      owner_user_id: null,
      title: parsed.data.title,
      body: parsed.data.body,
      shortcut: parsed.data.shortcut ?? null,
      created_by_user_id: auth.created_by,
    })
    .select(COLS)
    .single();
  if (error || !data) return fail("internal_error", error?.message ?? "template_insert_failed", 500, { requestId });

  void audit({
    action: "template.created",
    actorUserId: auth.created_by,
    actorApiTokenId: auth.api_token_id,
    organizationId: auth.organization_id,
    resourceType: "message_template",
    resourceId: data.id,
    requestId,
    metadata: { shared: true, title: parsed.data.title, via: "clinicfx" },
  });

  return ok(data, { requestId, status: 201 });
}

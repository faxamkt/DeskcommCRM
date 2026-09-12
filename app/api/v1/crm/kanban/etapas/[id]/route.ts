/**
 * PATCH /api/v1/crm/kanban/etapas/:id — renomeia uma etapa do funil (tela
 * "Funis" no Clinicfx). Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bodySchema = z.object({ nome: z.string().trim().min(1).max(120) });

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });
  const { id } = await params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return fail("validation_failed", "Nome inválido.", 422, { requestId, details: parsed.error.flatten() });

  const admin = createAdminClient();
  const { data: etapa, error } = await admin
    .from("crm_stages")
    .update({ name: parsed.data.nome, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", auth.organization_id)
    .select("id, name")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!etapa) return fail("not_found", "Etapa não encontrada.", 404, { requestId });

  return ok({ id: etapa.id, nome: etapa.name }, { requestId });
}

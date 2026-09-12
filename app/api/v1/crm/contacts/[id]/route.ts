/**
 * PATCH /api/v1/crm/contacts/:id — edita o nome do contato (painel da
 * conversa no Clinicfx). Grava em `display_name` — a mesma coluna que a UI
 * usa como nome preferencial (cai pra `name`/telefone quando vazia). Auth por
 * `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bodySchema = z.object({ nome: z.string().trim().min(1).max(200) });

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
  const { data: contato, error } = await admin
    .from("contacts")
    .update({ display_name: parsed.data.nome, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", auth.organization_id)
    .select("id, display_name")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!contato) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  void audit({
    action: "contact.updated",
    actorUserId: auth.created_by,
    actorApiTokenId: auth.api_token_id,
    organizationId: auth.organization_id,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: { field: "display_name", via: "clinicfx" },
  });

  return ok({ id: contato.id, nome: contato.display_name }, { requestId });
}

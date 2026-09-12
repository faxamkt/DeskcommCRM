/**
 * POST /api/v1/crm/kanban/etapas — adiciona uma etapa no funil padrão da
 * clínica (Clinicfx, tela "Funis"). Nasce no fim da ordem. Auth por `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { garantirPipelinePadrao } from "@/lib/crm-clinica/funil-padrao";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ nome: z.string().trim().min(1).max(120) });

function slugify(nome: string): string {
  return nome
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 32) || "etapa";
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
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return fail("validation_failed", "Nome inválido.", 422, { requestId, details: parsed.error.flatten() });

  const admin = createAdminClient();
  const pipeline = await garantirPipelinePadrao(admin, auth.organization_id);
  if (!pipeline) return fail("internal_error", "Não foi possível carregar o funil.", 500, { requestId });

  const { data: ultima } = await admin
    .from("crm_stages")
    .select("position")
    .eq("organization_id", auth.organization_id)
    .eq("pipeline_id", pipeline.id)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const proximaPosicao = (ultima?.position ?? 0) + 1000;

  let slug = slugify(parsed.data.nome);
  const { data: colisao } = await admin
    .from("crm_stages")
    .select("id")
    .eq("organization_id", auth.organization_id)
    .eq("pipeline_id", pipeline.id)
    .eq("slug", slug)
    .maybeSingle();
  if (colisao) slug = `${slug}-${randomUUID().slice(0, 6)}`;

  const { data: etapa, error } = await admin
    .from("crm_stages")
    .insert({
      organization_id: auth.organization_id,
      pipeline_id: pipeline.id,
      name: parsed.data.nome,
      slug,
      position: proximaPosicao,
    })
    .select("id, name")
    .single();
  if (error || !etapa) return fail("internal_error", error?.message ?? "stage_insert_failed", 500, { requestId });

  return ok({ id: etapa.id, nome: etapa.name }, { requestId, status: 201 });
}

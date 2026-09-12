/**
 * GET/POST /api/v1/crm/inbox/[id]/mensagens — histórico e envio de mensagem
 * pra integração Clinicfx. Reusa `listMessagesHandler`/`sendMessageHandler`
 * (app/api/v1/messages/_handler.ts) — o MESMO caminho que o app usa
 * internamente e que o MCP server usa pra chamada externa por bearer
 * (lib/mcp/tools/conversations.ts, lib/mcp/tools/messages.ts). Isso dá de
 * graça: guard de STOP/opt-out, ledger de idempotência, auditoria e emissão
 * de evento no envio — e o filtro `organization_id` (a checagem "a conversa é
 * desta org") já embutido nos dois handlers.
 *
 * Mídia (foto/documento/áudio): sobe primeiro em
 * `/api/v1/crm/inbox/[id]/anexo` (multipart), e o retorno dela
 * (media_storage_path/media_mime/media_size_bytes) entra aqui como body do
 * POST — mesmo fluxo storage-first do painel avançado.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { listMessagesHandler, sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { messageTypeSchema } from "@/lib/schemas/messaging";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const SIGNED_TTL_SECONDS = 3600;

const sendSchema = z
  .object({
    conteudo: z.string().trim().min(1).max(4096).optional(),
    tipo: messageTypeSchema.default("text"),
    media_storage_path: z.string().min(1).max(500).optional(),
    media_mime: z.string().optional(),
    media_size_bytes: z.number().int().positive().optional(),
  })
  .refine((d) => !!d.conteudo || !!d.media_storage_path, {
    message: "conteudo ou media_storage_path é obrigatório.",
    path: ["conteudo"],
  });

export async function GET(req: NextRequest, { params }: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });
  const { id } = await params;

  const admin = createAdminClient();
  try {
    const result = await listMessagesHandler(
      admin,
      {
        organization_id: auth.organization_id,
        actor: { type: "ai_agent", id: auth.api_token_id, role: auth.role, api_token_id: auth.api_token_id },
        requestId,
      },
      id,
      { limit: 50 },
    );

    const caminhos = [...new Set(result.messages.map((m) => m.media_storage_path).filter((p): p is string => Boolean(p)))];
    const assinadas = new Map<string, string>();
    if (caminhos.length > 0) {
      const { data } = await admin.storage.from("whatsapp-media").createSignedUrls(caminhos, SIGNED_TTL_SECONDS);
      for (const item of data ?? []) {
        if (item.signedUrl && !item.error && item.path) assinadas.set(item.path, item.signedUrl);
      }
    }

    const mensagens = result.messages.map((m) => ({
      id: m.id,
      conteudo: m.body,
      remetente: m.direction,
      tipo: m.type,
      media_url: m.media_storage_path ? assinadas.get(m.media_storage_path) ?? null : null,
      media_mime: m.media_mime,
      timestamp: m.sent_at,
    }));
    return ok({ mensagens }, { requestId });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    throw err;
  }
}

export async function POST(req: NextRequest, { params }: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("body_malformed", "Body must be valid JSON", 400, { requestId });
  }
  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "conteudo ou media_storage_path é obrigatório.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  try {
    const message = await sendMessageHandler(
      admin,
      {
        organization_id: auth.organization_id,
        actor: { type: "ai_agent", id: auth.api_token_id, role: auth.role, api_token_id: auth.api_token_id },
        requestId,
      },
      {
        conversation_id: id,
        type: parsed.data.tipo,
        body: parsed.data.conteudo,
        media_storage_path: parsed.data.media_storage_path,
        media_mime: parsed.data.media_mime,
        media_size_bytes: parsed.data.media_size_bytes,
      },
    );
    return ok({ id: message.id, conteudo: message.body, tipo: message.type, timestamp: message.sent_at }, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    throw err;
  }
}

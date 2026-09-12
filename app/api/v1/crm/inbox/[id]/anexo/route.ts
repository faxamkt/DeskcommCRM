/**
 * POST /api/v1/crm/inbox/[id]/anexo — upload de anexo (foto, documento ou
 * nota de voz) pra integração Clinicfx, mesmo caminho de storage do painel
 * avançado (`/api/v1/conversations/[id]/media`, storage-first: sobe pro
 * bucket, o envio referencia o storage_path). Devolve os campos prontos pra
 * `POST /api/v1/crm/inbox/[id]/mensagens` mandar como `media_*`. Auth por
 * `X-Api-Key`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autenticarApiKey } from "@/lib/tenant-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { extFromMime, MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { transcodificarNotaDeVoz } from "@/lib/messaging/media/voice-transcode";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const auth = await autenticarApiKey(req);
  if (!auth) return fail("unauthorized", "API key inválida.", 401, { requestId });
  const { id: conversationId } = await params;

  const admin = createAdminClient();
  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", auth.organization_id)
    .maybeSingle();
  if (convErr) return fail("internal_error", convErr.message, 500, { requestId });
  if (!conv) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  // Guard de DoS: rejeita pelo Content-Length declarado antes de bufferizar o
  // corpo inteiro — mesma folga de 1MB do endpoint irmão pro overhead multipart.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES + 1_048_576) {
    return fail("payload_too_large", "Arquivo acima de 50MB.", 413, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", "Campo 'file' (multipart) obrigatório.", 422, { requestId });
  }

  const mime = file.type || "application/octet-stream";
  const verdict = validateOutboundMedia(mime, file.size);
  if (!verdict.ok) {
    const status = verdict.code === "payload_too_large" ? 413 : verdict.code === "unsupported_media_type" ? 415 : 422;
    return fail(verdict.code, verdict.message, status, { requestId });
  }

  const bruto = Buffer.from(await file.arrayBuffer());

  // Nota de voz gravada no browser sai em webm — mesma conversão do endpoint
  // irmão, senão o canal oficial recusa depois de aceitar o upload.
  const audio = await transcodificarNotaDeVoz({ buffer: bruto, mime });
  const mimeFinal = audio.mime;
  const buffer = audio.buffer;

  const storagePath = `${auth.organization_id}/${conversationId}/out-${randomUUID()}.${extFromMime(mimeFinal)}`;
  const { error: upErr } = await admin.storage
    .from("whatsapp-media")
    .upload(storagePath, buffer, { contentType: mimeFinal, upsert: false });
  if (upErr) {
    return fail("internal_error", `Erro ao subir o arquivo: ${upErr.message}`, 500, { requestId });
  }

  return ok(
    { storage_path: storagePath, media_mime: mimeFinal, media_size_bytes: buffer.length, kind: verdict.kind },
    { requestId },
  );
}

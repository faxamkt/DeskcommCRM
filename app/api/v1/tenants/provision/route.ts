/**
 * POST /api/v1/tenants/provision — um sistema externo (ex.: Clinicfx) cria (ou reencontra,
 * idempotente por integração + id externo) uma organização e recebe uma chave
 * de API `dsk_…` para operá-la.
 *
 * Suporta tanto `TENANT_PROVISIONING_SECRET` quanto `DESKCOMM_PROVISIONING_SECRET`
 * para compatibilidade total.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { checkRateLimit, peekRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import {
  EmailJaTemContaError,
  ProvisionConflictError,
  provisionExternalTenant,
} from "@/lib/auth/provision";
import { env } from "@/lib/env";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { extractBearer } from "@/lib/mcp/auth";
import { provisionTenantSchema, type ProvisionTenantInput } from "@/lib/schemas/tenant-provisioning";
import { validateRequest } from "@/lib/schemas/_validate";
import { rotateIntegrationApiKey } from "@/lib/tenants/api-key";

export const dynamic = "force-dynamic";

/** FALHAS por IP por minuto — acima disto é varredura de segredo, não integração. */
const FALHAS_POR_MINUTO = 10;

function segredoDaInstalacao(): string | null {
  const segredo = (env.TENANT_PROVISIONING_SECRET || env.DESKCOMM_PROVISIONING_SECRET || "").trim();
  return segredo.length >= 8 ? segredo : null;
}

/**
 * Comparação em tempo constante; tamanhos diferentes nunca autenticam.
 */
function bearerConfere(req: NextRequest, esperado: string): boolean {
  const recebido = extractBearer(req.headers.get("authorization")) ?? "";
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const esperado = segredoDaInstalacao();
  if (!esperado) return fail("not_found", "Not found.", 404, { requestId });

  const ip = ipDoCliente(req.headers);
  const balde = ip === null ? null : `tenants_provision:falha:ip:${ip}`;
  const falhas = balde === null ? 0 : await peekRateLimit(balde, 60);

  const cabecalhosDoLimite: Record<string, string> =
    balde === null
      ? {}
      : {
          "X-RateLimit-Limit": String(FALHAS_POR_MINUTO),
          "X-RateLimit-Remaining": String(Math.max(0, FALHAS_POR_MINUTO - falhas)),
        };
  if (balde !== null && falhas >= FALHAS_POR_MINUTO) {
    return fail("rate_limited", "Too many requests.", 429, {
      requestId,
      headers: { ...cabecalhosDoLimite, "Retry-After": "60" },
    });
  }

  if (!bearerConfere(req, esperado)) {
    if (balde !== null) await checkRateLimit(balde, FALHAS_POR_MINUTO, 60);
    return fail("unauthenticated", "Credencial inválida.", 401, {
      requestId,
      headers: cabecalhosDoLimite,
    });
  }

  let input: ProvisionTenantInput;
  try {
    input = await validateRequest(provisionTenantSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const integration = input.integration || "clinicfx";
    const externalId = input.external_id || input.clinic_id || "";
    const organizationName = input.organization_name || input.clinic_name || "";

    const { organizationId, ownerId, replay } = await provisionExternalTenant({
      integration,
      externalId,
      organizationName,
      clinicId: input.clinic_id,
      clinicName: input.clinic_name,
      ownerEmail: input.owner_email,
      ownerName: input.owner_name,
      requestId,
    });

    const apiKey = await rotateIntegrationApiKey({
      organizationId,
      createdBy: ownerId,
      integrationScope: `integration:${integration}`,
      name: `${integration} (integração)`,
      requestId,
    });

    return ok(
      {
        org_id: organizationId,
        organization_id: organizationId,
        api_key: apiKey,
        replay,
      },
      {
        status: replay ? 200 : 201,
        requestId,
        headers: { ...cabecalhosDoLimite, "Cache-Control": "no-store" },
      },
    );
  } catch (err) {
    if (err instanceof EmailJaTemContaError) {
      return fail(
        "owner_email_ja_tem_conta",
        "Esse e-mail já tem conta nesta instalação — convide a pessoa pela tela da empresa.",
        409,
        { requestId },
      );
    }
    if (err instanceof ProvisionConflictError) {
      return fail(
        "provisioning_conflict",
        "Já existe uma organização com este identificador que não nasceu deste provisionamento.",
        409,
        { requestId },
      );
    }
    logger.error("[tenants.provision] falhou", {
      requestId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "Não foi possível provisionar a organização.", 500, { requestId });
  }
}

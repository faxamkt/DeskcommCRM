/**
 * POST /api/v1/tenants/provision — cria (ou reencontra, idempotente por
 * `clinic_id`) um tenant a partir do Clinicfx e devolve uma API key pro
 * tenant. Auth: Bearer `DESKCOMM_PROVISIONING_SECRET`, fail-closed.
 *
 * Aqui só há transporte: a criação de org/dono vive em
 * `lib/auth/provision.ts` (`provisionExternalTenant`), a emissão/rotação de
 * chave em `lib/tenants/api-key.ts` (`rotateIntegrationApiKey`).
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { provisionExternalTenant } from "@/lib/auth/provision";
import { env } from "@/lib/env";
import { provisionTenantSchema, type ProvisionTenantInput } from "@/lib/schemas/tenant-provisioning";
import { validateRequest } from "@/lib/schemas/_validate";
import { rotateIntegrationApiKey } from "@/lib/tenants/api-key";

export const dynamic = "force-dynamic";

const CLINICFX_SCOPE = "integration:clinicfx";

/**
 * Comparação em tempo constante — mesma forma de
 * `app/api/v1/system/relogio/tick/route.ts`. Secret vazio nunca autentica
 * (instalação que não configurou a integração fica fail-closed, não aberta).
 */
function bearerValido(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const expected = env.DESKCOMM_PROVISIONING_SECRET;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!bearerValido(req)) {
    return fail("unauthorized", "Credencial inválida.", 401, { requestId });
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
    const { organizationId, ownerId, replay } = await provisionExternalTenant({
      clinicId: input.clinic_id,
      clinicName: input.clinic_name,
      ownerEmail: input.owner_email,
      ownerName: input.owner_name,
    });

    const apiKey = await rotateIntegrationApiKey({
      organizationId,
      createdBy: ownerId,
      integrationScope: CLINICFX_SCOPE,
      requestId,
    });

    return ok(
      { org_id: organizationId, api_key: apiKey },
      { status: replay ? 200 : 201, requestId },
    );
  } catch (err) {
    console.error("[tenants.provision] falhou", err instanceof Error ? err.message : err);
    return fail("internal_error", "Não foi possível provisionar o tenant.", 500, { requestId });
  }
}

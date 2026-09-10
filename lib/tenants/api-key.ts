import { createHash, randomBytes } from "node:crypto";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Emite (ou reemite) a API key `dsk_...` de uma organização para uma
 * integração externa — mesmo formato/hash de
 * `app/api/v1/settings/api-tokens/route.ts` (`dsk_<prefix>_<secret>`, SHA256
 * em `token_hash`, plaintext nunca persistido).
 *
 * Sem "recuperar a mesma chave depois": como só o hash fica no banco, uma
 * chamada repetida (replay do provisionamento) revoga a chave anterior desta
 * integração e emite uma nova — nunca duas chaves vivas para o mesmo par
 * (org, integração), e nunca a promessa de devolver texto que não existe mais.
 */
export async function rotateIntegrationApiKey(input: {
  organizationId: string;
  createdBy: string;
  /** Escopo que marca a origem, ex.: `integration:clinicfx`. Também filtra revogação. */
  integrationScope: string;
  requestId?: string;
}): Promise<string> {
  const admin = createAdminClient();

  const { data: previous } = await admin
    .from("api_tokens")
    .select("id")
    .eq("organization_id", input.organizationId)
    .is("revoked_at", null)
    .contains("scopes", [input.integrationScope]);

  if (previous && previous.length > 0) {
    const ids = previous.map((t) => t.id);
    await admin
      .from("api_tokens")
      .update({ revoked_at: new Date().toISOString(), revoked_by: input.createdBy })
      .in("id", ids);
    for (const id of ids) {
      void audit({
        action: "token.revoked",
        actorUserId: input.createdBy,
        organizationId: input.organizationId,
        resourceType: "api_token",
        resourceId: id,
        requestId: input.requestId,
        metadata: { reason: "clinicfx_provisioning_replay" },
      });
    }
  }

  const prefix = `dsk_${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${prefix}_${secret}`;
  const tokenHash = createHash("sha256").update(plaintext).digest();

  const { data: created, error } = await admin
    .from("api_tokens")
    .insert({
      organization_id: input.organizationId,
      created_by: input.createdBy,
      name: "Clinicfx (integração)",
      prefix,
      token_hash: `\\x${tokenHash.toString("hex")}`,
      scopes: ["role:agent", "actor:ai_agent", input.integrationScope],
    })
    .select("id")
    .single();

  if (error || !created) {
    throw new Error(`rotateIntegrationApiKey: insert falhou: ${error?.message}`);
  }

  void audit({
    action: "token.created",
    actorUserId: input.createdBy,
    organizationId: input.organizationId,
    resourceType: "api_token",
    resourceId: created.id,
    requestId: input.requestId,
    metadata: { name: "Clinicfx (integração)", prefix, scopes: ["role:agent", "actor:ai_agent", input.integrationScope] },
  });

  return plaintext;
}

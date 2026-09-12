/**
 * Auth por API key pra rotas `/api/v1/crm/*` (integração Clinicfx).
 *
 * Header `X-Api-Key` (não `Authorization: Bearer` — esse é o canal do MCP e
 * de sessão de usuário; manter os dois separados evita que os dois modelos de
 * auth se confundam na mesma função). O valor é o MESMO formato `dsk_...` de
 * `api_tokens`: `resolveApiToken` (lib/mcp/auth.ts) faz o hash+lookup — sem
 * duplicar a leitura de `api_tokens`, e sem plaintext armazenado (anti-pattern
 * #13 do CLAUDE.md).
 */
import { ApiTokenError, resolveApiToken } from "@/lib/mcp/auth";
import type { Role } from "@/lib/auth/types";

export interface TenantApiKeyAuth {
  organization_id: string;
  role: Role;
  api_token_id: string;
  /**
   * `api_tokens.created_by` — quem provisionou este token (o dono do tenant).
   * Usado como autor de escrita em tabelas que exigem `created_by_user_id`
   * (ex.: `message_templates`, `webhook_sources`) quando quem grava é a
   * integração Clinicfx, não uma pessoa com sessão de cookie.
   */
  created_by: string | null;
}

function scopesRole(scopes: string[]): Role {
  for (const s of scopes) {
    if (s.startsWith("role:")) return s.slice("role:".length) as Role;
  }
  return "agent";
}

export async function autenticarApiKey(request: Request): Promise<TenantApiKeyAuth | null> {
  const apiKey = request.headers.get("x-api-key")?.trim();
  if (!apiKey) return null;

  try {
    const resolved = await resolveApiToken(apiKey);
    return {
      organization_id: resolved.organizationId,
      role: scopesRole(resolved.scopes),
      api_token_id: resolved.id,
      created_by: resolved.createdBy,
    };
  } catch (err) {
    if (err instanceof ApiTokenError) return null;
    throw err;
  }
}

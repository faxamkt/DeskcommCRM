import { createHash, randomBytes } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

/** Normaliza o nome da empresa para um slug candidato (citext unique no DB). */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "org";
}

type ProvisionUser = {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
};

/**
 * De onde veio o provisionamento. A organização nasce igual nos dois casos — o
 * que muda é a linha de auditoria, e ela precisa distinguir "primeiro acesso
 * normal" de "primeiro acesso que precisou ser recuperado": a segunda é um
 * sintoma de que o caminho do signup falhou, e some no meio da primeira.
 */
type ProvisionOptions = {
  source?: "signup" | "recovery";
};

/**
 * Provisiona o tenant de um usuário recém-confirmado via signup self-service:
 * cria a organização (status `active`, `onboarded_at` null → cai no onboarding)
 * e a membership `admin` do usuário.
 *
 * Idempotente: se o usuário já tem membership ativa (link de confirmação
 * clicado duas vezes, ou usuário que entrou antes por convite), não faz nada.
 *
 * Service role é intencional aqui — o usuário ainda não pertence a nenhuma org,
 * então RLS bloquearia os INSERTs. A fonte confiável é o JWT já validado por
 * `verifyOtp` no caller (nunca o body).
 */
export async function ensureTenantForUser(
  user: ProvisionUser,
  options: ProvisionOptions = {},
): Promise<{ provisioned: boolean; organizationId?: string }> {
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();
  if (existing) return { provisioned: false, organizationId: existing.organization_id };

  const orgName =
    (user.user_metadata?.org_name as string | undefined)?.trim() ||
    user.email?.split("@")[0] ||
    "Minha empresa";
  const base = slugify(orgName);

  // ponytail: check-then-insert tem janela de corrida se o mesmo link for
  // confirmado 2x em paralelo (pior caso: org duplicada órfã). Advisory lock
  // por user_id se isso aparecer na prática.
  let org: { id: string; slug: string } | null = null;
  for (let attempt = 0; attempt < 3 && !org; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await admin
      .from("organizations")
      .insert({
        slug,
        display_name: orgName,
        legal_name: orgName,
        status: "active",
        created_by: user.id,
      })
      .select("id, slug")
      .single();
    if (data) {
      org = data;
    } else if (error && error.code !== "23505") {
      throw new Error(`signup provisioning: org insert failed: ${error.message}`);
    }
  }
  if (!org) throw new Error("signup provisioning: slug exhausted after 3 attempts");

  const { error: memberError } = await admin.from("user_organizations").insert({
    user_id: user.id,
    organization_id: org.id,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (memberError && memberError.code !== "23505") {
    throw new Error(`signup provisioning: membership insert failed: ${memberError.message}`);
  }

  void audit({
    action:
      options.source === "recovery" ? "tenant.created_by_recovery" : "tenant.created_by_signup",
    actorUserId: user.id,
    organizationId: org.id,
    resourceType: "organization",
    resourceId: org.id,
    bypassedRls: true,
    metadata: { slug: org.slug },
  });

  return { provisioned: true, organizationId: org.id };
}

type ExternalProvisionInput = {
  /** Quem está provisionando (ex.: `clinicfx`). Entra no slug, no marcador e no escopo da chave. */
  integration?: string;
  /** Id da empresa no sistema externo. É a chave de idempotência. */
  externalId?: string;
  organizationName?: string;
  /** Compatibilidade com Clinicfx legado */
  clinicId?: string;
  clinicName?: string;
  ownerEmail: string;
  ownerName: string;
  /** O `X-Request-Id` da rota — é ele que liga esta linha de auditoria à resposta. */
  requestId?: string;
};

/**
 * O marcador que prova que a organização nasceu DESTE provisionamento.
 *
 * O slug é determinístico, mas slug é um espaço compartilhado com o cadastro
 * pela tela: uma organização criada à mão com o mesmo slug não é "replay" — é
 * outra empresa, e devolver uma chave dela seria entregar os dados de alguém a
 * um sistema de fora. Por isso o reencontro exige o marcador, e sem ele a
 * resposta é conflito.
 */
type MarcadorDeProvisionamento = { integration: string; external_id: string };

export class ProvisionConflictError extends Error {
  constructor() {
    super("provisioning_slug_conflict");
  }
}

/**
 * Slug determinístico por (integração, id externo).
 * Para Clinicfx mantemos clinicfx-<slugify(id)> para casar com clínicas já existentes no banco.
 */
export function slugDoProvisionamento(integration: string, externalId: string): string {
  if (integration === "clinicfx") {
    return `clinicfx-${slugify(externalId)}`;
  }
  const hash = createHash("sha256").update(externalId).digest("hex").slice(0, 16);
  return `${integration}-${hash}`;
}

/**
 * Lê o marcador de onde ele estiver gravado — `organizations.settings` ou o
 * `app_metadata` da conta do dono.
 * Suporta tanto o padrão novo quanto o legado da integração Clinicfx.
 */
function marcadorDe(fonte: unknown): MarcadorDeProvisionamento | null {
  const f = fonte as {
    provisioning?: unknown;
    integrations?: { clinicfx?: { clinic_id?: unknown } };
  } | null;

  const m = f?.provisioning as Partial<MarcadorDeProvisionamento> | undefined;
  if (typeof m?.integration === "string" && typeof m?.external_id === "string") {
    return { integration: m.integration, external_id: m.external_id };
  }

  const legacyClinicId = f?.integrations?.clinicfx?.clinic_id;
  if (typeof legacyClinicId === "string") {
    return { integration: "clinicfx", external_id: legacyClinicId };
  }

  return null;
}

/**
 * Provisiona uma organização a partir de um sistema externo, via
 * `POST /api/v1/tenants/provision` — rota que só existe quando o DONO DA
 * INSTALAÇÃO define `TENANT_PROVISIONING_SECRET` (ou `DESKCOMM_PROVISIONING_SECRET`).
 *
 * Diferente de `ensureTenantForUser` (signup self-service) e do fluxo de
 * `POST /api/v1/admin/tenants` (que convida o dono por e-mail): aqui o dono é
 * criado JÁ ATIVO, com senha aleatória e sem convite — quem opera usa o
 * sistema de fora, que fala com esta organização pela chave de API. O usuário
 * existe para `user_organizations`/`api_tokens.created_by` e para dar a um
 * humano um caminho de acesso por "esqueci minha senha".
 *
 * Idempotente por (integração, id externo), inclusive sob corrida.
 */
export async function provisionExternalTenant(
  input: ExternalProvisionInput,
): Promise<{ organizationId: string; ownerId: string; replay: boolean }> {
  const admin = createAdminClient();
  const integration = input.integration || "clinicfx";
  const externalId = input.externalId || input.clinicId || "";
  const organizationName = input.organizationName || input.clinicName || "";
  const slug = slugDoProvisionamento(integration, externalId);
  const email = input.ownerEmail.trim().toLowerCase();
  const marcador: MarcadorDeProvisionamento = {
    integration,
    external_id: externalId,
  };

  /**
   * Reencontra o provisionamento anterior — e SÓ conclui por replay sobre um
   * estado completo, completando o que faltar.
   */
  const reencontrarECompletar = async (): Promise<{
    organizationId: string;
    ownerId: string;
  } | null> => {
    let { data, error } = await admin
      .from("organizations")
      .select("id, created_by, settings")
      .eq("slug", slug)
      .maybeSingle();

    if (!data && integration === "clinicfx") {
      const fallbackHashSlug = `clinicfx-${createHash("sha256").update(externalId).digest("hex").slice(0, 16)}`;
      const res = await admin
        .from("organizations")
        .select("id, created_by, settings")
        .eq("slug", fallbackHashSlug)
        .maybeSingle();
      data = res.data;
      error = res.error;
    }

    if (error) {
      throw new Error(`provisioning: busca da organização falhou: ${error.message}`);
    }
    if (!data) return null;
    const achado = marcadorDe(data.settings);
    if (achado && (achado.integration !== marcador.integration || achado.external_id !== marcador.external_id)) {
      throw new ProvisionConflictError();
    }
    const ownerId = data.created_by ?? (await findAdminMember(admin, data.id));
    if (!ownerId) {
      throw new Error(`provisioning: replay sem admin encontrado para org ${data.id}`);
    }
    await garantirAdminDaOrganizacao(admin, {
      organizationId: data.id,
      ownerId,
      slug,
      marcador,
      requestId: input.requestId,
    });
    return { organizationId: data.id, ownerId };
  };

  const existente = await reencontrarECompletar();
  if (existente) return { ...existente, replay: true };

  const ownerId = await ensureExternalOwnerUser(admin, email, input.ownerName, marcador);

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .insert({
      slug,
      display_name: organizationName,
      legal_name: organizationName,
      status: "active",
      created_by: ownerId,
      settings: {
        provisioning: marcador,
        integrations: {
          clinicfx: { clinic_id: externalId, owner_email: email },
        },
      },
    })
    .select("id")
    .single();

  if (orgError) {
    if (orgError.code === "23505") {
      const corrida = await reencontrarECompletar();
      if (corrida) return { ...corrida, replay: true };
    }
    throw new Error(`provisioning: org insert failed: ${orgError.message}`);
  }

  const { error: memberError } = await admin.from("user_organizations").insert({
    user_id: ownerId,
    organization_id: org.id,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (memberError && memberError.code !== "23505") {
    throw new Error(`provisioning: membership insert failed: ${memberError.message}`);
  }

  void audit({
    action: "tenant.created_by_provisioning",
    actorUserId: null,
    organizationId: org.id,
    resourceType: "organization",
    resourceId: org.id,
    requestId: input.requestId,
    bypassedRls: true,
    metadata: {
      slug,
      integration,
      external_id: externalId,
      owner_user_id: ownerId,
    },
  });

  return { organizationId: org.id, ownerId, replay: false };
}

/**
 * "Este vínculo está VIVO?" — a ÚNICA régua da pergunta, com ou sem organização escolhida.
 */
async function vinculoVivo(
  admin: ReturnType<typeof createAdminClient>,
  filtro: { userId: string; organizationId?: string },
): Promise<{ organizationId: string; role: string } | null> {
  let consulta = admin
    .from("user_organizations")
    .select("organization_id, role")
    .eq("user_id", filtro.userId)
    .is("revoked_at", null);
  if (filtro.organizationId) {
    consulta = consulta.eq("organization_id", filtro.organizationId);
  }
  const { data, error } = await consulta.limit(1).maybeSingle();
  if (error) {
    throw new Error(`provisioning: busca do vínculo do dono falhou: ${error.message}`);
  }
  return data ? { organizationId: data.organization_id, role: data.role } : null;
}

/**
 * Completa o vínculo de admin que uma tentativa anterior não chegou a gravar.
 */
async function garantirAdminDaOrganizacao(
  admin: ReturnType<typeof createAdminClient>,
  p: {
    organizationId: string;
    ownerId: string;
    slug: string;
    marcador: MarcadorDeProvisionamento;
    requestId?: string;
  },
): Promise<void> {
  const vivo = await vinculoVivo(admin, {
    userId: p.ownerId,
    organizationId: p.organizationId,
  });
  if (vivo?.role === "admin") return;

  const { error } = await admin.from("user_organizations").insert({
    user_id: p.ownerId,
    organization_id: p.organizationId,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (error && error.code !== "23505") {
    throw new Error(`provisioning: completar o vínculo do dono falhou: ${error.message}`);
  }
  if (error) return;

  void audit({
    action: "tenant.provisioning_completed",
    actorUserId: null,
    organizationId: p.organizationId,
    resourceType: "organization",
    resourceId: p.organizationId,
    requestId: p.requestId,
    bypassedRls: true,
    metadata: {
      slug: p.slug,
      integration: p.marcador.integration,
      external_id: p.marcador.external_id,
      owner_user_id: p.ownerId,
      completou: "user_organizations",
    },
  });
}

/**
 * O admin mais antigo da organização — e admin MESMO.
 */
async function findAdminMember(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .is("revoked_at", null)
    .order("accepted_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`provisioning: busca do admin da organização falhou: ${error.message}`);
  }
  return data?.user_id ?? null;
}

export class EmailJaTemContaError extends Error {
  constructor() {
    super("provisioning_email_ja_tem_conta");
  }
}

/**
 * Cria a pessoa dona — ou REAPROVEITA a conta que uma tentativa anterior DESTE
 * mesmo provisionamento deixou para trás (ou usuário existente em integrações como Clinicfx).
 */
async function ensureExternalOwnerUser(
  admin: ReturnType<typeof createAdminClient>,
  email: string,
  fullName: string,
  marcador: MarcadorDeProvisionamento,
): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: randomBytes(24).toString("base64url"),
    email_confirm: true,
    user_metadata: { full_name: fullName },
    app_metadata: { provisioning: marcador },
  });
  if (data?.user) return data.user.id;
  const jaExiste =
    error?.code === "email_exists" ||
    (error?.status === 422 && /already (been )?registered/i.test(error.message));
  if (jaExiste) {
    const orfa = await donoOrfaoDesteProvisionamento(admin, email, marcador);
    if (orfa) return orfa;
    if (marcador.integration === "clinicfx") {
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
      const achada = list?.users.find((u) => u.email?.toLowerCase() === email);
      if (achada) return achada.id;
    }
    throw new EmailJaTemContaError();
  }
  throw new Error(`provisioning: criar dono falhou: ${error?.message ?? "sem usuário"}`);
}

const CONTAS_POR_PAGINA = 200;
const PAGINAS_DO_DIRETORIO = 50;

async function donoOrfaoDesteProvisionamento(
  admin: ReturnType<typeof createAdminClient>,
  email: string,
  marcador: MarcadorDeProvisionamento,
): Promise<string | null> {
  let conta: { id: string; app_metadata: unknown } | null = null;

  for (let pagina = 1; pagina <= PAGINAS_DO_DIRETORIO && !conta; pagina++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page: pagina,
      perPage: CONTAS_POR_PAGINA,
    });
    if (error) {
      throw new Error(`provisioning: busca da conta do dono falhou: ${error.message}`);
    }
    if (data.users.length === 0) break;
    const achada = data.users.find((u) => u.email?.toLowerCase() === email);
    if (achada) conta = { id: achada.id, app_metadata: achada.app_metadata };
  }

  if (!conta) return null;

  const dela = marcadorDe(conta.app_metadata);
  if (dela?.integration !== marcador.integration || dela.external_id !== marcador.external_id) {
    return null;
  }

  const vinculo = await vinculoVivo(admin, { userId: conta.id });
  return vinculo ? null : conta.id;
}

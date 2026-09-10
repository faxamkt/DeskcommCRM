import { randomBytes } from "node:crypto";

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
  /** Id do tenant no sistema externo (Clinicfx). Vira slug determinístico. */
  clinicId: string;
  clinicName: string;
  ownerEmail: string;
  ownerName: string;
};

/**
 * Provisiona um tenant a partir de um sistema externo (Clinicfx), via
 * `POST /api/v1/tenants/provision`.
 *
 * Diferente de `ensureTenantForUser` (signup self-service) e do fluxo de
 * `POST /api/v1/admin/tenants` (que convida o dono por e-mail e só cria o
 * `auth.users` quando o convite é aceito): aqui o dono é criado JÁ ATIVO, com
 * senha aleatória e sem convite disparado — o operador da clínica não usa a
 * tela do DeskcommCRM, só a do Clinicfx (que fala com este tenant via API key).
 * O usuário existe para satisfazer `user_organizations`/`api_tokens.created_by`
 * e para dar a um humano (suporte, ou o próprio operador depois) um caminho de
 * acesso via "esqueci minha senha" se um dia precisar.
 *
 * Idempotente por `clinicId`: o slug é determinístico
 * (`clinicfx-<slugify(clinicId)>`), e `organizations.slug` já é `UNIQUE` no
 * banco — reaplicar com o mesmo `clinicId` acha a org existente em vez de
 * duplicar (inclusive sob corrida: `23505` no insert é relido como replay).
 */
export async function provisionExternalTenant(
  input: ExternalProvisionInput,
): Promise<{ organizationId: string; ownerId: string; replay: boolean }> {
  const admin = createAdminClient();
  const slug = `clinicfx-${slugify(input.clinicId)}`;
  const email = input.ownerEmail.trim().toLowerCase();

  const { data: existingOrg } = await admin
    .from("organizations")
    .select("id, created_by")
    .eq("slug", slug)
    .maybeSingle();

  if (existingOrg) {
    const ownerId = existingOrg.created_by ?? (await findAdminMember(admin, existingOrg.id));
    if (!ownerId) {
      throw new Error(`clinicfx provisioning: replay sem admin encontrado para org ${existingOrg.id}`);
    }
    return { organizationId: existingOrg.id, ownerId, replay: true };
  }

  const ownerId = await ensureExternalOwnerUser(admin, email, input.ownerName);

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .insert({
      slug,
      display_name: input.clinicName,
      legal_name: input.clinicName,
      status: "active",
      created_by: ownerId,
      settings: {
        integrations: { clinicfx: { clinic_id: input.clinicId, owner_email: email } },
      },
    })
    .select("id")
    .single();

  if (orgError) {
    if (orgError.code === "23505") {
      const { data: raced } = await admin
        .from("organizations")
        .select("id, created_by")
        .eq("slug", slug)
        .maybeSingle();
      if (raced) {
        const racedOwnerId = raced.created_by ?? (await findAdminMember(admin, raced.id));
        if (racedOwnerId) return { organizationId: raced.id, ownerId: racedOwnerId, replay: true };
      }
    }
    throw new Error(`clinicfx provisioning: org insert failed: ${orgError.message}`);
  }

  const { error: memberError } = await admin.from("user_organizations").insert({
    user_id: ownerId,
    organization_id: org.id,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (memberError && memberError.code !== "23505") {
    throw new Error(`clinicfx provisioning: membership insert failed: ${memberError.message}`);
  }

  void audit({
    action: "tenant.created_by_clinicfx_provisioning",
    actorUserId: ownerId,
    organizationId: org.id,
    resourceType: "organization",
    resourceId: org.id,
    bypassedRls: true,
    metadata: { slug, clinic_id: input.clinicId },
  });

  return { organizationId: org.id, ownerId, replay: false };
}

async function findAdminMember(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", organizationId)
    .is("revoked_at", null)
    .order("accepted_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.user_id ?? null;
}

/** Reaproveita usuário existente (mesmo e-mail já usado por outra integração) em vez de colidir no `auth.users`. */
async function ensureExternalOwnerUser(
  admin: ReturnType<typeof createAdminClient>,
  email: string,
  fullName: string,
): Promise<string> {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const existing = list?.users.find((u) => u.email?.toLowerCase() === email);
  if (existing) return existing.id;

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: randomBytes(24).toString("base64url"),
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error || !data?.user) {
    throw new Error(`clinicfx provisioning: criar dono falhou: ${error?.message}`);
  }
  return data.user.id;
}

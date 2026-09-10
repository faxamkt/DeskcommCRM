import { z } from "zod";

/**
 * Corpo de `POST /api/v1/tenants/provision` (integração Clinicfx).
 * Não é o mesmo schema de `tenant-creation.ts` (aquele é do formulário de
 * criação manual por platform admin — plano, convite, interface — nenhum dos
 * quais existe aqui).
 */
export const provisionTenantSchema = z.object({
  clinic_id: z.string().trim().min(1).max(200),
  clinic_name: z.string().trim().min(1).max(200),
  owner_email: z.string().trim().email(),
  owner_name: z.string().trim().min(1).max(200),
});

export type ProvisionTenantInput = z.infer<typeof provisionTenantSchema>;

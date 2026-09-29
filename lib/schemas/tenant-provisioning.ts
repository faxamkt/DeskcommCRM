import { z } from "zod";

const standardSchema = z
  .object({
    integration: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{1,30}$/),
    external_id: z.string().trim().min(1).max(200),
    organization_name: z.string().trim().min(1).max(200),
    owner_email: z.string().trim().email(),
    owner_name: z.string().trim().min(1).max(200),
    clinic_id: z.string().trim().optional(),
    clinic_name: z.string().trim().optional(),
  })
  .strict();

/**
 * Suporte retrocompatível para a integração Clinicfx original
 * (que enviava clinic_id e clinic_name diretamente).
 */
const clinicfxLegacySchema = z
  .object({
    clinic_id: z.string().trim().min(1).max(200),
    clinic_name: z.string().trim().min(1).max(200),
    owner_email: z.string().trim().email(),
    owner_name: z.string().trim().min(1).max(200),
  })
  .transform((val) => ({
    integration: "clinicfx",
    external_id: val.clinic_id,
    organization_name: val.clinic_name,
    owner_email: val.owner_email,
    owner_name: val.owner_name,
    clinic_id: val.clinic_id,
    clinic_name: val.clinic_name,
  }));

export const provisionTenantSchema = z.union([standardSchema, clinicfxLegacySchema]);

export type ProvisionTenantInput = {
  integration: string;
  external_id: string;
  organization_name: string;
  owner_email: string;
  owner_name: string;
  clinic_id?: string;
  clinic_name?: string;
};

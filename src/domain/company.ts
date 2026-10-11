import { z } from "zod";
import { HttpUrlSchema } from "./normalize.js";

export const CompanyCreateSchema = z.object({
  name: z.string().trim().min(1, "company name must not be empty"),
  website: HttpUrlSchema.nullish(),
  careersUrl: HttpUrlSchema.nullish(),
  atsPlatform: z.string().trim().min(1).nullish(),
});

export type CompanyCreateInput = z.infer<typeof CompanyCreateSchema>;

export interface Company {
  id: number;
  name: string;
  normalizedName: string;
  website: string | null;
  careersUrl: string | null;
  atsPlatform: string | null;
  createdAt: string;
  updatedAt: string;
}

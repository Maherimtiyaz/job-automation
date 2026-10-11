import { config as loadDotenv } from "dotenv";
import { z } from "zod";

export const DEFAULT_DATABASE_PATH = "data/job-automation.db";
export const DEFAULT_PROFILE_PATH = "data/profile.json";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_PATH: z.string().trim().min(1).default(DEFAULT_DATABASE_PATH),
  PROFILE_PATH: z.string().trim().min(1).default(DEFAULT_PROFILE_PATH),
});

export type AppConfig = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadDotenv({ quiet: true });

  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid environment configuration: ${details}`);
  }

  return result.data;
}

import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  ADMIN_ORIGINS: z.string().default("http://localhost:5174"),
  PLATFORM_DOMAIN: z.string().default("yourplatform.in"),
  STORES_CNAME_TARGET: z.string().default("stores.yourplatform.in"),
  PUBLIC_API_URL: z.string().default("http://localhost:4000"),
  MONGO_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  JWT_CUSTOMER_SECRET: z.string().min(8),
  VAULT_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "VAULT_KEY must be 64 hex chars"),
  INTERNAL_PROXY_SECRET: z.string().min(8),
  COMMISSION_RATE_PERCENT: z.coerce.number().default(3),
  COMMISSION_GST_PERCENT: z.coerce.number().default(18),
  PLATFORM_LEGAL_NAME: z.string().default("Your Platform Pvt Ltd"),
  PLATFORM_GSTIN: z.string().default(""),
  PLATFORM_STATE_CODE: z.string().default("24"),
  PLATFORM_ADDRESS: z.string().default(""),
  CASHFREE_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  CASHFREE_API_VERSION: z.string().default("2023-08-01"),
  SHIPROCKET_BASE_URL: z.string().default("https://apiv2.shiprocket.in/v1/external"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().default("ecom-platform-media"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().default(""),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default("no-reply@yourplatform.in"),
  MESSAGING_PROVIDER: z.enum(["log", "msg91", "custom"]).default("log"),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATES: z.string().optional(), // JSON: { "otp": "<template id>", ... }
  MANDATE_PROVIDER: z.enum(["manual"]).default("manual"),
  META_GRAPH_VERSION: z.string().default("v21.0"),
  SUPERADMIN_EMAIL: z.string().optional(),
  SUPERADMIN_PASSWORD: z.string().optional(),
  // Opt-in for local dev only: return OTP codes in the API response. Off by default; never honoured in production.
  EXPOSE_DEV_OTP: z.string().optional(),
});

export const env = schema.parse(process.env);
export const isProd = env.NODE_ENV === "production";

if (env.MESSAGING_PROVIDER === "msg91" && !env.MSG91_AUTH_KEY) {
  throw new Error("MESSAGING_PROVIDER=msg91 needs MSG91_AUTH_KEY");
}

// Refuse to start a production server with placeholder or short secrets.
if (isProd) {
  const weak = ["change-me-internal", "changeme", "secret"];
  const checks: [string, string][] = [
    ["INTERNAL_PROXY_SECRET", env.INTERNAL_PROXY_SECRET],
    ["JWT_ACCESS_SECRET", env.JWT_ACCESS_SECRET],
    ["JWT_REFRESH_SECRET", env.JWT_REFRESH_SECRET],
    ["JWT_CUSTOMER_SECRET", env.JWT_CUSTOMER_SECRET],
  ];
  for (const [name, value] of checks) {
    if (value.length < 32 || weak.includes(value.toLowerCase())) {
      throw new Error(`${name} must be at least 32 random characters in production`);
    }
  }
}

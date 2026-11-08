import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "openapi"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // Tenant isolation: cross-tenant access must go through runWithoutTenant() with a reason.
      "no-restricted-syntax": ["error", { selector: "Property[key.name='bypass'][value.value=true]", message: "Use runWithoutTenant(reason, fn) instead of setting bypass directly." }],
    },
  },
  { files: ["src/db/tenantContext.ts", "src/db/tenantPlugin.ts", "src/middleware/guards.ts"], rules: { "no-restricted-syntax": "off" } },
);

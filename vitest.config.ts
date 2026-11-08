import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    env: {
      MONGO_URL: process.env.MONGO_URL_TEST ?? "mongodb://localhost:27017/ecom_test?replicaSet=rs0",
      JWT_ACCESS_SECRET: "test-access-secret",
      JWT_REFRESH_SECRET: "test-refresh-secret",
      JWT_CUSTOMER_SECRET: "test-customer-secret",
      VAULT_KEY: "a".repeat(64),
      INTERNAL_PROXY_SECRET: "test-internal-secret",
      NODE_ENV: "test",
    },
    testTimeout: 30000,
  },
});

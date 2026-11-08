import { Worker } from "bullmq";
import { connectDb } from "./db/connect.js";
import { logger } from "./lib/logger.js";
import { maintenanceQueue, queueConnection, type NotificationJob } from "./jobs/queues.js";
import { processNotification, releaseExpiredOrders, monthlyBilling, dunning, domainHealth } from "./jobs/processors.js";

async function main() {
  await connectDb();

  new Worker<NotificationJob>("notifications", (job) => processNotification(job.data), { connection: queueConnection, concurrency: 10 })
    .on("failed", (job, err) => logger.error({ err, job: job?.name }, "Notification job failed"));

  const handlers: Record<string, () => Promise<unknown>> = {
    "release-expired-orders": releaseExpiredOrders,
    "monthly-billing": monthlyBilling,
    dunning,
    "domain-health": domainHealth,
  };
  new Worker("maintenance", async (job) => handlers[job.name]?.(), { connection: queueConnection, concurrency: 1 })
    .on("failed", (job, err) => logger.error({ err, job: job?.name }, "Maintenance job failed"));

  // Repeatable schedules (times in IST).
  await maintenanceQueue().upsertJobScheduler("release-expired-orders", { every: 5 * 60_000 }, { name: "release-expired-orders" });
  await maintenanceQueue().upsertJobScheduler("monthly-billing", { pattern: "0 2 1 * *", tz: "Asia/Kolkata" }, { name: "monthly-billing" });
  await maintenanceQueue().upsertJobScheduler("dunning", { pattern: "0 10 * * *", tz: "Asia/Kolkata" }, { name: "dunning" });
  await maintenanceQueue().upsertJobScheduler("domain-health", { pattern: "0 */6 * * *", tz: "Asia/Kolkata" }, { name: "domain-health" });
  logger.info("Worker running");
}

main().catch((err) => {
  logger.fatal({ err }, "Worker failed to start");
  process.exit(1);
});

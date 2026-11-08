import { Queue } from "bullmq";
import { env } from "../config/env.js";

const connection = { url: env.REDIS_URL };

export type NotificationJob =
  | { type: "order_placed"; tenantId: string; orderId: string }
  | { type: "order_status"; tenantId: string; orderId: string; status: string }
  | { type: "cod_confirm_request"; tenantId: string; orderId: string; confirmUrl: string }
  | { type: "otp"; tenantId: string; phone: string; code: string; storeName: string }
  | { type: "meta_purchase"; tenantId: string; orderId: string };

// Queues are created lazily so importing this file never opens a Redis connection by itself.
let _notifications: Queue<NotificationJob> | undefined;
let _maintenance: Queue | undefined;

export const notificationsQueue = () =>
  (_notifications ??= new Queue<NotificationJob>("notifications", {
    connection,
    defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 },
  }));

export const maintenanceQueue = () =>
  (_maintenance ??= new Queue("maintenance", { connection, defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 } }));

export const enqueueNotification = (job: NotificationJob) => notificationsQueue().add(job.type, job);
export { connection as queueConnection };

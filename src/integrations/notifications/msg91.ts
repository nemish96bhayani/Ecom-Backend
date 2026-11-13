import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

/**
 * MSG91 SMS (DLT) adapter — enabled with MESSAGING_PROVIDER=msg91.
 *
 * Setup (needs your own MSG91 account):
 *  1. Register your sender ID (header) and every message template on the DLT portal, then add them in MSG91.
 *  2. Set MSG91_AUTH_KEY.
 *  3. Set MSG91_TEMPLATES to a JSON map of our template names to MSG91 template ids, e.g.
 *     {"otp":"65f...","order_placed":"65f...","cod_confirm":"65f...","order_shipped":"65f..."}
 *     Template variables are sent with the same names we use (code, store, name, order, total, link, text).
 *
 * Verify the request shape against MSG91's current Flow API docs before going live.
 * WhatsApp needs a separate approved BSP integration; until then WhatsApp messages are sent as SMS
 * when an SMS template with the same name exists.
 */
const FLOW_URL = "https://control.msg91.com/api/v5/flow";

function templateMap(): Record<string, string> {
  try {
    return env.MSG91_TEMPLATES ? JSON.parse(env.MSG91_TEMPLATES) : {};
  } catch {
    logger.error("MSG91_TEMPLATES is not valid JSON");
    return {};
  }
}

export async function sendViaMsg91(phone: string, template: string, vars: Record<string, string>) {
  const templateId = templateMap()[template];
  if (!templateId) {
    // Don't fail the whole job for a template that hasn't been registered yet.
    logger.warn({ template }, "[msg91] no DLT template id configured for this message; skipped");
    return;
  }
  const res = await fetch(FLOW_URL, {
    method: "POST",
    headers: { authkey: env.MSG91_AUTH_KEY ?? "", "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ template_id: templateId, recipients: [{ mobiles: `91${phone}`, ...vars }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Throwing lets BullMQ retry with backoff.
    throw new Error(`MSG91 responded ${res.status} for template ${template}`);
  }
}

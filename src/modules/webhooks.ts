import express, { Router } from "express";
import { runAsTenant, runWithoutTenant } from "../db/tenantContext.js";
import { WebhookEvent } from "../models/platform.js";
import { Order, type OrderStatus } from "../models/orders.js";
import { getPaymentProvider } from "../integrations/payments/index.js";
import { getShippingProvider } from "../integrations/shipping/index.js";
import { markOrderPaid, transitionOrder, canTransition } from "../services/orders.js";
import { logger } from "../lib/logger.js";

const router = Router();
export default router;

/** Records the event; returns false if it was already processed (idempotency). */
async function firstTime(provider: string, eventKey: string, tenantId: string, payload: unknown) {
  try {
    await runWithoutTenant("webhook", () => WebhookEvent.create({ provider, eventKey, tenantId, payload }));
    return true;
  } catch (e: any) {
    if (e?.code === 11000) return false;
    throw e;
  }
}

// Webhooks need the exact raw body for signature checks.
const raw = express.raw({ type: "*/*", limit: "1mb" });

router.post("/api/v1/webhooks/payments/:provider/:tenantId", raw, async (req, res) => {
  const { tenantId } = req.params;
  if (!/^[a-f0-9]{24}$/.test(tenantId)) return res.status(404).end();
  try {
    const provider = await getPaymentProvider(tenantId);
    const rawBody = req.body as Buffer;
    if (!provider.verifyWebhook(rawBody, req.headers)) {
      logger.warn({ tenantId }, "Payment webhook signature failed");
      return res.status(401).end();
    }
    const body = JSON.parse(rawBody.toString("utf8"));
    const evt = provider.parseWebhook(body);
    if (!evt) return res.status(200).json({ ignored: true });
    if (!(await firstTime(provider.name, evt.eventKey, tenantId, body))) return res.status(200).json({ duplicate: true });

    await runAsTenant(tenantId, async () => {
      const order = await Order.findOne({ "payment.providerOrderId": evt.providerOrderId });
      if (!order) return logger.warn({ tenantId, evt }, "Webhook for unknown order");
      if (evt.status === "paid") await markOrderPaid(String(order._id), evt.paymentId);
      else if (evt.status === "failed" && order.status === "pending_payment") {
        order.payment!.status = "failed";
        await order.save();
        await transitionOrder(String(order._id), "payment_failed", { by: "payment", note: "Payment failed or was abandoned" });
      }
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err, tenantId }, "Payment webhook error");
    res.status(500).end(); // gateway will retry
  }
});

router.post("/api/v1/webhooks/shipping/:provider/:tenantId", express.json({ limit: "1mb" }), async (req, res) => {
  const { tenantId } = req.params;
  if (!/^[a-f0-9]{24}$/.test(tenantId)) return res.status(404).end();
  try {
    const provider = await getShippingProvider(tenantId);
    if (!provider.verifyWebhook(req.headers)) return res.status(401).end();
    const evt = provider.parseWebhook(req.body);
    if (!evt) return res.status(200).json({ ignored: true });
    if (!(await firstTime(provider.name, `${provider.name}:${evt.awb}:${evt.status}:${evt.at.toISOString()}`, tenantId, req.body))) return res.json({ duplicate: true });

    await runAsTenant(tenantId, async () => {
      const order = await Order.findOne({ "shipment.awb": evt.awb });
      if (!order) return;
      order.shipment!.status = evt.status;
      order.shipment!.events.push({ status: evt.status, location: evt.location, at: evt.at });
      await order.save();
      const map: Partial<Record<typeof evt.normalized, OrderStatus>> = { shipped: "shipped", in_transit: "shipped", delivered: "delivered", rto: "rto" };
      const target = map[evt.normalized];
      if (!target || target === order.status) return;
      let from = order.status as OrderStatus;
      if (target === "delivered" && from !== "shipped" && canTransition(from, "shipped")) {
        await transitionOrder(String(order._id), "shipped", { by: "courier" });
        from = "shipped";
      }
      if (canTransition(from, target)) await transitionOrder(String(order._id), target, { by: "courier", note: evt.status });
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, tenantId }, "Shipping webhook error");
    res.status(500).end();
  }
});

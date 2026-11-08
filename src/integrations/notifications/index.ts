import nodemailer from "nodemailer";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined })
  : null;

export async function sendEmail(to: string, subject: string, html: string, from?: string) {
  if (!transport) {
    logger.info({ to, subject }, "[email:dev] SMTP not configured – email logged instead of sent");
    return;
  }
  await transport.sendMail({ from: from ?? env.MAIL_FROM, to, subject, html });
}

/**
 * SMS / WhatsApp. India requires DLT-registered SMS templates and an approved WhatsApp
 * Business API provider (e.g. Gupshup, Interakt, MSG91). Plug the provider in here.
 */
export async function sendMessage(channel: "sms" | "whatsapp", phone: string, template: string, vars: Record<string, string>) {
  if (env.MESSAGING_PROVIDER === "log") {
    logger.info({ channel, phone, template, vars }, "[messaging:dev] message logged instead of sent");
    return;
  }
  throw new Error("Custom messaging provider not implemented – add your BSP / SMS gateway call here");
}

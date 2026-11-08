import { env } from "../../config/env.js";
import { sha256 } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";

/** Meta Conversions API – server-side Purchase event (works even when browser pixels are blocked). */
export async function sendMetaPurchase(opts: {
  pixelId: string;
  accessToken: string;
  eventId: string;
  valuePaise: number;
  phone?: string;
  email?: string;
  sourceUrl: string;
  fbclid?: string;
}) {
  const normPhone = opts.phone ? opts.phone.replace(/\D/g, "").replace(/^(?!91)(\d{10})$/, "91$1") : undefined;
  const body = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: opts.eventId, // de-duplicates with the browser pixel event
        action_source: "website",
        event_source_url: opts.sourceUrl,
        user_data: {
          ph: normPhone ? [sha256(normPhone)] : undefined,
          em: opts.email ? [sha256(opts.email.trim().toLowerCase())] : undefined,
          fbc: opts.fbclid ? `fb.1.${Date.now()}.${opts.fbclid}` : undefined,
        },
        custom_data: { currency: "INR", value: opts.valuePaise / 100 },
      },
    ],
  };
  const res = await fetch(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${opts.pixelId}/events?access_token=${encodeURIComponent(opts.accessToken)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) logger.warn({ status: res.status, body: await res.text() }, "Meta CAPI event failed");
}

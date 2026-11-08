// POST /api/school/mollie-webhook  (body: id=tr_xxx, form-encoded, sent by Mollie on every status change)
// The body only carries the payment id: the payment itself is always reloaded from the Mollie API,
// never trusted from the request. The status is logged; once paid, the payment joins the back-office funnel
// (keyed by a hash of the payment id: no link to a browsing visit; not with metadata.nostats, see register.js)
// and the student gets a confirmation email; metadata.mail records that it was sent.
import crypto from "node:crypto";
import { SCHOOL, mollie, mollieKey, send, mapStatus, siteOrigin } from "../_lib.js";
import { sendRegistrationEmail } from "../_email.js";
import { insertFunnelEvent } from "../_track.js";

async function readPaymentId(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return String(req.body.id || "");
  let raw = typeof req.body === "string" || Buffer.isBuffer(req.body) ? String(req.body) : "";
  if (!raw && typeof req.on === "function") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    raw = Buffer.concat(chunks).toString("utf8");
  }
  return new URLSearchParams(raw).get("id") || "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false });
  const id = await readPaymentId(req);
  // Unknown or foreign ids still get a 200, so the endpoint does not reveal which payments exist.
  if (!/^tr_[A-Za-z0-9]{6,30}$/.test(id) || !mollieKey()) return send(res, 200, { ok: true });
  try {
    const p = await mollie(`/payments/${id}`);
    const m = p.metadata || {};
    if (m.app === SCHOOL.app) {
      const status = mapStatus(p);
      console.log("[webhook]", p.id, m.ref, p.mode, p.status, "->", status);
      if (status === "paid" && !m.nostats) {
        // Funnel "Paiement réussi", once per payment. The measurement must never make the webhook fail.
        // nostats: registered from a country the statistics leave out (EXCLUDED_COUNTRIES in api/_track.js).
        try {
          const key = crypto.createHash("sha256").update(p.id).digest("base64url").slice(0, 22);
          await insertFunnelEvent(p.mode, key, "paid", m.lang);
        } catch (err) {
          console.error("[webhook] funnel event not recorded", p.id, err?.code, err?.message);
        }
      }
      if (status === "paid" && !m.mail) {
        // A Resend failure throws: the 500 below makes Mollie call again later.
        if (await sendRegistrationEmail(p, siteOrigin(req))) {
          console.log("[webhook] confirmation email sent", p.id, m.ref);
          await mollie(`/payments/${p.id}`, {
            method: "PATCH",
            body: { metadata: { ...m, mail: new Date().toISOString() } },
          }).catch((err) => console.error("[webhook] could not flag email as sent", p.id, err?.status, err?.message));
        }
      }
    }
    return send(res, 200, { ok: true });
  } catch (err) {
    if (err?.status === 404) return send(res, 200, { ok: true });
    // Mollie retries non-2xx answers, which is what we want if its API or Resend was briefly unreachable.
    console.error("[webhook] error", err?.status, err?.message);
    return send(res, 500, { ok: false });
  }
}

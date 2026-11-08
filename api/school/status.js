// GET /api/school/status?pid=tr_xxx  → status of a registration payment (for the confirmation page)
import { SCHOOL, mollie, mollieKey, send, mapStatus } from "../_lib.js";
import { sql } from "../_db.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { status: "not_found" });
  const url = new URL(req.url, "http://x");
  const pid = url.searchParams.get("pid") || "";
  if (!/^tr_[A-Za-z0-9]{6,30}$/.test(pid) || !mollieKey()) return send(res, 200, { status: "not_found" });
  try {
    const p = await mollie(`/payments/${pid}`);
    const m = p.metadata || {};
    if (m.app !== SCHOOL.app) return send(res, 200, { status: "not_found" });
    let hasAccount = false;
    try {
      hasAccount = (await sql`SELECT 1 FROM students WHERE payment_id = ${p.id}`).length > 0;
    } catch (err) {
      console.error("[status] database error", err?.message);
    }
    return send(res, 200, {
      status: mapStatus(p),
      first_name: m.fn,
      email: m.em,
      university_name: m.uni,
      intake_name: m.intake,
      public_ref: m.ref,
      amount_paid_cents: p.status === "paid" ? Math.round(Number(p.amount.value) * 100) : undefined,
      currency: p.amount?.currency,
      paid_at: p.paidAt,
      lang: m.lang === "fr" ? "fr" : "en",
      has_account: hasAccount,
    });
  } catch (err) {
    if (err?.status === 404) return send(res, 200, { status: "not_found" });
    console.error("[status] Mollie error", err?.status, err?.message);
    return send(res, 502, { status: "not_found" });
  }
}

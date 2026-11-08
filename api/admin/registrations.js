// GET /api/admin/registrations → every L'École registration, read from Mollie payments,
// with the student's progress from the database (account, modules, final test, certificate).
import { SCHOOL, mollie, mollieKey, mollieLegacyKey, send, verifyAdminToken, mapStatus } from "../_lib.js";
import { sql } from "../_db.js";

/** Student-space progress per Mollie payment id, in one query. Empty if the database is unavailable. */
async function progressByPayment(paymentIds) {
  if (!paymentIds.length) return new Map();
  try {
    const rows = await sql`
      SELECT s.payment_id,
             (SELECT count(*) FROM module_progress mp WHERE mp.student_id = s.id)::int AS modules_done,
             (SELECT max(ta.score) FROM test_attempts ta WHERE ta.student_id = s.id)::int AS best_score,
             (SELECT max(ta.total) FROM test_attempts ta WHERE ta.student_id = s.id)::int AS test_total,
             c.code AS certificate_code
      FROM students s LEFT JOIN certificates c ON c.student_id = s.id
      WHERE s.payment_id = ANY(${paymentIds})`;
    return new Map(rows.map((r) => [r.payment_id, r]));
  } catch (err) {
    console.error("[admin] database error", err?.code, err?.message);
    return new Map();
  }
}

export default async function handler(req, res) {
  if (!verifyAdminToken(req)) return send(res, 401, { error: "unauthorized" });
  if (!mollieKey()) return send(res, 503, { error: "payments_unavailable" });
  const rows = [];
  try {
    // The current Mollie account, then the previous one (registrations paid before the switch).
    for (const key of [mollieKey(), mollieLegacyKey()].filter(Boolean)) {
      let next = "/payments?limit=250";
      let pages = 0;
      while (next && pages < 20) {
        const page = await mollie(next, { key });
        for (const p of page._embedded?.payments ?? []) {
          const m = p.metadata || {};
          if (m.app !== SCHOOL.app) continue;
          rows.push({
            id: p.id,
            public_ref: m.ref,
            first_name: m.fn,
            last_name: m.ln,
            email: m.em,
            phone_e164: m.ph,
            university: m.uni,
            intake: m.intake,
            major: m.major ?? null,
            graduation_year: m.grad ?? null,
            heard_about: m.heard ?? null,
            utm_source: m.utm ?? null,
            marketing_opt_in: m.mkt === 1,
            terms_version: m.terms ?? null,
            waiver_at: m.waiver ?? null,
            status: mapStatus(p),
            amount_paid_cents: p.status === "paid" ? Math.round(Number(p.amount.value) * 100) : null,
            currency: p.amount?.currency ?? "EUR",
            paid_at: p.paidAt ?? null,
            created_at: p.createdAt,
            mode: p.mode,
          });
        }
        next = page._links?.next?.href ?? null;
        pages += 1;
      }
    }
    const progress = await progressByPayment(rows.map((r) => r.id));
    for (const r of rows) {
      const p = progress.get(r.id);
      r.account = Boolean(p);
      r.modules_done = p?.modules_done ?? 0;
      r.best_score = p?.best_score ?? null;
      r.test_total = p?.test_total ?? null;
      r.certificate_code = p?.certificate_code ?? null;
    }
    return send(res, 200, { rows });
  } catch (err) {
    console.error("[admin] Mollie error", err?.status, err?.message);
    return send(res, 502, { error: "mollie_error" });
  }
}

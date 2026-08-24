// Naming and totalling the money a guest pays on top of the room rate.
//
// This is a compliance surface, not a copy decision. A tax is a government
// levy; a resort/destination/amenity fee is revenue the hotel keeps. Calling
// the second one a "tax" misstates who is charging the guest and why, which is
// the substance of the FTC's junk-fee rule and of several state AG actions
// against hotel fee display. So nothing here guesses: every label is derived
// from descriptions observed in live responses, and anything unrecognised is
// reported in neutral wording rather than assigned to a category.
//
// ---------------------------------------------------------------------------
// WHAT THE DATA SHOWED  (analysis/fees.py, analysis/fees2.py — 1,336 fee line
// items across 5 hotels x stays of 2, 4 and 7 nights)
//
// Each charge was tested against three hypotheses by measuring which stayed
// stable as stay length changed: a fixed amount (per stay), amount/nights
// (per night), or amount/roomRate (a percentage).
//
//   description           basis        reading
//   'TAX'                 PERCENTAGE   13.00% of room, identical across all 5
//                                      hotels, coefficient of variation 0.0000
//   'SALESTAX'            PERCENTAGE   4.12%
//   'LODGING'             PERCENTAGE   5.20%
//   'taxes'               PERCENTAGE   11.50%
//   'RESORT'              PER NIGHT    flat $20/night, CV 0.0000
//   'Amenity Fee'         PER NIGHT    flat per night
//   'Destination charge'  PER NIGHT    flat per night
//   'OTHERS'              PERCENTAGE   22.16% — but the name asserts nothing,
//                                      so it is still labelled neutrally
//
// The 13.00% on 'TAX' is exactly Buncombe County NC: 4.75% state + 2.25% local
// sales + 6% occupancy. That it reproduces to four decimal places across five
// unrelated hotels is what makes "tax" a defensible word for that one.
//
// CRITICAL ARITHMETIC: the amount LiteAPI returns ALREADY covers the whole
// stay. Verified on a per-night resort fee: $40.00 on a 2-night stay and
// $140.00 on a 7-night stay of the same rate — exactly $20/night, already
// multiplied. Earlier analysis code multiplied per-night fees by nights again
// and inflated guest totals; never do that. `basis` below is for WORDING
// ("$20 per night"), never for recomputing the total.
// ---------------------------------------------------------------------------

export type FeeBasis = "percentage" | "per-night" | "per-stay" | "unknown";

export type FeeLine = {
  /** Guest-facing wording. Never says "tax" unless the charge is one. */
  label: string;
  /** Whole-stay amount, exactly as returned. Already covers every night. */
  amount: number;
  /** True only for government levies. Drives wording, never arithmetic. */
  isTax: boolean;
  basis: FeeBasis;
};

type Rule = { rx: RegExp; label: string; isTax: boolean; basis: FeeBasis };

// Ordered: the most specific description wins. Every entry corresponds to a
// string actually observed in a live response.
const RULES: Rule[] = [
  // --- government levies, all confirmed as a stable % of the room rate ---
  { rx: /^sales\s*tax$|^salestax$/i, label: "sales tax", isTax: true, basis: "percentage" },
  { rx: /^lodging$|lodging\s*tax/i, label: "lodging tax", isTax: true, basis: "percentage" },
  { rx: /occupanc/i, label: "occupancy tax", isTax: true, basis: "percentage" },
  { rx: /city\s*tax|municipal/i, label: "city tax", isTax: true, basis: "percentage" },
  { rx: /tourism/i, label: "tourism tax", isTax: true, basis: "percentage" },
  { rx: /\bvat\b|value added/i, label: "VAT", isTax: true, basis: "percentage" },
  { rx: /government/i, label: "government tax", isTax: true, basis: "percentage" },

  // --- hotel revenue. None of these may be called a tax. ---
  { rx: /resort/i, label: "resort fee", isTax: false, basis: "per-night" },
  { rx: /destination/i, label: "destination fee", isTax: false, basis: "per-night" },
  { rx: /amenity/i, label: "amenity fee", isTax: false, basis: "per-night" },
  { rx: /facilit/i, label: "facility fee", isTax: false, basis: "per-night" },
  { rx: /clean/i, label: "cleaning fee", isTax: false, basis: "per-stay" },
  { rx: /service\s*charge|^service/i, label: "service charge", isTax: false, basis: "percentage" },
  { rx: /parking/i, label: "parking fee", isTax: false, basis: "per-night" },

  // --- mixed bag: the supplier is bundling both, so say both ---
  { rx: /taxes\s*(and|&)\s*fees/i, label: "taxes and fees", isTax: false, basis: "unknown" },

  // --- a bare "tax"/"taxes" string, confirmed percentage-based ---
  { rx: /^taxe?s?$/i, label: "tax", isTax: true, basis: "percentage" },
];

// Descriptions that name nothing. 'OTHERS' and '' both appear in live data;
// neither justifies calling the money a tax or a specific fee.
function neutral(amount: number): FeeLine {
  return { label: "charge due at the property", amount, isTax: false, basis: "unknown" };
}

export function classifyFee(description: string, amount: number): FeeLine {
  const d = (description || "").trim();
  if (!d || /^others?$/i.test(d) || /^fees?$/i.test(d)) return neutral(amount);
  for (const r of RULES) {
    if (r.rx.test(d)) return { label: r.label, amount, isTax: r.isTax, basis: r.basis };
  }
  // Contains "tax" but matched no specific rule — e.g. "State Tax". Treating
  // it as a tax is safe here because the supplier used the word itself; the
  // risk we guard against is the reverse (calling a fee a tax).
  if (/tax/i.test(d)) return { label: d.toLowerCase(), amount, isTax: true, basis: "percentage" };
  if (/fee|charge/i.test(d)) return { label: d.toLowerCase(), amount, isTax: false, basis: "unknown" };
  return neutral(amount);
}

/** Raw shape of one `retailRate.taxesAndFees` entry. */
export type RawFee = { included?: boolean; description?: string; amount?: number };

// ---------------------------------------------------------------------------
// THE HOTEL'S OWN SCHEMA BEATS THE SUPPLIER'S WORDING
//
// GET /data/hotel/{hotelId}/tax-schema returns the property's normalized
// levies. It is the only non-supplier account of what a hotel actually charges,
// and it resolves a case the supplier text cannot. Measured live on Kimpton
// Arras, one hotel, one date range, 12 plans:
//
//   Kimpton's schema:  Destination Charge  $20/night  INCLUDED
//                      Tax                 13%        EXCLUDED
//
//   supplier A (9 plans)  "Taxes and Fees" $80.73 incl + "Taxes and Fees" $40 EXCL
//   supplier B (2 plans)  "Destination charge" $40 incl + "TAX" $73.04 EXCL
//   supplier C (2 plans)  "destination charge" $38.46 incl + "Tax" $95.37 incl
//
// Supplier A's excluded $40 is $20/night x 2 — the DESTINATION CHARGE, filed
// under the words "Taxes and Fees". Calling that $40 a tax is exactly the
// misstatement this module exists to prevent, and no amount of reading the
// supplier's string can catch it. Matching the amount against the schema does.
//
// Only FIXED entries are matched. Percentage levies are excluded on purpose:
// the base they apply to is not knowable from the response (supplier B's $73.04
// is 14.0% of the rate net of the fee, not the schema's 13%), so a percentage
// "match" would be a guess wearing a citation.
// ---------------------------------------------------------------------------
export type TaxSchemaEntry = {
  name?: string;
  included?: boolean;
  type?: string; // "fixed" | "percentage"
  fixedAmount?: number | null;
  percentageRate?: number | null;
  perAdult?: boolean;
  perNight?: boolean;
};

export type FeeContext = {
  nights?: number;
  adults?: number;
  schema?: TaxSchemaEntry[] | null;
};

// A supplier description that asserts nothing specific, so the schema is
// allowed to overrule it. A description that names a real category ("RESORT",
// "government tax") is left alone — the supplier is closer to that contract
// than a hotel-level schema is.
const AMBIGUOUS = /^$|^others?$|^fees?$|taxes\s*(and|&)\s*fees|^mandatory|^local\s*(fees|charges)$|^localcharges$/i;

function resolveFromSchema(amount: number, ctx: FeeContext): TaxSchemaEntry | null {
  const nights = Math.max(1, Math.round(ctx.nights ?? 1));
  const adults = Math.max(1, Math.round(ctx.adults ?? 1));
  const hits = (ctx.schema ?? []).filter((e) => {
    if (e?.type !== "fixed" || !e.fixedAmount) return false;
    const expected = e.fixedAmount * (e.perNight ? nights : 1) * (e.perAdult ? adults : 1);
    return Math.abs(expected - amount) < 0.01;
  });
  // Ambiguity is not resolved by picking one: two entries of the same amount
  // mean the line could be either, and neither name is then defensible.
  return hits.length === 1 ? hits[0] : null;
}

export type FeeSummary = {
  /** Charges collected by the property, not in the price we display. */
  dueAtProperty: FeeLine[];
  /** Their total, already covering the whole stay. */
  dueAtPropertyTotal: number;
  /** One honest sentence, or null when there is nothing to collect on site. */
  note: string | null;
};

export function summarizeFees(
  raw: RawFee[] | null | undefined,
  ctx: FeeContext = {},
): FeeSummary {
  const lines = (raw ?? [])
    .filter((f) => f?.included === false && (f.amount ?? 0) > 0)
    .map((f) => {
      const desc = (f.description ?? "").trim();
      const amount = f.amount ?? 0;
      // Only a description that names nothing may be overruled, and only by an
      // exact amount match against the property's own filed levies.
      if (AMBIGUOUS.test(desc)) {
        const entry = resolveFromSchema(amount, ctx);
        if (entry?.name) return classifyFee(entry.name, amount);
      }
      return classifyFee(desc, amount);
    });

  // NO multiplication by nights: the amounts already cover the stay.
  const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

  return { dueAtProperty: lines, dueAtPropertyTotal: total, note: buildNote(lines, total) };
}

// "Collected by the hotel at check-in" is LiteAPI's documented meaning of
// `included: false`, not our inference: the rates doc says of the flag that if
// false "they will need to pay this amount when they arrive at the property",
// and the tax-schema endpoint doc says "Excluded taxes are typically collected
// at the hotel". Verified live 2026-08-19 on the transaction itself, which is
// the part that actually binds us: an offer whose excluded lines were TAX
// $60.19 + government tax $6 prebooked at price 343.92 — exactly
// `retailRate.total`, with neither line added. So we really do not collect
// them, and saying we did would misstate the price in the other direction.
function buildNote(lines: FeeLine[], total: number): string | null {
  if (!lines.length || total <= 0) return null;
  const money = `$${Math.round(total)}`;

  if (lines.length === 1) {
    return `${money} ${lines[0].label} collected by the hotel at check-in`;
  }

  const anyTax = lines.some((l) => l.isTax);
  const anyFee = lines.some((l) => !l.isTax);
  // Only claim the categories actually present. "taxes and fees" when it is
  // purely fees would be the same misstatement in aggregate form.
  const what = anyTax && anyFee ? "taxes and fees" : anyTax ? "taxes" : "fees";
  return `${money} ${what} collected by the hotel at check-in`;
}

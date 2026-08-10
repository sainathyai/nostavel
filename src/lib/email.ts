// Transactional email via the Resend HTTP API directly (no SDK dependency —
// the same REST endpoint next-auth's Resend provider uses under the hood).
// Everything here is best-effort: a failed send is logged and swallowed so it
// can never break a booking that has already been charged and confirmed.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function fromAddress(): string {
  return process.env.AUTH_EMAIL_FROM || "Nostavel <onboarding@resend.dev>";
}

function appUrl(): string {
  return (
    process.env.APP_URL ||
    process.env.AUTH_URL ||
    process.env.NEXTAUTH_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

export async function sendEmail(opts: { to: string; subject: string; html: string }): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn("[email] RESEND_API_KEY not set — skipping send to", opts.to);
    return false;
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromAddress(), to: opts.to, subject: opts.subject, html: opts.html }),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[email] Resend responded", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.error("[email] send failed:", (e as Error).message);
    return false;
  }
}

export type ConfirmationEmail = {
  to: string;
  bookingId: string;
  humanRef: string;
  guestName: string;
  hotelName: string;
  hotelCity?: string;
  roomTitle: string;
  board?: string;
  checkinDate: string; // YYYY-MM-DD
  checkoutDate: string; // YYYY-MM-DD
  nights: number;
  amountMinor: number;
  currency: string;
  refundLine: string;
  supplierRef?: string | null;
};

function money(minor: number, currency: string): string {
  const sym = currency === "USD" ? "$" : currency + " ";
  return `${sym}${(minor / 100).toFixed(2)}`;
}

function longDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// Brand tokens, inlined (email clients ignore <style>/external CSS).
const INK = "#211b2b";
const SOFT = "#6a6172";
const BRASS = "#b9772b";
const LINE = "#e2d8c7";
const PARCHMENT = "#faf7f0";
const SURFACE = "#ffffff";

function row(label: string, value: string): string {
  return `
    <tr>
      <td style="padding:7px 0;color:${SOFT};font-size:14px;">${label}</td>
      <td style="padding:7px 0;color:${INK};font-size:14px;text-align:right;font-weight:500;">${value}</td>
    </tr>`;
}

export function confirmationHtml(e: ConfirmationEmail): string {
  const url = `${appUrl()}/book/${e.bookingId}/confirmation`;
  const dates = `${longDate(e.checkinDate)} &rarr; ${longDate(e.checkoutDate)}`;
  const nights = `${e.nights} ${e.nights === 1 ? "night" : "nights"}`;
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:${PARCHMENT};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PARCHMENT};padding:28px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${SURFACE};border:1px solid ${LINE};border-radius:16px;overflow:hidden;">
        <!-- header -->
        <tr><td style="padding:22px 28px;border-bottom:1px solid ${LINE};">
          <span style="font-size:20px;font-weight:600;color:${INK};">Nosta<span style="color:${BRASS};font-style:italic;">vel</span></span>
        </td></tr>
        <!-- hero -->
        <tr><td style="padding:30px 28px 8px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:${INK};">You&rsquo;re booked</div>
          <div style="margin-top:6px;color:${SOFT};font-size:14px;">Confirmation</div>
          <div style="margin-top:2px;font-size:20px;font-weight:700;letter-spacing:0.02em;color:${BRASS};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${e.humanRef}</div>
        </td></tr>
        <!-- details -->
        <tr><td style="padding:14px 28px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td colspan="2" style="padding:8px 0 2px;font-size:17px;font-weight:600;color:${INK};">${e.hotelName}${e.hotelCity ? `<span style="color:${SOFT};font-weight:400;"> &middot; ${e.hotelCity}</span>` : ""}</td></tr>
            ${row("Guest", e.guestName)}
            ${row("Room", e.board ? `${e.roomTitle} &middot; ${e.board}` : e.roomTitle)}
            ${row("Dates", `${dates} &middot; ${nights}`)}
            ${row("Cancellation", e.refundLine)}
            ${e.supplierRef ? row("Supplier ref", e.supplierRef) : ""}
          </table>
        </td></tr>
        <!-- total -->
        <tr><td style="padding:6px 28px 18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};">
            <tr>
              <td style="padding-top:14px;font-size:16px;font-weight:600;color:${INK};">Total paid</td>
              <td style="padding-top:14px;font-size:18px;font-weight:700;color:${INK};text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${money(e.amountMinor, e.currency)}</td>
            </tr>
          </table>
        </td></tr>
        <!-- cta -->
        <tr><td style="padding:4px 28px 28px;">
          <a href="${url}" style="display:inline-block;background:${BRASS};color:#1a1410;font-size:14px;font-weight:600;text-decoration:none;padding:11px 20px;border-radius:9px;">View your booking</a>
        </td></tr>
      </table>
      <div style="max-width:520px;margin-top:16px;color:${SOFT};font-size:12px;text-align:center;line-height:1.5;">
        A concierge, not a search engine. This is a demonstration booking made in a secure sandbox.
      </div>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendBookingConfirmation(e: ConfirmationEmail): Promise<boolean> {
  return sendEmail({
    to: e.to,
    subject: `You're booked · ${e.hotelName} (${e.humanRef})`,
    html: confirmationHtml(e),
  });
}

// One-time verification code for the guest "find my trip" flow.
function guestCodeHtml(code: string): string {
  const spaced = code.split("").join("&nbsp;");
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:${PARCHMENT};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PARCHMENT};padding:28px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:${SURFACE};border:1px solid ${LINE};border-radius:16px;overflow:hidden;">
        <tr><td style="padding:22px 28px;border-bottom:1px solid ${LINE};">
          <span style="font-size:20px;font-weight:600;color:${INK};">Nosta<span style="color:${BRASS};font-style:italic;">vel</span></span>
        </td></tr>
        <tr><td style="padding:30px 28px 8px;text-align:center;">
          <div style="font-size:20px;font-weight:700;color:${INK};">Your verification code</div>
          <div style="margin-top:6px;color:${SOFT};font-size:14px;">Enter this to pull up your trip.</div>
          <div style="margin:20px auto 6px;display:inline-block;background:${PARCHMENT};border:1px solid ${LINE};border-radius:12px;padding:14px 22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:700;letter-spacing:0.12em;color:${BRASS};">${spaced}</div>
          <div style="margin-top:10px;color:${SOFT};font-size:13px;">This code expires in 10 minutes.</div>
        </td></tr>
        <tr><td style="padding:8px 28px 28px;">
          <div style="color:${SOFT};font-size:12px;line-height:1.5;text-align:center;">
            If you didn&rsquo;t ask to look up a trip, you can ignore this email. No one can see your booking without this code.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendGuestCode(to: string, code: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: `${code} is your Nostavel verification code`,
    html: guestCodeHtml(code),
  });
}

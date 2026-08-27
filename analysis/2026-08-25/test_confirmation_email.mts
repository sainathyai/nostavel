/**
 * Real delivery test for the Phase 1 email fix: sends the actual confirmation
 * template via the real Resend API, to prove nostavel.com's now-verified
 * domain delivers to a genuinely non-owner inbox (Resend allowed sends to the
 * account owner even pre-verification, so that alone would prove nothing).
 *
 *     npx tsx analysis/2026-08-25/test_confirmation_email.mts help@nostavel.com support@nostavel.com
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const { sendBookingConfirmation } = await import("../../src/lib/email");

const recipients = process.argv.slice(2);
if (!recipients.length) {
  console.error("Usage: npx tsx analysis/2026-08-25/test_confirmation_email.mts <email> [email...]");
  process.exit(1);
}

for (const to of recipients) {
  const ok = await sendBookingConfirmation({
    to,
    bookingId: "test-delivery-check",
    humanRef: "NSTVL-TEST01",
    guestName: "Test Guest",
    hotelName: "Chicken Ranch Casino Resort",
    hotelCity: "Jamestown",
    roomTitle: "Room, 1 King Bed, Balcony",
    board: "Room Only",
    checkinDate: "2026-10-08",
    checkoutDate: "2026-10-10",
    nights: 2,
    amountMinor: 49865,
    currency: "USD",
    refundLine: "Free cancellation until Oct 6",
    supplierRef: "TEST-REF",
  });
  console.log(`  ${to}: ${ok ? "sent" : "FAILED — see stderr above"}`);
}

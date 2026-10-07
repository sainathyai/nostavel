ALTER TYPE "public"."booking_status" ADD VALUE 'confirming' BEFORE 'confirmed';--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "prebooked_at" timestamp with time zone;--> statement-breakpoint
-- Backfill, added by hand to a generated file (NOS-46).
--
-- Without it every row that already exists has a null prebooked_at, and the
-- hold rule reads null as "still held" on purpose - so live holds would never
-- be released and the sweeper would silently stop doing its job for them.
--
-- created_at, not updated_at: prepareBooking inserts the row and then calls the
-- supplier within the same request, so created_at is within seconds of the real
-- hold. updated_at is the value NOS-46 is about getting away from.
--
-- Only rows that ever reached the supplier. A draft never had a hold, and
-- backdating one would invent a lapse that never happened.
UPDATE "bookings"
SET "prebooked_at" = "created_at"
WHERE "prebooked_at" IS NULL
  AND "status" IN ('prebooked', 'payment_pending', 'confirmed', 'cancelled', 'failed', 'expired');

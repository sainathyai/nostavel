DROP INDEX "cancellations_booking_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "cancellations_booking_unique" ON "cancellations" USING btree ("booking_id");
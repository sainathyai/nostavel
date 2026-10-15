CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"supplier_ref_id" text,
	"amount_minor" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"supplier_status" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refunds_booking_idx" ON "refunds" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_booking_supplier_ref_unique" ON "refunds" USING btree ("booking_id","supplier_ref_id");
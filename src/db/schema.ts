// Nostavel persistence layer.
//
// Design stance: LiteAPI is the source of truth for a booking's live status; THIS
// database is a durable ledger + mirror. Every row snapshots what was true at the
// moment it was written (price, cancellation policy, room/hotel detail) because
// supplier data changes underneath us. Money is stored as integer MINOR units
// (cents) plus an explicit currency — never floats. Card data is never stored;
// only the last4/brand LiteAPI hands back.

import {
  pgTable,
  pgEnum,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  date,
  uuid,
  char,
  doublePrecision,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* Identity (Auth.js Drizzle-adapter compatible)                       */
/* ------------------------------------------------------------------ */

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true, mode: "date" }),
  image: text("image"),
  phone: text("phone"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

// Booking lifecycle state machine.
export const bookingStatus = pgEnum("booking_status", [
  "draft", // row created, selection snapshotted, nothing sent to supplier
  "prebooked", // LiteAPI prebook succeeded, price + policy locked
  "payment_pending", // guest card charged via Payment SDK, awaiting book()
  "confirmed", // LiteAPI booking CONFIRMED
  "failed", // prebook or book failed
  "cancelled", // cancelled after confirmation
  "expired", // draft/prebook abandoned past TTL
]);

export const paymentStatus = pgEnum("payment_status", [
  "pending",
  "succeeded",
  "failed",
  "refunded",
]);

export const paymentMethod = pgEnum("payment_method", [
  "sdk", // LiteAPI Payment SDK — guest card, LiteAPI is merchant of record
  "wallet", // funded account wallet (ACC_CREDIT_CARD) — not used at F&F scope
]);

/* ------------------------------------------------------------------ */
/* Booking ledger (core)                                               */
/* ------------------------------------------------------------------ */

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Short human-facing reference shown to the guest, e.g. LNTRN-7QK2.
    humanRef: text("human_ref").notNull().unique(),
    // null => guest booking (no account). Set when a signed-in user books, or
    // backfilled when a guest later signs up with the same email.
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    // Nullable: a draft is created at prebook (before the guest form), so a guest
    // booking has no contact email yet. Enforced in code at the confirm step.
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    // Lead guest billing address (collected on the details step). { line1, city, state, zip }.
    billingAddress: jsonb("billing_address"),

    status: bookingStatus("status").notNull().default("draft"),

    // LiteAPI reference ids — the whole reason this table exists.
    prebookId: text("prebook_id"),
    liteapiBookingId: text("liteapi_booking_id"),
    transactionId: text("transaction_id"),
    // Per-transaction client secret from a usePaymentSdk prebook. Transient: it
    // scopes the browser card session, is read once by the checkout page, and is
    // cleared when the booking is confirmed. Never exposed beyond that page.
    paymentSecret: text("payment_secret"),

    // Snapshots (jsonb) — frozen at booking time, never re-fetched into these.
    hotelId: text("hotel_id").notNull(),
    hotelSnapshot: jsonb("hotel_snapshot").notNull(), // name, city, address, image, checkin/out
    offerId: text("offer_id"),
    boardName: text("board_name"),
    roomSnapshot: jsonb("room_snapshot"), // room name, beds, occupancy, amenities

    checkinDate: date("checkin_date").notNull(),
    checkoutDate: date("checkout_date").notNull(),
    nights: integer("nights").notNull(),
    adults: integer("adults").notNull().default(2),
    children: jsonb("children"), // array of ages

    currency: char("currency", { length: 3 }).notNull().default("USD"),
    amountTotalMinor: integer("amount_total_minor").notNull(), // what the guest paid
    amountSupplierMinor: integer("amount_supplier_minor"), // our cost -> margin
    taxesFeesMinor: integer("taxes_fees_minor").notNull().default(0),
    feesAtProperty: jsonb("fees_at_property"), // mandatory fees collected at hotel

    cancellationPolicy: jsonb("cancellation_policy"),
    refundableUntil: timestamp("refundable_until", { withTimezone: true, mode: "date" }),

    // Captured at prebook: supplier price can drift between search and prebook.
    priceChanged: boolean("price_changed").notNull().default(false),
    priceDiffPct: doublePrecision("price_diff_pct"),

    // Guards the book mutation against double-charge / double-book on retry.
    idempotencyKey: text("idempotency_key").notNull().unique(),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("bookings_user_idx").on(t.userId),
    index("bookings_email_idx").on(t.contactEmail),
    index("bookings_status_idx").on(t.status),
  ],
);

// One row per occupant name attached to a booking.
export const bookingGuests = pgTable(
  "booking_guests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    isLead: boolean("is_lead").notNull().default(false),
    roomIndex: integer("room_index").notNull().default(0),
  },
  (t) => [index("booking_guests_booking_idx").on(t.bookingId)],
);

// Payment records. Never stores a PAN — only the last4/brand LiteAPI returns.
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id"),
    method: paymentMethod("method").notNull().default("sdk"),
    status: paymentStatus("status").notNull().default("pending"),
    amountMinor: integer("amount_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    cardLast4: text("card_last4"),
    cardBrand: text("card_brand"),
    providerRaw: jsonb("provider_raw"), // raw SDK/book payment response for disputes
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("payments_booking_idx").on(t.bookingId)],
);

export const cancellations = pgTable(
  "cancellations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    liteapiCancellationId: text("liteapi_cancellation_id"),
    refundAmountMinor: integer("refund_amount_minor"),
    status: text("status").notNull().default("requested"),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("cancellations_booking_idx").on(t.bookingId)],
);

/* ------------------------------------------------------------------ */
/* Integrity & ops                                                     */
/* ------------------------------------------------------------------ */

// Append-only audit trail. Every state transition and every LiteAPI response
// lands here. Never UPDATE or DELETE rows — this is the reconciliation/dispute
// record of what actually happened, in order.
export const bookingEvents = pgTable(
  "booking_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // e.g. "prebook.ok", "payment.succeeded", "book.confirmed"
    payload: jsonb("payload"),
    actor: text("actor").notNull().default("system"), // system | user | webhook | reconciler
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("booking_events_booking_idx").on(t.bookingId)],
);

// Raw inbound LiteAPI callbacks, deduped by their external id.
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalId: text("external_id").unique(),
    type: text("type"),
    payload: jsonb("payload"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
  },
);

/* ------------------------------------------------------------------ */
/* Account features (near-future, cheap to reserve now)                */
/* ------------------------------------------------------------------ */

export const savedHotels = pgTable(
  "saved_hotels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hotelId: text("hotel_id").notNull(),
    snapshot: jsonb("snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("saved_hotels_user_hotel_idx").on(t.userId, t.hotelId)],
);

export const searchHistory = pgTable(
  "search_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    query: jsonb("query").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("search_history_user_idx").on(t.userId)],
);

/* ------------------------------------------------------------------ */
/* Inferred types for use across the app                               */
/* ------------------------------------------------------------------ */

export type User = typeof users.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
export type BookingGuest = typeof bookingGuests.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type BookingEvent = typeof bookingEvents.$inferSelect;

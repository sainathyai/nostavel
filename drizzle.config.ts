import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Next keeps secrets in .env.local; drizzle-kit runs outside Next so load it here.
config({ path: ".env.local" });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
  verbose: true,
  strict: true,
});

import { migrateToLatest } from "@typescript-on-rails/postgres";
import { referenceDatabase } from "../src/infra/database.js";
import { referenceMigrations } from "../src/infra/migrations.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_REQUIRED_FOR_MIGRATE");
const runtime = referenceDatabase(url);
try { console.log(await migrateToLatest(runtime.db, referenceMigrations)); }
finally { await runtime.close(); }

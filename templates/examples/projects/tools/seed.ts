import { referenceDatabase } from "../src/infra/database.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_REQUIRED_FOR_SEED");
const runtime = referenceDatabase(url);
try {
  await runtime.transaction(
    { tenantId: "tenant_local", actorId: "actor_local", requestId: "seed_local" },
    async (transaction) => {
      await transaction
        .insertInto("projects")
        .values({
          id: "project_seed",
          tenant_id: "tenant_local",
          name: "Seed project",
          created_at: new Date(0),
        })
        .onConflict((conflict) => conflict.column("id").doNothing())
        .execute();
    },
  );
} finally {
  await runtime.close();
}

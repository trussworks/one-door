import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const fixtureSeedManifests = pgTable("_one_door_fixture_seed", {
  name: text().primaryKey(),
  contentHash: text("content_hash").notNull(),
  seededAt: timestamp("seeded_at", {
    withTimezone: true,
    mode: "string",
  })
    .notNull()
    .defaultNow(),
});

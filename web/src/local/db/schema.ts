import { sql } from "drizzle-orm";
import { pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const memberRole = pgEnum("member_role", ["owner", "editor", "viewer"]);

export const DEFAULT_THEMATIC_HINT = "";
export const DEFAULT_VAULT_KINDS = ["person", "event", "organization", "concept"] as const;

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const vaults = pgTable("vaults", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  thematicHint: text("thematic_hint").notNull().default(DEFAULT_THEMATIC_HINT),
  kinds: text("kinds")
    .array()
    .notNull()
    .default(sql`ARRAY['person', 'event', 'organization', 'concept']::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const vaultMemberships = pgTable(
  "vault_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("vault_memberships_vault_id_user_id_unique").on(table.vaultId, table.userId)],
);

export const appState = pgTable("app_state", {
  id: text("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  currentVaultId: uuid("current_vault_id")
    .notNull()
    .references(() => vaults.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

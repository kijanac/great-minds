import { randomBytes, randomInt, randomUUID } from "node:crypto";

import { cliLogins, Database, users } from "@great-minds/database";
import {
  NotFound,
  TooManyRequests,
  Uuid,
  type CliLoginPollResult,
  type CliLoginRequest,
  type CliLoginStarted,
  type Email,
} from "@great-minds/domain";
import { and, count, eq, gt, lt, or } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { AuthService } from "./auth.ts";
import { backgroundLoop } from "./background-loop.ts";
import { ClockService } from "./clock.ts";
import { AppConfig } from "./config.ts";
import { sha256Hex } from "./crypto.ts";

const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const CODE_LENGTH = 8;
const LIFETIME_MS = 10 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 5;
const STARTS_PER_CLIENT = { limit: 30, windowMs: 60 * 60 * 1000 };
const RETENTION_MS = 24 * 60 * 60 * 1000;

const newUserCode = () =>
  Array.from({ length: CODE_LENGTH }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("");

export const normalizeUserCode = (input: string) => input.toUpperCase().replace(/[^A-Z]/g, "");

const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

const notFound = () =>
  new NotFound({ detail: "This sign-in request was not found or has expired" });

type CliLoginsShape = {
  readonly start: (
    computer: string,
    clientAddress: string | null,
  ) => Effect.Effect<CliLoginStarted, TooManyRequests>;
  readonly poll: (deviceCode: string) => Effect.Effect<CliLoginPollResult, NotFound>;
  readonly describe: (email: Email, userCode: string) => Effect.Effect<CliLoginRequest, NotFound>;
  readonly approve: (userId: Uuid, userCode: string) => Effect.Effect<void, NotFound>;
  readonly deny: (userCode: string) => Effect.Effect<void, NotFound>;
  readonly purgeOnce: () => Effect.Effect<number>;
};

export class CliLogins extends Context.Service<CliLogins, CliLoginsShape>()(
  "@great-minds/server/CliLogins",
) {}

export const CliLoginsLive = Layer.effect(
  CliLogins,
  Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* ClockService;
    const config = yield* AppConfig;
    const auth = yield* AuthService;

    const pendingByCode = (userCode: string, now: Date) =>
      and(
        eq(cliLogins.userCode, normalizeUserCode(userCode)),
        eq(cliLogins.status, "pending"),
        gt(cliLogins.expiresAt, now),
      );

    const decide = (userCode: string, set: { status: "approved" | "denied"; userId?: Uuid }) =>
      Effect.gen(function* () {
        const now = yield* clock.now;
        const rows = yield* db.query((d) =>
          d
            .update(cliLogins)
            .set(set)
            .where(pendingByCode(userCode, now))
            .returning({ id: cliLogins.id }),
        );
        if (rows.length === 0) return yield* notFound();
      });

    const start = (computer: string, clientAddress: string | null) =>
      Effect.gen(function* () {
        const now = yield* clock.now;
        if (clientAddress !== null) {
          const [recent] = yield* db.query((d) =>
            d
              .select({ total: count() })
              .from(cliLogins)
              .where(
                and(
                  eq(cliLogins.clientAddress, clientAddress),
                  gt(cliLogins.createdAt, new Date(now.getTime() - STARTS_PER_CLIENT.windowMs)),
                ),
              ),
          );
          if ((recent?.total ?? 0) >= STARTS_PER_CLIENT.limit)
            return yield* new TooManyRequests({
              detail: "Too many sign-in requests from this network. Try again later.",
              retry_after_seconds: STARTS_PER_CLIENT.windowMs / 1000,
            });
        }
        const deviceCode = randomBytes(32).toString("base64url");
        const expiresAt = new Date(now.getTime() + LIFETIME_MS);
        const insert = Effect.suspend(() => {
          const userCode = newUserCode();
          return db
            .query((d) =>
              d
                .insert(cliLogins)
                .values({
                  id: Uuid.make(randomUUID(), { disableChecks: true }),
                  deviceCodeHash: sha256Hex(deviceCode),
                  userCode,
                  computer: computer.trim() || "unnamed computer",
                  status: "pending",
                  clientAddress,
                  createdAt: now,
                  expiresAt,
                })
                .onConflictDoNothing()
                .returning({ userCode: cliLogins.userCode }),
            )
            .pipe(Effect.map((rows) => rows[0]?.userCode));
        });
        let userCode: string | undefined;
        for (let attempt = 0; attempt < 5 && userCode === undefined; attempt += 1)
          userCode = yield* insert;
        if (userCode === undefined) throw new Error("could not allocate a CLI sign-in code");
        const page = new URL("/cli", config.publicWebUrl);
        const complete = new URL(page);
        complete.searchParams.set("code", formatUserCode(userCode));
        return {
          device_code: deviceCode,
          user_code: formatUserCode(userCode),
          verification_url: page.toString(),
          verification_url_complete: complete.toString(),
          interval_seconds: POLL_INTERVAL_SECONDS,
          expires_at: expiresAt,
        };
      });

    const poll = (deviceCode: string) =>
      Effect.gen(function* () {
        const now = yield* clock.now;
        const [row] = yield* db.query((d) =>
          d
            .select({
              id: cliLogins.id,
              status: cliLogins.status,
              computer: cliLogins.computer,
              userId: cliLogins.userId,
              expiresAt: cliLogins.expiresAt,
              email: users.email,
            })
            .from(cliLogins)
            .leftJoin(users, eq(users.id, cliLogins.userId))
            .where(eq(cliLogins.deviceCodeHash, sha256Hex(deviceCode)))
            .limit(1),
        );
        if (row === undefined || row.status === "claimed") return yield* notFound();
        if (row.status === "denied") return { status: "denied" as const };
        if (row.status === "pending")
          return row.expiresAt.getTime() <= now.getTime()
            ? { status: "expired" as const }
            : { status: "pending" as const };
        const claimed = yield* db.query((d) =>
          d
            .update(cliLogins)
            .set({ status: "claimed" })
            .where(and(eq(cliLogins.id, row.id), eq(cliLogins.status, "approved")))
            .returning({ id: cliLogins.id }),
        );
        if (claimed.length === 0 || row.userId === null || row.email === null)
          return yield* notFound();
        const apiKey = yield* auth.createApiKey(row.userId, `gm CLI (${row.computer})`);
        return { status: "approved" as const, email: row.email as Email, api_key: apiKey };
      });

    const describe = (email: Email, userCode: string) =>
      Effect.gen(function* () {
        const now = yield* clock.now;
        const [row] = yield* db.query((d) =>
          d
            .select({
              userCode: cliLogins.userCode,
              computer: cliLogins.computer,
              expiresAt: cliLogins.expiresAt,
            })
            .from(cliLogins)
            .where(pendingByCode(userCode, now))
            .limit(1),
        );
        if (row === undefined) return yield* notFound();
        return {
          user_code: formatUserCode(row.userCode),
          computer: row.computer,
          email,
          expires_at: row.expiresAt,
        };
      });

    const purgeOnce = () =>
      Effect.gen(function* () {
        const now = yield* clock.now;
        const cutoff = new Date(now.getTime() - RETENTION_MS);
        const purged = yield* db.query((d) =>
          d
            .delete(cliLogins)
            .where(or(lt(cliLogins.expiresAt, cutoff), eq(cliLogins.status, "claimed")))
            .returning({ id: cliLogins.id }),
        );
        return purged.length;
      });

    return {
      start,
      poll,
      describe,
      approve: (userId, userCode) => decide(userCode, { status: "approved", userId }),
      deny: (userCode) => decide(userCode, { status: "denied" }),
      purgeOnce,
    } satisfies CliLoginsShape;
  }),
);

export const CliLoginRetentionLoopLive = Layer.effectDiscard(
  Effect.flatMap(CliLogins, (logins) =>
    backgroundLoop({
      failureEvent: "auth.cli_login_retention_failed",
      interval: "1 hour",
      tick: logins.purgeOnce(),
    }),
  ),
);

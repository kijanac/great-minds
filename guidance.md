# Target Architecture & Porting Brief: FastAPI → TypeScript Local-First Logic Layer

## Goal

Port an existing **FastAPI (Python) backend** into a **TypeScript logic layer** inside a **local-first** desktop + mobile app. The app runs offline with an embedded Postgres-compatible database on the device. There is **no HTTP server** in the target — the FastAPI transport layer is dropped, not re-implemented.

Treat this as primarily a **deletion + relocation** exercise: keep the business logic and data access, discard the network/transport scaffolding.

---

## Target Stack

| Concern | Choice | Notes |
|---|---|---|
| Language | **TypeScript** everywhere | UI, logic, and data layer share one language and shared types |
| Desktop shell | **Tauri 2** | Rust core + system webview; small bundles, no bundled Chromium |
| Mobile shell | **Capacitor** (or Tauri 2 mobile) | Wraps the same web frontend in the native WebView |
| UI | **Svelte + Vite** | SPA/static build — **no SSR** (there's no server) |
| Database | **PGlite** (Postgres-in-WASM) | Runs in a **Web Worker**; persists to OPFS/IndexedDB |
| Data access / ORM | **Drizzle** | PGlite-compatible; thin, typed query layer |
| Validation / schemas | **Zod** | Replaces Pydantic; schemas are **shared** between UI and logic |
| Durable workflows | **Absurd** (`absurd-sdk`, TS) | Runs on PGlite. ⚠️ early/experimental — prototype before relying on it |
| Full-text search | **`@electric-sql/pglite-pg_textsearch`** (BM25) | Or built-in Postgres FTS (`tsvector`/`ts_rank`) for simpler needs |
| Vector / hybrid search | **pgvector** (PGlite extension) | Optional; pairs with pg_textsearch for hybrid retrieval |
| Worker ergonomics | **Comlink** | Makes Worker calls look like normal `await api.x()` |
| Testing | **Vitest** | Use **PGlite in-memory** (`new PGlite()`) for real-DB integration tests |

---

## Architecture & Placement

**Everything runs in the webview. No separate backend process. No cross-process IPC.**

```
┌─────────────────────────── Webview (one JS runtime) ───────────────────────────┐
│                                                                                 │
│   Main thread                          Web Worker thread                        │
│   ┌──────────────┐                     ┌──────────────────────────────────┐     │
│   │ Svelte UI    │ ── typed api ─────▶ │ Service layer (business logic)   │     │
│   │ (rendering)  │   (Comlink over     │   └─ Data-access layer (Drizzle) │     │
│   │              │    postMessage)     │        └─ PGlite (Postgres WASM) │     │
│   └──────────────┘ ◀──── results ───── │        └─ Absurd durable tasks   │     │
│                                         └──────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────────┘
        (Tauri Rust core exists for OS access only — not used for app logic)
```

### Layering (modules within one app, NOT network tiers)
1. **UI layer** — Svelte components, main thread, rendering only. Current transition code may still be React; the same layering rules apply.
2. **React/Svelte adapter layer** — app boot providers and UI hooks that adapt framework state to the local API. This layer may use React Query/Svelte stores, but must not import Drizzle/PGlite.
3. **Typed API surface** — a small explicit `LocalApi` contract the UI calls; wraps the Worker via Comlink.
4. **Worker boundary** — owns the PGlite/Drizzle context, validates incoming commands, and delegates to services.
5. **Service layer** — ported business logic/use cases (your FastAPI service functions). **Keep this.** Services receive typed commands and return application/domain shapes.
6. **Data-access layer** — Drizzle schema, migrations, and thin query helpers. Keep it *thin* (see below).
7. **PGlite** — the database and authoritative persistence engine.

### Why a Web Worker (not main thread, not a separate process)
- **Off the UI thread** → heavy compute / queries don't freeze navigation.
- **Still inside the webview** → no cross-process IPC, shared types work, reactive reads stay cheap.
- The Worker boundary is light `postMessage`/structured-clone (wrapped by Comlink), **not** the expensive process IPC of a Rust-core or sidecar placement.

### Local implementation discipline

Use this file layout/pattern for the local-first implementation:

```txt
src/local/db/schema.ts          Drizzle tables, PG enums, constraints, defaults
src/local/db/client.ts          PGlite creation + migrations + Drizzle context
src/local/schema/*.ts           Drizzle-generated row schemas + command/application schemas
src/local/services/*.ts         Application services/use cases; no UI or Comlink imports
src/local/worker/api.ts         Explicit LocalApi contract
src/local/worker/api.worker.ts  Comlink-exposed implementation; validates commands
src/local/worker/client.ts      App-lifetime Comlink proxy + boot/restart lifecycle
src/local/app-provider.tsx      UI-framework boot gate/adaptor; no DB imports
src/hooks/*.ts                  UI hooks that call LocalApi/provider state; no DB imports
```

Rules:
- **UI never imports Drizzle/PGlite/schema tables.** UI talks to framework hooks or `LocalApi` through containers/adapters.
- **The Worker is the local backend boundary.** It owns the PGlite/Drizzle context for the app lifetime.
- **Define an explicit service contract.** Prefer `api.ts` with `interface LocalApi` over importing implementation-derived types from `api.worker.ts`.
- **Use an app-lifetime Worker for local-first.** This is not an optional hosted-mode feature; boot the local backend at app startup behind a real boot/error/retry gate.
- **Validate at the boundary.** Zod-parse command inputs in `api.worker.ts`, then pass typed commands to services. Do not parse the same command again inside business logic.
- **Services orchestrate transactions and use cases.** They may call Drizzle, but they should not know about React/Svelte, routing, Comlink, localStorage, or HTTP.
- **DB constraints/defaults own persisted invariants/defaults.** Do not duplicate FK checks or default arrays in business logic. Omit absent optional insert fields and let DB defaults apply; materialize composed return shapes with joins.
- **Materialize composed app state through helpers.** For example, `loadCurrentWorkspace(tx)` joins `app_state → users → vaults` and validates the resulting `Workspace` once.

---

## Porting Approach (FastAPI → TS logic layer)

Do it in this order:

1. **Pydantic models → Zod schemas first.** Define schemas, derive types with `z.infer<typeof S>`. These become the **shared types** imported by both UI and logic.
2. **Extract the service function under each route.** A FastAPI route typically validates input → calls a service fn → formats a response. The service fn is the real substance; the route wrapper is discarded.
3. **Port service functions** into TS modules grouped by domain (`core/users.ts`, etc.).
4. **Port data access to Drizzle** in a dedicated data module.
5. **Expose a typed `api` surface** to the UI (Comlink-wrapped Worker calls).
6. **Drop** auth middleware, CORS, rate limiting, HTTP status codes, and transport plumbing.

### Concept mappings
| FastAPI / Python | TypeScript target |
|---|---|
| `@app.post("/x")` endpoint | exported `async` function |
| Pydantic model | Zod schema + `z.infer` type |
| `Depends(...)` DI | plain import / pass a context object (no DI container) |
| `HTTPException` | `throw` a typed `Error` subclass; UI catches it |
| `BackgroundTasks` | Absurd durable task (or plain async for fire-and-forget) |
| SQLAlchemy | Drizzle |
| pytest | Vitest (against in-memory PGlite) |
| `pydantic-settings` | `process.env` validated with Zod |

### Validation trust boundary
The caller of the logic layer is **your own trusted UI**, not an untrusted network client. So **do not** defensively validate every internal call. Run Zod only at **genuine** trust boundaries: user-entered data, file imports, anything crossing the Comlink Worker boundary, and anything arriving from a future sync layer.

For local API calls, parse in `api.worker.ts`:

```ts
async createVault(command) {
  const parsed = CreateVaultCommandSchema.parse(command);
  const ctx = await ctxPromise;
  return createVault(ctx, parsed);
}
```

Then keep the service typed and direct:

```ts
export async function createVault(ctx: LocalContext, command: CreateVaultCommand) {
  // use case logic, no repeated parse
}
```

### Repository/data-access layer
Keep the **service layer** (good separation). Keep data access **thin and Drizzle-native** — justified here because PGlite's placement could change later (Worker → sidecar → Rust core) and thin query helpers localize that change. **Do not** build heavyweight enterprise repository ceremony (interface-per-entity, unit-of-work, DI container). Drizzle is already a thin typed query layer; don't wrap it in heavy abstraction.

Good patterns:
- use Drizzle tables as the persisted row source of truth;
- use `$inferSelect` / `$inferInsert` for row/insert types;
- use generated Zod schemas from Drizzle for table-shaped rows/enums;
- keep shared query helpers purposeful (`loadCurrentWorkspace`, `createOwnedVault`) rather than generic CRUD repositories.

---

## Critical Constraints (do not violate)

- **Worker ≠ OS background execution.** A Worker runs off the UI thread *while the app is open/foreground*. It is suspended/killed when the app is backgrounded (especially on mobile) and dies when the window closes.
- **Long-running work must be durable/resumable**, not always-on. Absurd checkpoints each step to PGlite; on return-to-foreground the Worker restarts and resumes from the last checkpoint. Design long tasks as checkpointed steps, not continuous loops.
- **PGlite concurrency model — design around it.** PGlite is Postgres single-user mode: **one connection, one thread, serial execution**. The v0.4 multiplexer adds multiple *logical* connections for **tooling compatibility** (clients/ORMs that expect a pool) — it does **not** add parallelism; everything still runs serially on one thread.
  - **An open transaction serializes everything else.** While one (logical) connection is mid-transaction, others wait until it commits/rolls back. Keep transactions **short** and **never hold one open across slow work** (compute, I/O, `await`s, LLM calls). Pattern: do the slow work *outside* the transaction, then open a brief transaction only to write the result/checkpoint — this is Absurd's shape.
  - **Avoid single long-running statements** (giant aggregations / bulk ops). One statement runs uninterruptibly on the single thread and stalls all other queries for its duration.
  - **Two serialization points, not one:** (1) the PGlite executor, and (2) the DB Worker's single-threaded event loop. CPU-bound *synchronous* JS blocks the Worker from servicing UI queries, so keep heavy compute async/chunked or run it in a **separate compute Worker**, leaving the DB Worker free for short reads.
- **Single connection is fine for normal UI rendering.** A reactive React/Svelte UI fires many *small* reads, not parallel connections — it needs low per-query latency, not parallelism (rendering is single-threaded JS regardless). The serial executor drains many small reads in a few ms and the UI paints progressively. The only risk is a *slow* read coexisting with light reactive reads, which the transaction/statement rules above already address. Do **not** add connection-pooling complexity to "fix" the single connection.
- **No true background execution path via the Worker.** If continuous background work is ever required: desktop needs a separate process (Tauri sidecar / Rust core) that outlives the window; mobile needs platform background-task APIs (iOS BGTask / Android WorkManager) with their hard time limits.

---

## Idiomatic TypeScript Conventions

- `tsconfig` in **strict** mode; **no `any`**.
- **Drizzle is the source of truth for persisted row shapes.** For a table-shaped entity, export `type Vault = typeof vaults.$inferSelect` and `VaultSchema = createSelectSchema(vaults)`; do not handwrite a duplicate row schema.
- **Generated schemas for PG enums.** For closed sets such as `member_role`, use `pgEnum(...)`, then `MemberRoleSchema = createSelectSchema(memberRole)` and `type MemberRole = z.infer<typeof MemberRoleSchema>`. Do not use PG enums for user-configurable strings such as vault `kinds`.
- **Handwrite only non-table application schemas.** Composed shapes like `Workspace` or `VaultSettings` compose Drizzle-generated row schemas. Command schemas such as `CreateVaultCommandSchema` describe user/application intent, not DB rows.
- **Commands, not DTOs, for local API mutations.** Prefer `CreateVaultCommand` / `UpdateVaultCommand` for state-changing input shapes. Avoid `*Dto` unless there is a true transport-specific representation.
- **Runtime types are erased** — TS types vanish at compile time, so validate external/boundary data at runtime with Zod (this is the #1 mental shift from Pydantic).
- Prefer **discriminated unions** over class hierarchies + `isinstance`-style checks.
- Pick a convention for `null` vs `undefined` and stick to it. Current local commands use `undefined` to mean "field omitted; let service/DB default behavior apply."
- `const` by default; favor immutability.
- Errors via `throw` of typed `Error` subclasses.

---

## Verify Before Relying (risk flags)

- **`absurd-sdk` maturity** — v0.3.x, ships with a "not for production" warning. Prototype the durable-workflow pattern first.
- **`pglite-pg_textsearch`** — confirm current version/maturity and limitations (recent docs note single-column indexes only and no exact-phrase search).
- **Browser DB persistence (PGlite VFS on WebKit)** — pick the VFS deliberately. PGlite's own docs currently **recommend the IndexedDB VFS in the browser** because the OPFS VFS isn't well-supported on Safari/WebKit. Both WebKit targets here (Tauri on macOS, Capacitor on iOS) would therefore likely use IndexedDB VFS, which sidesteps OPFS entirely at some performance cost. Re-verify against the current PGlite version, since OPFS support is improving. Notes:
  - **Per-file OPFS worries are largely moot** — PGlite uses an "access handle pool" that spreads the DB across many randomly-named files, not one large file.
  - **Embedded-WebView quota is reduced but large** — WebKit gives embedded-WebView apps ~15% of disk per origin (vs ~60% for browser apps); generous, but wrap storage writes to handle `QuotaExceededError`, and an origin can be evicted (LRU) unless in persistent mode.
  - **Only system-WebKit apps are affected.** Electron (bundles Chromium) and native apps (Qt/Swift, which don't use web storage) are not subject to these WebKit rules — only system-webview apps (Tauri on macOS/iOS) are, and only for web-storage persistence.
  - **Escape hatch:** running PGlite in the Rust core (pglite-oxide) or a sidecar with real filesystem persistence removes all WebKit web-storage rules — it's just a file on disk (reintroduces the cross-process IPC boundary).
- **Per-platform builds** — Tauri app and any future sidecar are built per target triple (one binary per OS/arch), produced on matching CI runners.

---

## Optional: Effect (effect-ts) — a considered choice, not an oversight

Effect is a deliberate option for the **logic/service layer**, not something to add reflexively. If adopted, it would:
- Replace thrown `Error` subclasses with the typed error channel (`Effect<A, E, R>`) — failures become part of each function's contract.
- Replace "import/pass a context object" DI with **Layers/Context** (functional, type-checked — not a class DI container).
- Replace Zod with **Effect Schema** (Drizzle can generate Effect schemas from tables, same as it does for Zod).
- Provide structured concurrency, retries/`Schedule`, and resource management for sync/flaky operations.

**Stack-specific caveat:** the turnkey Effect+Drizzle DB integration (`drizzle-orm/effect-postgres` + `@effect/sql-pg`) is built on node-postgres and expects a wire `DATABASE_URL`; it does **not** run inside the webview against in-process PGlite. So you'd wrap the direct `drizzle-orm/pglite` driver (or raw PGlite) in `Effect.tryPromise` and build your own DB service/Layer by hand. Effect itself is pure TS and runs fine in the webview/Worker.

**Relationship to Absurd:** complementary, not competing. Absurd owns the **durable** step boundaries (checkpointed to PGlite, survives restart); each step **body** can be an Effect (in-memory composition that dies with the Worker). Keep that division explicit — both have retry/concurrency primitives, so without discipline you get two confusing orchestration models. Also note Effect adds non-trivial bundle weight (tree-shakeable, but the core isn't tiny).

**Adoption guidance — important:** Effect is close to its own paradigm with a steep curve, and it pays off only when the whole logic layer is Effects; half-adopting it is worse than not. Given the concurrent learning curves here (idiomatic TS + the port + a novel architecture), **do not** adopt Effect *and* learn idiomatic TS *and* port simultaneously. Pick one:
- **Defer:** get the port working in plain idiomatic TS (thrown typed errors, Zod, simple service functions), then refactor the logic layer into Effect later if the FP style appeals — the layer boundaries make this a contained refactor.
- **All-in:** only if the team is already FP-literate and committed; then treat Effect as the logic layer's backbone from the start.
- **Avoid the lukewarm middle:** sprinkling Effect into otherwise-imperative code while still climbing the TS curve.

---

## Out of Scope (note for later, do not build now)

- **Multi-device sync** — would add a sync engine (Electric / PowerSync / Zero) + a central Postgres server. The local-first core above stays; the server is added narrowly at the edge (sync + privileged ops only).
- **Moving logic/DB into the Rust core or a sidecar** — only if native access, heavy native libraries, or true background execution become hard requirements. This reintroduces cross-process IPC and per-platform sidecar binaries.

# School 1 — FastAPI + SQLAlchemy 2.0 Layered Architecture

The traditional layered architecture (Repository → Service → API), refined
to modern standards with async SQLAlchemy 2.0, schema-first contracts, and
DB-enforced invariants.

## Five Schools at a Glance

| School | Essence | When |
|---|---|---|
| 1 — Traditional Layered | Repo → Service → Route, domain-organized | Most production apps |
| 2 — No-Repository | Inject Session directly into services | Small services, thin domain |
| 3 — Clean/DDD | Domain models separate from ORM, Ports & Adapters | Domain-heavy, long-lived |
| 4 — Vertical Slices | Feature-centric, all code for one feature in one dir | Multi-team, fast iteration |
| 5 — SQLModel | Combined ORM+Pydantic model class | Rapid prototypes, single dev |

School 1 is the pragmatic default. This document describes the refined
version we converged on through audit and cleanup of a real codebase.

---

## Layer Responsibilities

```
Route (app/api/)
  ↓ receives API request schema, returns API response schema
Service (core/{domain}/service.py)
  ↓ receives domain schema or primitives, returns domain schema
Repository (core/{domain}/repository.py)
  ↓ receives primitives/UUIDs, returns domain schema
Database (SQLAlchemy 2.0 async)
```

### Layer Input/Output Table

| Layer | Input | Output | Owns |
|---|---|---|---|
| **Route** | Pydantic API request schema (FastAPI validates) | Pydantic API response schema | HTTP concerns, status codes, auth guards |
| **Service** | Domain Pydantic schema (write ops) or primitives (pure lookups) | Domain Pydantic schema | Business logic, cross-repo coordination, commits |
| **Repository** | Primitives, UUIDs | Domain Pydantic schema | SQL, ORM mapping, `select()`, `flush()` |

**Rule of thumb for service inputs:** more than 2 parameters that travel
together through route → service → repo = a domain schema. Single UUID/string
lookups (`get_by_id(user_id)`) stay as primitives — wrapping them is ceremony.

### What Each Layer Never Does

| Layer | Must not |
|---|---|
| Route | Import ORM models, contain business logic, throw domain exceptions |
| Service | Import `HTTPException`, import ORM models, access `session` directly |
| Repository | Commit, rollback, import `HTTPException`, contain business logic |

---

## Schema Naming Convention

Three categories, distinguished by suffix:

| Suffix | Layer | Meaning | Example |
|---|---|---|---|
| `Create` | API request | POST body | `UserCreate`, `VaultCreate` |
| `Update` / `Patch` | API request | PUT/PATCH body | `ProposalUpdate`, `VaultConfigUpdate` |
| `Invite` / etc | API request | Domain-specific action | `MembershipInvite` |
| `Response` / `Detail` / `Summary` | API response | GET body | `UserResponse`, `VaultDetail`, `RecentArticleItem` |
| `Internal` | Domain | Assembled form for service→repo | `MembershipInternal` |

**`Internal` schemas** bundle data resolved at the route layer (e.g., IDs
from URL paths combined with body fields) for clean service contracts.

### Where Schemas Live

```
core/{domain}/schemas.py    ← Domain schemas (User, Vault, MembershipInternal)
app/api/schemas/{domain}.py ← API schemas (UserCreate, UserResponse, etc.)
```

Domain schemas carry the full entity shape. API schemas carry the public
contract — they strip internal fields (`hashed_password`), add HATEOAS
links, and differ per endpoint (`UserDetail` vs `UserSummary`).

---

## Repository Pattern

### Return Types

Repositories always return **domain Pydantic schemas**, never ORM objects.
`model_validate(row)` is the single conversion point.

```python
# ✅ Correct
async def get_by_id(self, user_id: UUID) -> User | None:
    row = await self.session.execute(select(UserORM).where(UserORM.id == user_id))
    orm_user = row.scalar_one_or_none()
    return User.model_validate(orm_user) if orm_user else None

# ❌ Wrong — ORM leaks out
async def get_by_id(self, user_id: UUID) -> UserORM | None:
    ...
    return orm_user
```

### Commit Boundaries

Repositories never commit. They `flush()` for ID generation, but commit is
always the service's responsibility.

### Method Naming by Semantic Intent

| Prefix | Semantics | DB Pattern |
|---|---|---|
| `get_` | Read, may return None | `SELECT` |
| `list_` | Read many, may be empty | `SELECT` with pagination |
| `create_` | Write, returns new row | `INSERT ... RETURNING` |
| `add_` | Write, idempotent insert | `INSERT ... ON CONFLICT DO NOTHING RETURNING` |
| `set_` / `mark_` | State transition on known record | `UPDATE ... RETURNING` + rowcount check |
| `upsert_` | Write, insert or update | `INSERT ... ON CONFLICT DO UPDATE RETURNING` |
| `delete_` | Write, remove | `DELETE`, idempotent (no-op if missing is fine) |
| `replace_` | Write, wholesale swap | `DELETE` + bulk `INSERT` |

Use **`add_` (not `create_`) when the caller doesn't know if the row exists**
and wants idempotence. Use **`set_`/`mark_` when the caller knows the record
exists** and is performing an intentional state transition. The verb
documents the caller's knowledge.

---

## Existence and Uniqueness Checks

### Decision Matrix

| Scenario | Strategy | Mechanism |
|---|---|---|
| "Ensure this exists, I just need yes/no" | DB-enforced | `ON CONFLICT DO NOTHING ... RETURNING` |
| "Ensure this row has these values, old or new" | DB-enforced | `ON CONFLICT DO UPDATE` (upsert) |
| "Inspect existing record to make a business decision" | Service-layer check | `SELECT` + domain logic + mutation |
| "Atomic read-check-write with no intervening mutation" | Service-layer with lock | `SELECT ... FOR UPDATE` |
| **Never** | Python check without DB constraint under concurrency | Don't |

### The Rule

If there's a `UNIQUE` constraint in the schema, make it **do work** via
`ON CONFLICT`. Never duplicate constraint checks in Python — that's a
TOCTOU race.

---

## Transaction Management

### Default: DI-Lifecycle Session

```python
# server.py lifespan
engine = create_async_engine(settings.database_url, pool_pre_ping=True)
sm = async_sessionmaker(engine, expire_on_commit=False)

# dependencies.py
async def get_session(request: Request) -> AsyncSession:
    sm = request.state["session_maker"]
    async with sm() as session:
        yield session  # open/close only, no auto-commit
```

### Commits Are Explicit, at the Service Layer

```python
class SomeService:
    async def _commit(self) -> None:
        await self.repo.session.commit()

    async def do_multi_step_operation(self, ...) -> Result:
        await self.repo.step_one(...)
        await self.repo.step_two(...)
        await self._commit()  # atomic boundary
```

Services own commit boundaries. Multi-step operations that span repos
commit at the end. Read-only operations don't commit at all — the session
just closes.

---

## Dependency Injection Chain

Wire layers with `Annotated` + `Depends` in a single `dependencies.py`:

```python
# Primitives
SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]

# Repositories — depend on session
def get_user_repo(session: SessionDep) -> UserRepository:
    return UserRepository(session)
UserRepositoryDep = Annotated[UserRepository, Depends(get_user_repo)]

# Services — depend on repos + other services
def get_user_service(
    user_repo: UserRepositoryDep,
    vault_service: VaultServiceDep,
    settings: SettingsDep,
) -> UserService:
    return UserService(user_repo, vault_service, settings)
UserServiceDep = Annotated[UserService, Depends(get_user_service)]

# Auth — cross-cutting
async def get_current_user(
    credentials: BearerCredsDep,
    auth_repo: AuthRepositoryDep,
    user_repo: UserRepositoryDep,
    settings: SettingsDep,
) -> User:  # domain Pydantic, never ORM
    ...
CurrentUser = Annotated[User, Depends(get_current_user)]
```

**Rules:**
- `CurrentUser` must be the domain Pydantic `User`, not the ORM class
- Services never depend on `CurrentUser` directly — routes extract what's needed and pass it as primitives or domain schemas
- All DI wiring lives in one file per entry point (API `dependencies.py`, CLI `main()`)

---

## Session Configuration (SQLAlchemy 2.0 Async)

```python
engine = create_async_engine(
    settings.database_url,
    pool_pre_ping=True,        # verify connections before use
    pool_size=20,              # base connections
    max_overflow=10,           # extra under load
    pool_recycle=3600,         # prevent stale connections
)

sm = async_sessionmaker(
    engine,
    expire_on_commit=False,    # CRITICAL for async — prevents MissingGreenlet
)
```

**`expire_on_commit=False` is non-negotiable for async.** Without it,
accessing any attribute after commit raises `MissingGreenlet`.

---

## Anti-Patterns Checklist

- [ ] Repository returns ORM objects
- [ ] Service imports `HTTPException`
- [ ] Service imports ORM models directly
- [ ] Route contains business logic or DB queries
- [ ] `CurrentUser` type is an ORM class
- [ ] Python-level uniqueness check without a DB constraint
- [ ] `ON CONFLICT` missing on a table with a unique index
- [ ] `upsert_` used where `set_`/`mark_` (known state transition) belongs
- [ ] `create_` used where `add_` (idempotent, caller doesn't know state) belongs
- [ ] Commit in a repository method
- [ ] Auto-commit in `get_session` dependency
- [ ] `expire_on_commit=True` with async
- [ ] Lazy-loaded relationship accessed after commit (use `selectinload` / `joinedload`)
- [ ] Domain schema and API response schema are the same class

---

## Project Structure

```
src/
├── core/
│   ├── db.py                  ← DeclarativeBase only
│   ├── settings.py            ← pydantic-settings
│   ├── {domain}/
│   │   ├── models.py          ← SQLAlchemy ORM (UserORM, VaultORM, ...)
│   │   ├── schemas.py         ← Domain Pydantic (User, Vault, ...Internal)
│   │   ├── repository.py      ← Data access, returns domain schemas
│   │   ├── service.py         ← Business logic, owns commits
│   │   └── __init__.py        ← Exports public API
│   └── pipeline/              ← Non-API domain logic
├── app/
│   ├── api/
│   │   ├── server.py          ← lifespan, engine, sessionmaker, app factory
│   │   ├── dependencies.py    ← All DI wiring
│   │   ├── v1/__init__.py     ← Router aggregation
│   │   ├── {resource}_routes.py
│   │   └── schemas/
│   │       └── {domain}.py    ← API request/response schemas
│   └── main.py                ← CLI entry point
└── migrations/                ← Alembic
```

**Key structural rules:**
- ORM models are named `XxxORM` if there's a name collision with a domain schema
- Domain `__init__.py` exports the Pydantic schema as the bare name (`User`),
  ORM as `UserORM`
- Routes are organized by resource name, not by feature directory
- Cross-cutting concerns (auth guards, vault-scoped routing) live in
  `dependencies.py` and `v1/__init__.py`

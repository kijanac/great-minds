# Harness-standard justfile.
#
# Naming conventions:
#   Frontend: pnpm --prefix web (tsgo, oxlint, oxfmt)
#   TypeScript packages: pnpm (tsgo, oxlint)

set dotenv-load := false

# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

# List available recipes
default:
    @just --list

# ---------------------------------------------------------------------------
# Quality — individual checks (all read-only)
# ---------------------------------------------------------------------------

# Lint frontend with oxlint
lint-web:
    pnpm --prefix web exec oxlint src

# Lint TypeScript packages with oxlint
lint-packages:
    pnpm exec oxlint packages/domain/src packages/database/src packages/server/src packages/server/test packages/goldens/src packages/goldens/test

# Check frontend formatting (read-only): oxfmt for .ts, prettier for .svelte
format-web:
    pnpm --prefix web exec oxfmt --check src
    pnpm --prefix web exec prettier --check "src/**/*.svelte" --log-level warn

# Type-check frontend with svelte-check
types-web:
    pnpm --prefix web exec svelte-check

# Type-check TypeScript packages with tsgo
types-packages:
    pnpm run typecheck

# Run focused browser-library tests without external services
test-web:
    pnpm exec vitest run web/src/lib/api/sse-contract.test.ts web/src/lib/api/stream-retry.test.ts

# Run TypeScript package integration tests against scratch Postgres
test-packages:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'docker compose -f docker-compose.packages-test.yml down -v' EXIT
    docker compose -f docker-compose.packages-test.yml down -v
    docker compose -f docker-compose.packages-test.yml up -d --wait db
    DATABASE_URL=postgresql://great_minds:great_minds@localhost:55434/gm_packages_test pnpm --filter @great-minds/database migrate
    DATABASE_URL=postgresql://great_minds:great_minds@localhost:55434/gm_packages_test pnpm --filter @great-minds/server test:integration

# Record compile goldens through live OpenRouter (explicitly opt-in)
goldens-record:
    GOLDENS_RECORD=1 pnpm --filter @great-minds/goldens record

# Replay compile goldens through the TypeScript backend
goldens-check:
    pnpm --filter @great-minds/goldens test
    pnpm --filter @great-minds/goldens check

# ---------------------------------------------------------------------------
# Compound checks
# ---------------------------------------------------------------------------

# Run fast CI checks
ci: lint-web format-web types-web test-web lint-packages types-packages

# Run full CI checks, including hermetic TypeScript package integration
ci-full: ci test-packages

# Pre-push review: full CI gate plus goldens replay
review: ci-full goldens-check
    @echo ""
    @echo "Review: PASSED"

# ---------------------------------------------------------------------------
# Fix — mutates files
# ---------------------------------------------------------------------------

# Auto-format frontend
format-web-fix:
    pnpm --prefix web exec oxfmt --write src

# Fix everything auto-fixable
fix: format-web-fix

# Fix, verify types, show what changed
fix-check: fix types-web types-packages
    git diff --stat

# ---------------------------------------------------------------------------
# Run (adapt to your project's entrypoints)
# ---------------------------------------------------------------------------

# Run API server locally
run *args='':
    node --experimental-strip-types packages/server/src/main.ts {{ args }}

# Run frontend dev server
dev:
    pnpm --prefix web run dev

# Harness-standard justfile.
#
# Standard targets every project must have:
#   lint, format, types, test, ci, review
#
# Naming conventions:
#   Plain name = read-only check (lint, format, types, test)
#   -fix suffix = mutates files (lint-fix, format-fix)
#   Backend: uv run (ruff, ty, pytest)
#   Frontend: pnpm --prefix web (tsgo, oxlint, oxfmt)
#   TypeScript packages: pnpm (tsgo, oxlint)

set dotenv-load := false
export UV_CACHE_DIR := "/tmp/gm-uv-cache"

# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

# List available recipes
default:
    @just --list

# ---------------------------------------------------------------------------
# Quality — individual checks (all read-only)
# ---------------------------------------------------------------------------

# Lint Python with ruff
lint:
    uv run ruff check .

# Lint frontend with oxlint
lint-web:
    pnpm --prefix web exec oxlint src

# Lint TypeScript packages with oxlint
lint-packages:
    pnpm exec oxlint packages/domain/src packages/database/src packages/server/src packages/server/test

# Check Python formatting (read-only)
format:
    uv run ruff format --check .

# Check frontend formatting (read-only)
format-web:
    pnpm --prefix web exec oxfmt --check src

# Type-check Python with ty
types:
    uv run ty check

# Type-check frontend with tsgo (project build mode)
types-web:
    pnpm --prefix web exec tsgo -b

# Type-check TypeScript packages with tsgo
types-packages:
    pnpm run typecheck

# Run tests
test *args='':
    uv run pytest {{ args }}

# Run tests, stop on first failure
test-fast:
    uv run pytest -x -q

# Run TypeScript package integration tests against scratch Postgres
test-packages:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'docker compose -f docker-compose.packages-test.yml down -v' EXIT
    docker compose -f docker-compose.packages-test.yml up -d --wait db
    DATABASE_URL=postgresql://great_minds:great_minds@localhost:55434/gm_packages_test JWT_SECRET=packages-test-jwt-secret UV_CACHE_DIR=/tmp/gm-uv-cache uv run alembic upgrade head
    DATABASE_URL=postgresql://great_minds:great_minds@localhost:55434/gm_packages_test pnpm --filter @great-minds/server test:integration

# ---------------------------------------------------------------------------
# Compound checks
# ---------------------------------------------------------------------------

# Run all CI checks (same gates as GitHub Actions)
ci: lint format types lint-web format-web types-web lint-packages types-packages

# Pre-push review: CI gate
review: ci
    @echo ""
    @echo "Review: PASSED"

# ---------------------------------------------------------------------------
# Fix — mutates files
# ---------------------------------------------------------------------------

# Auto-fix Python lint issues
lint-fix:
    uv run ruff check --fix .

# Auto-format Python
format-fix:
    uv run ruff format .

# Auto-format frontend
format-web-fix:
    pnpm --prefix web exec oxfmt --write src

# Fix everything auto-fixable (lint + format, Python + web)
fix: lint-fix format-fix format-web-fix

# Fix, verify types, show what changed
fix-check: fix types types-web
    git diff --stat

# ---------------------------------------------------------------------------
# Run (adapt to your project's entrypoints)
# ---------------------------------------------------------------------------

# Run API server locally
run *args='':
    uv run uvicorn src.great_minds.app.main:app --reload {{ args }}

# Run frontend dev server
dev:
    pnpm --prefix web run dev

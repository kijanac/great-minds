"""ORM base class shared across all model modules.

Engine and session lifecycle is owned by entry points —
the FastAPI lifespan (server) or the CLI main() — not by this module.
See server.py lifespan and cli.py for per-process initialization.
"""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass

"""One-off migration: legacy BTW anchors -> offset anchors.

Rewrites `btw` events in every vault's session JSONL from the old shape
(`anchor` / `paragraph` / `pi`) to the new offset anchor
(`quote` / `blockOffset` / `context`):

    quote       <- anchor                 (the highlighted span)
    context     <- paragraph              (the passage, for the LLM prompt)
    blockOffset <- offset of the passage within the exchange's answer
                   (matches the markdown parser's block source offset, so the
                    rendered block resolves exactly; falls back to the quote's
                    offset, then -1 -> renders as an orphan, never lost)

Idempotent: events that already carry `quote` are left untouched.

Run against the target environment's config (DB + R2). Dry-run by default::

    uv run python scripts/migrate_btw_anchors.py            # report only
    uv run python scripts/migrate_btw_anchors.py --apply    # write changes
"""

import asyncio
import json
import sys

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from great_minds.core.settings import get_settings
from great_minds.core.storage import make_storage


def migrate_session_jsonl(content: str) -> str | None:
    """Return the rewritten JSONL, or None if nothing needed migrating."""
    events = [json.loads(line) for line in content.split("\n") if line.strip()]
    answers = {
        e["exId"]: e.get("answer", "") for e in events if e.get("type") == "exchange"
    }

    changed = False
    for e in events:
        if e.get("type") != "btw" or "quote" in e:
            continue
        anchor = e.pop("anchor", "")
        paragraph = e.pop("paragraph", "")
        e.pop("pi", None)
        answer = answers.get(e.get("exId", ""), "")
        offset = answer.find(paragraph) if paragraph else -1
        if offset < 0 and anchor:
            offset = answer.find(anchor)
        e["quote"] = anchor
        e["context"] = paragraph
        e["blockOffset"] = offset
        changed = True

    if not changed:
        return None
    return "\n".join(json.dumps(e) for e in events) + "\n"


async def main(apply: bool) -> None:
    settings = get_settings()
    engine = create_async_engine(settings.database_url, pool_pre_ping=True)
    sm = async_sessionmaker(engine, expire_on_commit=False)

    migrated = 0
    try:
        async with sm() as session:
            # Raw query — avoids configuring the ORM relationship graph.
            vaults = (
                await session.execute(text("SELECT id, r2_bucket_name FROM vaults"))
            ).all()

        for vault_id, bucket in vaults:
            storage = make_storage(
                vault_id=vault_id,
                r2_bucket_name=bucket,
                settings=settings,
            )
            for info in await storage.glob("sessions/*.jsonl"):
                content = await storage.read(info.path)
                if content is None:
                    continue
                rewritten = migrate_session_jsonl(content)
                if rewritten is None:
                    continue
                migrated += 1
                prefix = "would migrate" if not apply else "migrated"
                print(f"  {prefix}: vaults/{vault_id}/{info.path}")
                if apply:
                    await storage.write(info.path, rewritten)
    finally:
        await engine.dispose()

    verb = "migrated" if apply else "to migrate (dry-run)"
    print(f"\n{migrated} session file(s) {verb}.")
    if not apply and migrated:
        print("Re-run with --apply to write the changes.")


if __name__ == "__main__":
    asyncio.run(main(apply="--apply" in sys.argv))

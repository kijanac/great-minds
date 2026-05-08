"""SourceCardStore — JSONL-backed source-card persistence.

One line per document, keyed by document_id. The backing object lives in
vault storage (local in dev, R2 in prod) so compile workers can resume on a
different machine. Mutations rewrite the JSONL object; at current scale that
keeps the format simple and easy to inspect.
"""

from collections.abc import AsyncIterator, Iterable
from uuid import UUID

from great_minds.core.ideas.schemas import Idea, SourceCard
from great_minds.core.storage import Storage

SOURCE_CARDS_PATH = "compile/source_cards.jsonl"


class SourceCardStore:
    def __init__(self, storage: Storage, path: str = SOURCE_CARDS_PATH) -> None:
        self.storage = storage
        self.path = path

    async def iter_cards(self) -> AsyncIterator[SourceCard]:
        """Yield source cards from JSONL without retaining parsed cards."""
        content = await self.storage.read(self.path, strict=False)
        if not content:
            return
        for line in content.splitlines():
            if line.strip():
                yield SourceCard.model_validate_json(line)

    async def load_all(self) -> list[SourceCard]:
        return [card async for card in self.iter_cards()]

    async def ideas_by_id(
        self,
        idea_ids: Iterable[UUID],
        *,
        trim_cards: bool = True,
    ) -> dict[UUID, tuple[Idea, SourceCard]]:
        """Return only the requested ideas with their document provenance.

        When ``trim_cards`` is true, the returned SourceCard contains only the
        matched ideas for that document. Abstraction/render only need doc-level
        provenance from the card, so trimming avoids keeping unrelated anchors
        and ideas alive for large documents.
        """
        wanted = set(idea_ids)
        if not wanted:
            return {}
        out: dict[UUID, tuple[Idea, SourceCard]] = {}
        async for card in self.iter_cards():
            matches = [idea for idea in card.ideas if idea.idea_id in wanted]
            if not matches:
                continue
            indexed_card = (
                card.model_copy(update={"ideas": matches}) if trim_cards else card
            )
            for idea in matches:
                out[idea.idea_id] = (idea, indexed_card)
                wanted.discard(idea.idea_id)
            if not wanted:
                break
        return out

    async def get(self, document_id: UUID) -> SourceCard | None:
        async for card in self.iter_cards():
            if card.document_id == document_id:
                return card
        return None

    async def upsert_many(self, cards: list[SourceCard]) -> None:
        existing = {c.document_id: c for c in await self.load_all()}
        for c in cards:
            existing[c.document_id] = c
        await self.write_all(list(existing.values()))

    async def delete(self, document_ids: list[UUID]) -> None:
        ids_to_delete = set(document_ids)
        remaining = [
            c async for c in self.iter_cards() if c.document_id not in ids_to_delete
        ]
        await self.write_all(remaining)

    async def write_all(self, cards: list[SourceCard]) -> None:
        await self.storage.write(
            self.path,
            "".join(c.model_dump_json() + "\n" for c in cards),
        )

"""SourceCardStore — JSONL-backed source-card persistence.

One line per document, keyed by document_id. upsert_many reads the
existing file, merges new cards in by document_id, and rewrites. At
10K-doc scale the O(N) rewrite is trivial; simplicity wins over
streaming upserts.
"""

from pathlib import Path
from uuid import UUID

from great_minds.core.ideas.schemas import Idea, SourceCard


def index_ideas_by_id(
    cards: list[SourceCard],
) -> dict[UUID, tuple[Idea, SourceCard]]:
    return {idea.idea_id: (idea, card) for card in cards for idea in card.ideas}


class SourceCardStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load_all(self) -> list[SourceCard]:
        if not self.path.exists():
            return []
        out: list[SourceCard] = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                out.append(SourceCard.model_validate_json(line))
        return out

    def get(self, document_id: UUID) -> SourceCard | None:
        for card in self.load_all():
            if card.document_id == document_id:
                return card
        return None

    def upsert_many(self, cards: list[SourceCard]) -> None:
        existing = {c.document_id: c for c in self.load_all()}
        for c in cards:
            existing[c.document_id] = c
        self.write_all(list(existing.values()))

    def delete(self, document_ids: list[UUID]) -> None:
        remaining = [
            c for c in self.load_all() if c.document_id not in set(document_ids)
        ]
        self.write_all(remaining)

    def write_all(self, cards: list[SourceCard]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            "".join(c.model_dump_json() + "\n" for c in cards),
            encoding="utf-8",
        )

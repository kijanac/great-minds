"""Convergence invariants for the seven-phase pipeline.

Exercises the pure-function parts of validate that carry the
convergence claim — slug continuity, content-hash determinism,
link_targets intersection, collision detection + rename. If these
mechanics hold, the pipeline's promise that incremental and full
compile produce the same canonical topics (within a cache snapshot)
is structurally sound.

Runs without a database or LLM call. Mocks TopicRepository.get_by_slug
with a small in-memory dict. Passes when all assertions hold; raises
AssertionError with a diagnostic when an invariant breaks.

Usage:
    uv run python scripts/test_convergence.py
"""

from __future__ import annotations

import asyncio
from uuid import UUID

from uuid6 import uuid7

from great_minds.core.pipeline.abstract.schemas import (
    LocalTopic,
    ValidatedCanonicalTopic,
)
from great_minds.core.pipeline.abstract.validate import (
    _apply_renames,
    _assert_no_collision,
    _assign_topic_ids,
    _detect_collisions,
    _intersect_link_targets,
    _topic_content_hash,
)
from great_minds.core.topics.schemas import (
    ArticleStatus,
    CanonicalTopic,
    Topic,
)


class _MockTopicRepo:
    """Drop-in for TopicRepository.get_by_slug during this test."""

    def __init__(self, by_slug: dict[str, Topic]) -> None:
        self._by_slug = by_slug

    async def get_by_slug(self, brain_id: UUID, slug: str) -> Topic | None:
        return self._by_slug.get(slug)


async def test_slug_continuity() -> None:
    """Existing slug → reuses topic_id; new slug → fresh uuid7, is_new=True."""
    brain_id = uuid7()
    existing_topic_id = uuid7()
    existing = Topic(
        topic_id=existing_topic_id,
        brain_id=brain_id,
        slug="existing-slug",
        title="Existing",
        description="d",
        article_status=ArticleStatus.RENDERED,
    )
    repo = _MockTopicRepo({"existing-slug": existing})

    canonicals = [
        CanonicalTopic(
            slug="existing-slug",
            title="Updated Title",
            description="Updated description",
            merged_local_topic_ids=[],
            link_targets=[],
        ),
        CanonicalTopic(
            slug="new-slug",
            title="New",
            description="d",
            merged_local_topic_ids=[],
            link_targets=[],
        ),
    ]

    validated = await _assign_topic_ids(
        brain_id=brain_id,
        repo=repo,
        canonicals=canonicals,
        local_by_id={},
    )

    assert len(validated) == 2
    assert validated[0].slug == "existing-slug"
    assert validated[0].topic_id == existing_topic_id, (
        "slug continuity broken: existing slug should reuse its topic_id"
    )
    assert validated[0].is_new is False
    assert validated[1].slug == "new-slug"
    assert validated[1].topic_id != existing_topic_id
    assert validated[1].is_new is True
    print("✓ slug_continuity")


def test_content_hash_determinism() -> None:
    """Hash stable under idea reordering; sensitive to content change."""
    i1, i2, i3 = uuid7(), uuid7(), uuid7()

    def make(
        title: str = "T",
        description: str = "D",
        subsumed: list[UUID] | None = None,
    ) -> ValidatedCanonicalTopic:
        return ValidatedCanonicalTopic(
            topic_id=uuid7(),
            slug="x",
            title=title,
            description=description,
            merged_local_topic_ids=[],
            subsumed_idea_ids=subsumed if subsumed is not None else [i1, i2, i3],
            link_targets=[],
            is_new=True,
        )

    # Same content, shuffled idea order → same hash (sorted internally)
    assert _topic_content_hash(make()) == _topic_content_hash(
        make(subsumed=[i3, i1, i2])
    )

    # Different idea set → different hash
    assert _topic_content_hash(make()) != _topic_content_hash(
        make(subsumed=[i1, i2])
    )

    # Different title → different hash
    assert _topic_content_hash(make()) != _topic_content_hash(make(title="OTHER"))

    # Different description → different hash
    assert _topic_content_hash(make()) != _topic_content_hash(
        make(description="OTHER")
    )
    print("✓ content_hash_determinism")


def test_link_targets_intersection() -> None:
    """Link targets filtered to emitted slugs; self-links dropped."""
    canonicals = [
        CanonicalTopic(
            slug="a",
            title="A",
            description="d",
            merged_local_topic_ids=[],
            link_targets=["b", "c", "missing", "a"],
        ),
        CanonicalTopic(
            slug="b",
            title="B",
            description="d",
            merged_local_topic_ids=[],
            link_targets=[],
        ),
    ]
    cleaned = _intersect_link_targets(canonicals)
    assert cleaned[0].link_targets == ["b"], cleaned[0].link_targets
    print("✓ link_targets_intersection")


def test_collision_detection_and_rename() -> None:
    """Collisions detected; applying renames resolves them; post-rename
    _assert_no_collision passes.
    """
    topics = [
        CanonicalTopic(
            slug="x",
            title="T1",
            description="d",
            merged_local_topic_ids=[],
            link_targets=[],
        ),
        CanonicalTopic(
            slug="x",
            title="T2",
            description="d",
            merged_local_topic_ids=[],
            link_targets=[],
        ),
        CanonicalTopic(
            slug="y",
            title="T3",
            description="d",
            merged_local_topic_ids=[],
            link_targets=[],
        ),
    ]
    assert _detect_collisions(topics) == {"x": [0, 1]}

    renamed = _apply_renames(topics, {1: "x-2"})
    assert [t.slug for t in renamed] == ["x", "x-2", "y"]
    assert _detect_collisions(renamed) == {}
    _assert_no_collision(renamed)  # should not raise
    print("✓ collision_detection_and_rename")


async def test_subsumed_ideas_resolved_deterministically() -> None:
    """Given same local topics, _assign_topic_ids produces identical
    subsumed_idea_ids (order-stable via sort-by-str).
    """
    brain_id = uuid7()
    repo = _MockTopicRepo({})

    lt1_id, lt2_id = uuid7(), uuid7()
    i1, i2, i3, i4 = uuid7(), uuid7(), uuid7(), uuid7()
    local_by_id = {
        lt1_id: LocalTopic(
            local_topic_id=lt1_id,
            chunk_idx=0,
            slug="lt1",
            title="LT1",
            description="",
            subsumed_idea_ids=[i1, i2],
        ),
        lt2_id: LocalTopic(
            local_topic_id=lt2_id,
            chunk_idx=1,
            slug="lt2",
            title="LT2",
            description="",
            subsumed_idea_ids=[i3, i4],
        ),
    }

    canonical = CanonicalTopic(
        slug="c",
        title="C",
        description="d",
        merged_local_topic_ids=[str(lt2_id), str(lt1_id)],  # unsorted
        link_targets=[],
    )

    run_a = await _assign_topic_ids(
        brain_id=brain_id, repo=repo, canonicals=[canonical], local_by_id=local_by_id
    )
    run_b = await _assign_topic_ids(
        brain_id=brain_id, repo=repo, canonicals=[canonical], local_by_id=local_by_id
    )
    assert run_a[0].subsumed_idea_ids == run_b[0].subsumed_idea_ids
    assert set(run_a[0].subsumed_idea_ids) == {i1, i2, i3, i4}
    print("✓ subsumed_ideas_resolved_deterministically")


async def main() -> None:
    await test_slug_continuity()
    test_content_hash_determinism()
    test_link_targets_intersection()
    test_collision_detection_and_rename()
    await test_subsumed_ideas_resolved_deterministically()
    print("\nall convergence invariants hold.")


if __name__ == "__main__":
    asyncio.run(main())

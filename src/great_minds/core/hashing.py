"""Collision-resistant content hashing for cache keys, content
identity, and dirty-detection flags.

All hashes use SHA-256 with length-prefix framing — no delimiter-in-data
ambiguity, regardless of what bytes the input strings contain.  Every
part is prefixed with a 4-byte unsigned length (struct "I") so the
encoding is unambiguously injective: distinct input sequences always
produce distinct digests.

Do not import ``hashlib`` directly in pipeline or domain code for
content hashing — route through this module instead.  Auth security
hashing lives in ``great_minds.core.crypto`` and is a separate concern.
"""


import hashlib
import struct


# ---------------------------------------------------------------------------
# Internal
# ---------------------------------------------------------------------------


def _hash_framed(*parts: str) -> str:
    """Hash ordered strings with per-part length-prefix encoding."""
    h = hashlib.sha256()
    for p in parts:
        b = p.encode()
        h.update(struct.pack("I", len(b)))
        h.update(b)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def content_hash(*parts: str) -> str:
    """General-purpose content hash of an ordered sequence of strings.

    Uses length-prefix framing — ``content_hash("a", "bc")`` and
    ``content_hash("ab", "c")`` are guaranteed to produce different
    digests.
    """
    return _hash_framed(*parts)


def set_hash(ids: list[str]) -> str:
    """Order-independent hash of a set of string IDs.

    Sorts internally, so ``set_hash(["b","a"]) == set_hash(["a","b"])``.
    Use for cache keys keyed on a set of entity IDs where insertion
    order carries no meaning.
    """
    return _hash_framed(*sorted(ids))


def prompt_hash(template: str) -> str:
    """Prompt template version hash for cache invalidation.

    Changing the prompt text changes the hash, which invalidates all
    caches that embed it.
    """
    return _hash_framed("prompt", template)


def body_hash(body: str) -> str:
    """Document body hash for content-identity columns.

    The ``body`` here is the post-frontmatter, post-anchor-injection
    body text — not the raw file content.
    """
    return _hash_framed("body", body)


def file_hash(content: str) -> str:
    """Full file content hash (including frontmatter)."""
    return _hash_framed("file", content)

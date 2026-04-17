"""Identifier helpers.

UUID5 generation lives at its call sites (content-addressable derivation
differs by artifact kind). This module centralizes UUID7 generation so
the single import point can swap implementations later — e.g. replacing
the uuid6 package with stdlib `uuid.uuid7()` once the project bumps to
Python 3.14+.

UUID7 is used only for artifacts whose identity is assigned at creation
time rather than derived from content (currently: Concept). All
content-addressable IDs (document_id, idea_id, anchor_id) use UUID5 at
their call sites with domain-specific namespaces.
"""

import uuid

from uuid6 import uuid7 as _uuid7_impl


def uuid7() -> uuid.UUID:
    """Return a new UUID7. Time-ordered, stable across process restarts."""
    return _uuid7_impl()

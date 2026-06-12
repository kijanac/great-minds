"""Typed domain errors for the proposals context.

Routes map these to HTTP status codes by exception *type*, so the 404-vs-409
distinction is refactor-safe rather than coupled to an exact message string.
"""


class ProposalNotFound(Exception):
    """No proposal with the given id exists in the vault."""


class ProposalAlreadyReviewed(Exception):
    """The proposal is no longer PENDING — its review is already terminal."""

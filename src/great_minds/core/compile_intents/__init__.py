"""Compile-intents outbox.

A compile_intent row captures the desire for a vault to be compiled.
Domain code (ingest, manual API call, etc.) writes intent rows in the
same transaction as its state change; the reconciler dispatches them
to Absurd.

Invariants (enforced by schema + reconciler):

  1. Every domain change that should trigger a compile commits its
     intent row in the same transaction. No gap.
  2. At most one PENDING intent per vault (partial unique index on
     vault_id WHERE dispatched_at IS NULL).
  3. At most one in-flight compile per vault (reconciler skips dispatch
     when an active compile exists for that vault).
  4. Every intent eventually reaches `satisfied_at` set, given workers.
  5. Spawning the same intent_id N times yields one Absurd task
     (idempotency_key = str(intent.id)).
"""

from great_minds.core.compile_intents.models import CompileIntentRecord
from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.compile_intents.schemas import CompileIntent, IntentStatus

__all__ = [
    "CompileIntent",
    "CompileIntentRecord",
    "CompileIntentRepository",
    "IntentStatus",
]

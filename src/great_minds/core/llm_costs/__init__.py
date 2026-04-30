"""LLM cost visibility: persisted readout of wide_event cost accumulators.

Scope is deliberately downstream-only — visibility, not billing. The
system does not enforce quotas, charge customers, or rate-limit on
spend. The table exists so questions like "what has this brain cost
over the last month" can hit a real table instead of mining logs.

Wide_event (in core.telemetry) accumulates per-LLM-call cost into a
contextvar during a request. ``record_wide_event_cost`` persists the
final aggregate at end-of-request — same number the structured-log
entry consumes, so log and DB never drift. Per-call breakdown lives in
``llm_call_completed`` log events.

If quotas / enforcement / plan tiers ever become a concern, that's a
separate vertical — don't grow this one into billing.
"""

from great_minds.core.llm_costs.models import LlmCostEventORM
from great_minds.core.llm_costs.repository import (
    CostAggregate,
    CostBreakdown,
    LlmCostEventRepository,
)
from great_minds.core.llm_costs.schemas import LlmCostEvent
from great_minds.core.llm_costs.service import (
    LlmCostService,
    record_wide_event_cost,
)

__all__ = [
    "CostAggregate",
    "CostBreakdown",
    "LlmCostEvent",
    "LlmCostEventORM",
    "LlmCostEventRepository",
    "LlmCostService",
    "record_wide_event_cost",
]

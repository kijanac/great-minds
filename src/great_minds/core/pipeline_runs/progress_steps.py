"""Helpers for structured pipeline progress checklists."""

from typing import ClassVar

from great_minds.core.pipeline_runs.schemas import PipelineProgressStep


def build_progress_steps(
    labels: dict[str, str],
    active: str,
    *,
    completed: set[str] | None = None,
    failed: set[str] | None = None,
    counts: dict[str, tuple[int | None, int | None]] | None = None,
    details: dict[str, str] | None = None,
) -> list[PipelineProgressStep]:
    completed_steps = completed or set()
    failed_steps = failed or set()
    step_counts = counts or {}
    step_details = details or {}

    steps: list[PipelineProgressStep] = []
    for key, label in labels.items():
        done, total = step_counts.get(key, (None, None))
        if key in failed_steps:
            status = "failed"
        elif key in completed_steps:
            status = "completed"
        elif key == active:
            status = "running"
        else:
            status = "pending"

        steps.append(
            PipelineProgressStep(
                key=key,
                label=label,
                status=status,
                done=done,
                total=total,
                detail=step_details.get(key, ""),
            )
        )
    return steps


class ProgressStepsMixin:
    """Bind a phase's STEP_LABELS once and forward to build_progress_steps.

    Phase runners set ``STEP_LABELS`` (checklist key -> label) as a class
    attribute and inherit ``progress_steps`` instead of re-declaring the same
    forwarder in every phase.
    """

    STEP_LABELS: ClassVar[dict[str, str]]

    def progress_steps(
        self,
        active: str,
        *,
        completed: set[str] | None = None,
        failed: set[str] | None = None,
        counts: dict[str, tuple[int | None, int | None]] | None = None,
        details: dict[str, str] | None = None,
    ) -> list[PipelineProgressStep]:
        return build_progress_steps(
            self.STEP_LABELS,
            active,
            completed=completed,
            failed=failed,
            counts=counts,
            details=details,
        )

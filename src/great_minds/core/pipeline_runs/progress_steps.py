"""Helpers for structured pipeline progress checklists."""

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
    completed_steps = set() if completed is None else completed
    failed_steps = set() if failed is None else failed
    step_counts = {} if counts is None else counts
    step_details = {} if details is None else details

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

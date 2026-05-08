"""Optional durable sub-step runner for pipeline phases."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import partial
from typing import Any, ParamSpec, TypeVar, cast

P = ParamSpec("P")
T = TypeVar("T")
StepFn = Callable[[str, Callable[[], Awaitable[Any]]], Awaitable[Any]]


@dataclass(frozen=True)
class StepRunner:
    """Composed step runner.

    The runner owns a single callable instead of relying on an inheritance
    hierarchy. Pipeline code depends only on ``step(name, fn, *args, **kwargs)``.
    """

    run: StepFn

    async def step(
        self,
        name: str,
        fn: Callable[P, Awaitable[T]],
        *args: P.args,
        **kwargs: P.kwargs,
    ) -> T:
        return cast(T, await self.run(name, partial(fn, *args, **kwargs)))


async def run_inline_step(name: str, fn: Callable[[], Awaitable[Any]]) -> Any:
    return await fn()


@dataclass(frozen=True)
class AbsurdStepAdapter:
    absurd_ctx: Any

    async def __call__(self, name: str, fn: Callable[[], Awaitable[Any]]) -> Any:
        return await self.absurd_ctx.step(name, fn)


def inline_step_runner() -> StepRunner:
    return StepRunner(run_inline_step)


def absurd_step_runner(absurd_ctx: Any) -> StepRunner:
    return StepRunner(AbsurdStepAdapter(absurd_ctx))

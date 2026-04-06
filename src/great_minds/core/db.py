from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from great_minds.core.settings import get_settings


class Base(DeclarativeBase):
    pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    engine = create_async_engine(settings.database_url)
    app.state.session_maker = async_sessionmaker(engine, expire_on_commit=False)
    yield
    await engine.dispose()


async def get_session(request: Request) -> AsyncGenerator[AsyncSession]:
    async with request.app.state.session_maker() as session:
        yield session


@asynccontextmanager
async def async_session_from_settings():
    """Create a standalone session outside of request context (e.g. background tasks)."""
    settings = get_settings()
    engine = create_async_engine(settings.database_url)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)
    async with session_maker() as session:
        yield session
    await engine.dispose()

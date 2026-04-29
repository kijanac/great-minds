"""Session routes."""

from fastapi import APIRouter, HTTPException

from great_minds.app.api.dependencies import (
    BrainStorageDep,
    CurrentUser,
    PageParamsQuery,
)
from great_minds.app.api.schemas import sessions as schemas
from great_minds.core import sessions
from great_minds.core.pagination import Page
from great_minds.core.sessions import BtwInput, ExchangeInput

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.post("", status_code=201)
async def create_session(
    req: schemas.CreateSessionRequest,
    storage: BrainStorageDep,
    user: CurrentUser,
) -> schemas.SessionPathResponse:
    path = await sessions.create_session(
        storage,
        req.session_id,
        ExchangeInput(
            id=req.exchange.id,
            query=req.exchange.query,
            thinking=req.exchange.thinking,
            answer=req.exchange.answer,
        ),
        origin=req.origin,
        user_id=str(user.id),
    )
    return schemas.SessionPathResponse(path=path)


@router.patch("/{session_id}")
async def append_to_session(
    session_id: str,
    exchange: schemas.ExchangeData,
    storage: BrainStorageDep,
) -> schemas.SessionPathResponse:
    path = await sessions.append_exchange(
        storage,
        session_id,
        ExchangeInput(
            id=exchange.id,
            query=exchange.query,
            thinking=exchange.thinking,
            answer=exchange.answer,
        ),
    )
    return schemas.SessionPathResponse(path=path)


@router.patch("/{session_id}/btw")
async def append_btw_to_session(
    session_id: str,
    btw: schemas.BtwData,
    storage: BrainStorageDep,
) -> schemas.SessionPathResponse:
    path = await sessions.append_btw(
        storage,
        session_id,
        BtwInput(
            exchangeId=btw.exchangeId,
            anchor=btw.anchor,
            paragraph=btw.paragraph,
            paragraphIndex=btw.paragraphIndex,
            messages=btw.messages,
        ),
    )
    return schemas.SessionPathResponse(path=path)


@router.get("")
async def list_all_sessions(
    pagination: PageParamsQuery,
    storage: BrainStorageDep,
    user: CurrentUser,
) -> Page[schemas.SessionListItem]:
    result = await sessions.list_sessions(
        storage, user_id=str(user.id), pagination=pagination
    )
    return Page(
        items=[schemas.SessionListItem.model_validate(s) for s in result.items],
        pagination=result.pagination,
    )


@router.get("/{session_id}")
async def read_session(
    session_id: str,
    storage: BrainStorageDep,
) -> schemas.SessionResponse:
    try:
        events = await sessions.load_events(storage, session_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    return schemas.SessionResponse(id=session_id, events=events)

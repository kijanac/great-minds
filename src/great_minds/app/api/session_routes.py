"""Session routes."""

from fastapi import APIRouter, Depends, HTTPException

from great_minds.app.api.dependencies import get_brain_storage, get_current_user
from great_minds.app.api.schemas import sessions as schemas
from great_minds.core import sessions
from great_minds.core.sessions import BtwInput, ExchangeInput
from great_minds.core.storage import Storage
from great_minds.core.users.models import User

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.post("", status_code=201)
async def create_session(
    req: schemas.CreateSessionRequest,
    storage: Storage = Depends(get_brain_storage),
    user: User = Depends(get_current_user),
) -> schemas.SessionPathResponse:
    path = sessions.create_session(
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
    storage: Storage = Depends(get_brain_storage),
) -> schemas.SessionPathResponse:
    path = sessions.append_exchange(
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
    storage: Storage = Depends(get_brain_storage),
) -> schemas.SessionPathResponse:
    path = sessions.append_btw(
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
    storage: Storage = Depends(get_brain_storage),
    user: User = Depends(get_current_user),
) -> list[schemas.SessionListItem]:
    summaries = sessions.list_sessions(storage, user_id=str(user.id))
    return [schemas.SessionListItem.model_validate(s) for s in summaries]


@router.get("/{session_id}")
async def read_session(
    session_id: str,
    storage: Storage = Depends(get_brain_storage),
) -> schemas.SessionResponse:
    try:
        events = sessions.load_events(storage, session_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    return schemas.SessionResponse(id=session_id, events=events)

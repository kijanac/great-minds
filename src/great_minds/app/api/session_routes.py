"""Session routes."""

from uuid import UUID

from fastapi import APIRouter, HTTPException

from great_minds.app.api.dependencies import (
    VaultAccessDep,
    VaultStorageDep,
    CurrentUser,
    DocumentRepositoryDep,
    IngestServiceDep,
    LlmGuard,
    PageParamsQuery,
    ProposalServiceDep,
)
from great_minds.app.api.schemas import sessions as schemas
from great_minds.core import sessions
from great_minds.core.vaults.models import MemberRole
from great_minds.core.llm import get_async_client
from great_minds.core.paths import session_exchange_path
from great_minds.core.vaults.config import load_config
from great_minds.core.pagination import Page
from great_minds.core.sessions import BtwInput, ExchangeInput, generate_session_title

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.post("", status_code=201)
async def create_session(
    req: schemas.CreateSessionRequest,
    storage: VaultStorageDep,
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
    storage: VaultStorageDep,
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
    storage: VaultStorageDep,
) -> schemas.SessionPathResponse:
    path = await sessions.append_btw(
        storage,
        session_id,
        BtwInput(
            exchangeId=btw.exchangeId,
            anchor=btw.anchor,
            paragraph=btw.paragraph,
            paragraphIndex=btw.paragraphIndex,
            exchanges=btw.exchanges,
        ),
    )
    return schemas.SessionPathResponse(path=path)


@router.get("")
async def list_all_sessions(
    pagination: PageParamsQuery,
    storage: VaultStorageDep,
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
    storage: VaultStorageDep,
) -> schemas.SessionResponse:
    try:
        events = await sessions.load_events(storage, session_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    return schemas.SessionResponse(id=session_id, events=events)


@router.post(
    "/{session_id}/exchanges/{exchange_id}/promote",
    status_code=201,
)
async def promote_exchange(
    session_id: str,
    exchange_id: str,
    storage: VaultStorageDep,
    user: CurrentUser,
    access: VaultAccessDep,
    ingest_service: IngestServiceDep,
    proposal_service: ProposalServiceDep,
    doc_repo: DocumentRepositoryDep,
    _llm: LlmGuard,
    vault_id: UUID,
) -> schemas.PromoteExchangeResponse:
    """Promote one session exchange into the vault's raw corpus.

    Owners ingest directly. Non-owner members create a proposal that
    flows through the existing approval UI. Idempotent on both paths:
    re-promoting either short-circuits to the existing document or
    pending proposal.
    """
    dest = session_exchange_path(exchange_id)
    role = await access.get_member_role(vault_id, user.id)
    is_owner = role == MemberRole.OWNER

    if is_owner:
        existing_doc = await doc_repo.get_by_path(vault_id, dest)
        if existing_doc is not None:
            return schemas.PromoteExchangeResponse(
                mode="ingested",
                path=dest,
                title=existing_doc.metadata.title or exchange_id,
                document_id=str(existing_doc.id),
            )
    else:
        existing_proposal = await proposal_service.find_pending_for_dest(vault_id, dest)
        if existing_proposal is not None:
            return schemas.PromoteExchangeResponse(
                mode="proposed",
                path=dest,
                title=existing_proposal.title or exchange_id,
                proposal_id=str(existing_proposal.id),
            )

    events = await sessions.load_events(storage, session_id)
    if not events:
        raise HTTPException(404, "Session not found")
    meta = sessions.find_meta(events)
    exchange = sessions.find_exchange(events, exchange_id)
    if exchange is None:
        raise HTTPException(404, "Exchange not found in session")
    if not exchange.answer.strip():
        raise HTTPException(400, "Exchange has no answer yet")

    title = await generate_session_title(
        get_async_client(), exchange.query, exchange.answer
    )
    session_origin = meta.origin if meta else None

    if is_owner:
        result = await ingest_service.ingest_session_exchange(
            vault_id,
            storage,
            session_id=session_id,
            exchange=exchange,
            title=title,
            session_origin=session_origin,
        )
        return schemas.PromoteExchangeResponse(
            mode="ingested",
            path=result.file_path,
            title=result.title,
        )

    config = await load_config(storage)
    rendered = sessions.render_session_exchange_source(
        config,
        session_id=session_id,
        exchange=exchange,
        title=title,
        session_origin=session_origin,
    )
    proposal = await proposal_service.create(
        vault_id=vault_id,
        user_id=user.id,
        content_type="sessions",
        title=title,
        author=None,
        dest_path=dest,
        rendered=rendered,
    )
    return schemas.PromoteExchangeResponse(
        mode="proposed",
        path=dest,
        title=title,
        proposal_id=str(proposal.id),
    )

"""Session routes."""

from uuid import UUID

from fastapi import APIRouter, HTTPException

from great_minds.app.api.dependencies import (
    VaultAccessDep,
    VaultEditorGuard,
    CurrentUser,
    SourceDocumentServiceDep,
    IngestServiceDep,
    LlmGuard,
    PageParamsQuery,
    ProposalServiceDep,
    SessionServiceDep,
)
from great_minds.app.api.schemas import sessions as schemas
from great_minds.core.sessions.schemas import BtwInput, ExchangeInput, SessionOverview
from great_minds.core.sessions.service import SessionService
from great_minds.core.vaults.models import MemberRole
from great_minds.core.paths import session_exchange_path
from great_minds.core.pagination import Page
from great_minds.core.proposals.schemas import ProposalCreate

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.post("", status_code=201)
async def create_session(
    req: schemas.CreateSessionRequest,
    session_service: SessionServiceDep,
    user: CurrentUser,
    vault_id: UUID,
) -> schemas.SessionPathResponse:
    path = await session_service.create_session(
        vault_id,
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
    session_service: SessionServiceDep,
    vault_id: UUID,
) -> schemas.SessionPathResponse:
    path = await session_service.append_exchange(
        vault_id,
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
    session_service: SessionServiceDep,
    vault_id: UUID,
) -> schemas.SessionPathResponse:
    path = await session_service.append_btw(
        vault_id,
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
    session_service: SessionServiceDep,
    user: CurrentUser,
    vault_id: UUID,
) -> Page[SessionOverview]:
    return await session_service.list_sessions(
        vault_id, user_id=str(user.id), pagination=pagination
    )


@router.get("/{session_id}")
async def read_session(
    session_id: str,
    session_service: SessionServiceDep,
) -> schemas.SessionResponse:
    try:
        events = await session_service.load_events(session_id)
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
    session_service: SessionServiceDep,
    user: CurrentUser,
    access: VaultAccessDep,
    ingest_service: IngestServiceDep,
    proposal_service: ProposalServiceDep,
    doc_service: SourceDocumentServiceDep,
    _llm: LlmGuard,
    _auth: VaultEditorGuard,
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
        existing_doc = await doc_service.get_by_path(vault_id, dest)
        if existing_doc is not None:
            return schemas.PromoteExchangeResponse(
                mode="ingested",
                path=dest,
                title=existing_doc.title or exchange_id,
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

    events = await session_service.load_events(session_id)
    if not events:
        raise HTTPException(404, "Session not found")
    meta = session_service.find_meta(events)
    exchange = session_service.find_exchange(events, exchange_id)
    if exchange is None:
        raise HTTPException(404, "Exchange not found in session")
    if not exchange.answer.strip():
        raise HTTPException(400, "Exchange has no answer yet")

    session_origin = meta.origin if meta else None

    if is_owner:
        result = await ingest_service.ingest_session_exchange(
            vault_id,
            session_service.storage,
            session_id=session_id,
            exchange=exchange,
            session_origin=session_origin,
        )
        return schemas.PromoteExchangeResponse(
            mode="ingested",
            path=result.file_path,
            title=None,
        )

    rendered = SessionService.render_session_exchange_source(
        session_id=session_id,
        exchange=exchange,
        session_origin=session_origin,
    )
    proposal = await proposal_service.create(
        vault_id=vault_id,
        user_id=user.id,
        data=ProposalCreate(
            content_type="session",
            title=None,
            author=None,
            dest_path=dest,
            rendered=rendered,
        ),
    )
    return schemas.PromoteExchangeResponse(
        mode="proposed",
        path=dest,
        title=None,
        proposal_id=str(proposal.id),
    )

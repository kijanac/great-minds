import { Context, Effect, Schema } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
import * as Sse from "effect/unstable/encoding/Sse";

export const Email = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(320)),
  Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  Schema.brand("Email"),
);
export type Email = typeof Email.Type;

export const Uuid = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  ),
  Schema.brand("Uuid"),
);
export type Uuid = typeof Uuid.Type;

export const SessionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  Schema.brand("SessionId"),
);
export type SessionId = typeof SessionId.Type;

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

export const RequestCodeInput = Schema.Struct({
  email: Email,
});
export type RequestCodeInput = typeof RequestCodeInput.Type;

export const VerifyCodeInput = Schema.Struct({
  email: Email,
  code: Schema.String,
});
export type VerifyCodeInput = typeof VerifyCodeInput.Type;

export const RefreshInput = Schema.Struct({
  refresh_token: Schema.String,
});
export type RefreshInput = typeof RefreshInput.Type;

export const TokenPair = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  token_type: Schema.Literal("bearer"),
});
export type TokenPair = typeof TokenPair.Type;

export const Base64Url = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)));
export type Base64Url = typeof Base64Url.Type;

export const AuthenticatorTransport = Schema.Literals([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
] as const);
export type AuthenticatorTransport = typeof AuthenticatorTransport.Type;

const PublicKeyCredentialDescriptor = Schema.Struct({
  id: Base64Url,
  type: Schema.Literal("public-key"),
  transports: Schema.optionalKey(Schema.Array(AuthenticatorTransport)),
});

const ClientExtensionResults = Schema.Record(Schema.String, Schema.Unknown);

const AuthenticatorAttachment = Schema.Literals(["cross-platform", "platform"] as const);

const RegistrationResponse = Schema.Struct({
  id: Base64Url,
  rawId: Base64Url,
  response: Schema.Struct({
    clientDataJSON: Base64Url,
    attestationObject: Base64Url,
    authenticatorData: Schema.optionalKey(Base64Url),
    transports: Schema.optionalKey(Schema.Array(AuthenticatorTransport)),
    publicKeyAlgorithm: Schema.optionalKey(Schema.Number),
    publicKey: Schema.optionalKey(Base64Url),
  }),
  authenticatorAttachment: Schema.optionalKey(AuthenticatorAttachment),
  clientExtensionResults: ClientExtensionResults,
  type: Schema.Literal("public-key"),
});

export const PasskeyRegistration = Schema.Struct({
  ...RegistrationResponse.fields,
  name: Schema.NonEmptyString.pipe(Schema.check(Schema.isPattern(/\S/))),
});
export type PasskeyRegistration = typeof PasskeyRegistration.Type;

export const PasskeyAuthentication = Schema.Struct({
  id: Base64Url,
  rawId: Base64Url,
  response: Schema.Struct({
    clientDataJSON: Base64Url,
    authenticatorData: Base64Url,
    signature: Base64Url,
    userHandle: Schema.optionalKey(Base64Url),
  }),
  authenticatorAttachment: Schema.optionalKey(AuthenticatorAttachment),
  clientExtensionResults: ClientExtensionResults,
  type: Schema.Literal("public-key"),
});
export type PasskeyAuthentication = typeof PasskeyAuthentication.Type;

export const PasskeyRegistrationOptions = Schema.Struct({
  rp: Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    name: Schema.String,
  }),
  user: Schema.Struct({
    id: Base64Url,
    name: Schema.String,
    displayName: Schema.String,
  }),
  challenge: Base64Url,
  pubKeyCredParams: Schema.Array(
    Schema.Struct({
      alg: Schema.Number,
      type: Schema.Literal("public-key"),
    }),
  ),
  timeout: Schema.optionalKey(Schema.Number),
  excludeCredentials: Schema.optionalKey(Schema.Array(PublicKeyCredentialDescriptor)),
  authenticatorSelection: Schema.optionalKey(
    Schema.Struct({
      authenticatorAttachment: Schema.optionalKey(AuthenticatorAttachment),
      residentKey: Schema.optionalKey(
        Schema.Literals(["discouraged", "preferred", "required"] as const),
      ),
      requireResidentKey: Schema.optionalKey(Schema.Boolean),
      userVerification: Schema.optionalKey(
        Schema.Literals(["discouraged", "preferred", "required"] as const),
      ),
    }),
  ),
  hints: Schema.optionalKey(
    Schema.Array(Schema.Literals(["hybrid", "security-key", "client-device"] as const)),
  ),
  attestation: Schema.optionalKey(Schema.Literals(["direct", "enterprise", "none"] as const)),
  attestationFormats: Schema.optionalKey(
    Schema.Array(
      Schema.Literals([
        "fido-u2f",
        "packed",
        "android-safetynet",
        "android-key",
        "tpm",
        "apple",
        "none",
      ] as const),
    ),
  ),
  extensions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type PasskeyRegistrationOptions = typeof PasskeyRegistrationOptions.Type;

export const PasskeyAuthenticationOptions = Schema.Struct({
  challenge: Base64Url,
  timeout: Schema.optionalKey(Schema.Number),
  rpId: Schema.optionalKey(Schema.String),
  allowCredentials: Schema.optionalKey(Schema.Array(PublicKeyCredentialDescriptor)),
  userVerification: Schema.optionalKey(
    Schema.Literals(["discouraged", "preferred", "required"] as const),
  ),
  hints: Schema.optionalKey(
    Schema.Array(Schema.Literals(["hybrid", "security-key", "client-device"] as const)),
  ),
  extensions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type PasskeyAuthenticationOptions = typeof PasskeyAuthenticationOptions.Type;

export const Passkey = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  created_at: IsoDateTime,
  last_used_at: Schema.NullOr(IsoDateTime),
  transports: Schema.Array(AuthenticatorTransport),
});
export type Passkey = typeof Passkey.Type;

export const ApiKeyCreate = Schema.Struct({
  label: Schema.String,
});
export type ApiKeyCreate = typeof ApiKeyCreate.Type;

export const ApiKey = Schema.Struct({
  id: Uuid,
  label: Schema.String,
  created_at: IsoDateTime,
  revoked: Schema.Boolean,
});
export type ApiKey = typeof ApiKey.Type;

export const ApiKeyWithSecret = Schema.Struct({
  ...ApiKey.fields,
  raw_key: Schema.String,
});
export type ApiKeyWithSecret = typeof ApiKeyWithSecret.Type;

export const AccountDeleteRequest = Schema.Struct({
  confirm: Schema.Literal("DELETE"),
});
export type AccountDeleteRequest = typeof AccountDeleteRequest.Type;

export const CredentialKind = Schema.Literals(["jwt", "api_key"] as const);
export type CredentialKind = typeof CredentialKind.Type;

export const AuthContext = Schema.Struct({
  user_id: Uuid,
  email: Email,
  credential_kind: CredentialKind,
});
export type AuthContext = typeof AuthContext.Type;

const PageLimit = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(200)),
  Schema.withDecodingDefaultTypeKey(Effect.succeed(50)),
);

const PageOffset = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  Schema.withDecodingDefaultTypeKey(Effect.succeed(0)),
);

export const PageParamsQuery = Schema.Struct({
  limit: PageLimit,
  offset: PageOffset,
});
export type PageParams = typeof PageParamsQuery.Type;

export const PageInfo = Schema.Struct({
  limit: Schema.Number,
  offset: Schema.Number,
  total: Schema.Number,
});
export type PageInfo = typeof PageInfo.Type;

const pageOf = <A extends Schema.Top>(item: A) =>
  Schema.Struct({
    items: Schema.Array(item),
    pagination: PageInfo,
  });

export const MemberRole = Schema.Literals(["owner", "editor", "viewer"] as const);
export type MemberRole = typeof MemberRole.Type;

export const InvitedMemberRole = Schema.Literals(["editor", "viewer"] as const);
export type InvitedMemberRole = typeof InvitedMemberRole.Type;

export const VaultCreate = Schema.Struct({
  name: Schema.String,
  thematic_hint: Schema.optionalKey(Schema.String),
  kinds: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type VaultCreate = typeof VaultCreate.Type;

export const Vault = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  owner_id: Uuid,
  created_at: IsoDateTime,
  r2_bucket_name: Schema.NullOr(Schema.String),
});
export type Vault = typeof Vault.Type;

export const VaultPage = Schema.Struct({
  items: Schema.Array(Vault),
  pagination: PageInfo,
  roles: Schema.Record(Schema.String, MemberRole),
});
export type VaultPage = typeof VaultPage.Type;

export const VaultDetail = Schema.Struct({
  ...Vault.fields,
  role: MemberRole,
  member_count: Schema.Number,
  article_count: Schema.Number,
});
export type VaultDetail = typeof VaultDetail.Type;

export const VaultConfig = Schema.Struct({
  thematic_hint: Schema.String,
  kinds: Schema.Array(Schema.String),
});
export type VaultConfig = typeof VaultConfig.Type;

export const VaultConfigUpdate = Schema.Struct({
  thematic_hint: Schema.optionalKey(Schema.String),
  kinds: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type VaultConfigUpdate = typeof VaultConfigUpdate.Type;

export const MemberWithEmail = Schema.Struct({
  user_id: Uuid,
  email: Email,
  role: MemberRole,
});
export type MemberWithEmail = typeof MemberWithEmail.Type;

export const MemberPage = pageOf(MemberWithEmail);
export type MemberPage = typeof MemberPage.Type;

export const MembershipInvite = Schema.Struct({
  email: Email,
  role: Schema.optionalKey(InvitedMemberRole),
});
export type MembershipInvite = typeof MembershipInvite.Type;

export const MembershipUpdate = Schema.Struct({
  role: MemberRole,
});
export type MembershipUpdate = typeof MembershipUpdate.Type;

export const OwnershipTransfer = Schema.Struct({
  new_owner_user_id: Uuid,
});
export type OwnershipTransfer = typeof OwnershipTransfer.Type;

export const ProposalStatus = Schema.Literals(["pending", "approved", "rejected"] as const);
export type ProposalStatus = typeof ProposalStatus.Type;

export const ProposalOverview = Schema.Struct({
  id: Uuid,
  vault_id: Uuid,
  status: ProposalStatus,
  title: Schema.NullOr(Schema.String),
  content_type: Schema.String,
  created_at: IsoDateTime,
});
export type ProposalOverview = typeof ProposalOverview.Type;

export const Proposal = Schema.Struct({
  ...ProposalOverview.fields,
  user_id: Uuid,
  author: Schema.NullOr(Schema.String),
  dest_path: Schema.String,
  document_id: Schema.NullOr(Uuid),
});
export type Proposal = typeof Proposal.Type;

export const ProposalPage = pageOf(ProposalOverview);
export type ProposalPage = typeof ProposalPage.Type;

export const ProposalListQuery = Schema.Struct({
  ...PageParamsQuery.fields,
  status: Schema.optionalKey(ProposalStatus),
});
export type ProposalListQuery = typeof ProposalListQuery.Type;

export const ProposalCreate = Schema.Struct({
  content: Schema.String,
  content_type: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
});
export type ProposalCreate = typeof ProposalCreate.Type;

export const ProposalUpdate = Schema.Struct({
  status: Schema.Literals(["approved", "rejected"] as const),
});
export type ProposalUpdate = typeof ProposalUpdate.Type;

export const IngestedDocument = Schema.Struct({
  file_path: Schema.String,
});
export type IngestedDocument = typeof IngestedDocument.Type;

export const RawSource = Schema.Struct({
  content: Schema.String,
  dest: Schema.String,
  origin: Schema.optionalKey(Schema.String),
});
export type RawSource = typeof RawSource.Type;

export const UserSuggestionIntent = Schema.Literals([
  "disagree",
  "correct",
  "add_context",
  "restructure",
] as const);
export type UserSuggestionIntent = typeof UserSuggestionIntent.Type;

export const UserSuggestion = Schema.Struct({
  body: Schema.String,
  intent: UserSuggestionIntent,
  anchored_to: Schema.String.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(""))),
  anchored_section: Schema.String.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(""))),
});
export type UserSuggestion = typeof UserSuggestion.Type;

export const StagedFileInput = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  hash: Schema.String,
  mimetype: Schema.optionalKey(Schema.String),
});
export type StagedFileInput = typeof StagedFileInput.Type;

export const CheckDupesRequest = Schema.Struct({
  client_hashes: Schema.Array(Schema.String),
});
export type CheckDupesRequest = typeof CheckDupesRequest.Type;

export const CheckDupesResponse = Schema.Struct({
  existing: Schema.Array(Schema.String),
});
export type CheckDupesResponse = typeof CheckDupesResponse.Type;

export const StagedFileSignRequest = Schema.Struct({
  files: Schema.Array(StagedFileInput),
});
export type StagedFileSignRequest = typeof StagedFileSignRequest.Type;

export const StagedFileSignedUpload = Schema.Struct({
  hash: Schema.String,
  url: Schema.String,
});
export type StagedFileSignedUpload = typeof StagedFileSignedUpload.Type;

export const StagedFileSignResponse = Schema.Struct({
  files: Schema.Array(StagedFileSignedUpload),
});
export type StagedFileSignResponse = typeof StagedFileSignResponse.Type;

export const StagedFileProcessRequest = Schema.Struct({
  job_id: Uuid,
  files: Schema.Array(StagedFileInput),
});
export type StagedFileProcessRequest = typeof StagedFileProcessRequest.Type;

export const URLSource = Schema.Struct({
  job_id: Uuid,
  url: Schema.String,
  origin: Schema.optionalKey(Schema.String),
});
export type URLSource = typeof URLSource.Type;

export const PipelineProgressStep = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  status: Schema.Literals(["pending", "running", "completed", "failed"] as const),
  done: Schema.NullOr(Schema.Number),
  total: Schema.NullOr(Schema.Number),
  detail: Schema.String,
});
export type PipelineProgressStep = typeof PipelineProgressStep.Type;

export const JobResponse = Schema.Struct({
  id: Uuid,
  vault_id: Uuid,
  trigger: Schema.Literals(["staged_files", "url", "manual"] as const),
  status: Schema.Literals(["pending", "running", "completed", "failed", "cancelled"] as const),
  current_phase: Schema.String,
  phase_status: Schema.String,
  progress_steps: Schema.Array(PipelineProgressStep),
  error: Schema.NullOr(Schema.String),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  completed_at: Schema.NullOr(IsoDateTime),
  stream_url: Schema.String,
});
export type JobResponse = typeof JobResponse.Type;

export const CompileRequest = Schema.Struct({
  job_id: Uuid,
});
export type CompileRequest = typeof CompileRequest.Type;

export const PipelineRunFilter = Schema.Literals([
  "active",
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const);
export type PipelineRunFilter = typeof PipelineRunFilter.Type;

export const JobListQuery = Schema.Struct({
  ...PageParamsQuery.fields,
  status: Schema.optionalKey(PipelineRunFilter),
});
export type JobListQuery = typeof JobListQuery.Type;

export const JobPage = pageOf(JobResponse);
export type JobPage = typeof JobPage.Type;

export const JobProgressSnapshot = Schema.Struct({
  id: Uuid,
  vault_id: Uuid,
  trigger: Schema.Literals(["staged_files", "url", "manual"] as const),
  job_status: Schema.Literals(["pending", "running", "completed", "failed", "cancelled"] as const),
  phase: Schema.String,
  phase_status: Schema.String,
  steps: Schema.Array(PipelineProgressStep),
  error: Schema.optionalKey(Schema.String),
  updated_at: Schema.NullOr(IsoDateTime),
  completed_at: Schema.NullOr(IsoDateTime),
});
export type JobProgressSnapshot = typeof JobProgressSnapshot.Type;

export const JobSseEvent = Sse.EventEncoded;
export type JobSseEvent = typeof JobSseEvent.Type;

export const CostBreakdown = Schema.Struct({
  key: Schema.String,
  total_usd: Schema.String,
  event_count: Schema.Number,
});
export type CostBreakdown = typeof CostBreakdown.Type;

export const CostAggregate = Schema.Struct({
  total_usd: Schema.String,
  event_count: Schema.Number,
  by_vault: Schema.Array(CostBreakdown),
  by_event_type: Schema.Array(CostBreakdown),
});
export type CostAggregate = typeof CostAggregate.Type;

export const CostQuery = Schema.Struct({
  since: Schema.optionalKey(Schema.DateFromString),
  until: Schema.optionalKey(Schema.DateFromString),
});
export type CostQuery = typeof CostQuery.Type;

export const WikiArticleOverview = Schema.Struct({
  file_path: Schema.String,
  title: Schema.String,
  precis: Schema.String,
  updated_at: Schema.NullOr(IsoDateTime),
  slug: Schema.String,
});
export type WikiArticleOverview = typeof WikiArticleOverview.Type;

export const UnmentionedLink = Schema.Struct({
  source_slug: Schema.String,
  source_title: Schema.String,
  target_slug: Schema.String,
  target_title: Schema.String,
});
export type UnmentionedLink = typeof UnmentionedLink.Type;

export const LintReport = Schema.Struct({
  orphans: Schema.Array(WikiArticleOverview),
  dirty_topics: Schema.Array(Uuid),
  unmentioned_links: Schema.Array(UnmentionedLink),
});
export type LintReport = typeof LintReport.Type;

export const WikiArticlePage = pageOf(WikiArticleOverview);
export type WikiArticlePage = typeof WikiArticlePage.Type;

export const WikiListQuery = Schema.Struct({
  ...PageParamsQuery.fields,
  run: Schema.optionalKey(Uuid),
  contains: Schema.optionalKey(Schema.String),
});
export type WikiListQuery = typeof WikiListQuery.Type;

export const FacetCount = Schema.Struct({
  value: Schema.String,
  count: Schema.Number,
});
export type FacetCount = typeof FacetCount.Type;

export const SourceDocumentSummary = Schema.Struct({
  file_path: Schema.String,
  source_type: Schema.String,
  title: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Schema.String),
  published_date: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
  genre: Schema.NullOr(Schema.String),
  precis: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  derived_extras: Schema.Record(Schema.String, Schema.Unknown),
  updated_at: Schema.NullOr(IsoDateTime),
});
export type SourceDocumentSummary = typeof SourceDocumentSummary.Type;

export const SourceDocumentFacets = Schema.Struct({
  source_types: Schema.Array(FacetCount),
});
export type SourceDocumentFacets = typeof SourceDocumentFacets.Type;

export const SourceDocumentPage = Schema.Struct({
  items: Schema.Array(SourceDocumentSummary),
  pagination: PageInfo,
  facets: SourceDocumentFacets,
});
export type SourceDocumentPage = typeof SourceDocumentPage.Type;

export const SourceListQuery = Schema.Struct({
  ...PageParamsQuery.fields,
  source_type: Schema.optionalKey(Schema.String),
  search: Schema.optionalKey(Schema.String),
});
export type SourceListQuery = typeof SourceListQuery.Type;

export const OriginScope = Schema.Literals(["vault", "personal"] as const);
export type OriginScope = typeof OriginScope.Type;

export const SessionOrigin = Schema.Struct({
  doc_path: Schema.String,
  origin_scope: OriginScope.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed("vault" as const)),
  ),
  anchor: Schema.NullOr(Schema.String),
  paragraph: Schema.NullOr(Schema.String),
  paragraph_index: Schema.NullOr(Schema.Number),
});
export type SessionOrigin = typeof SessionOrigin.Type;

export const ChunkRange = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
});
export type ChunkRange = typeof ChunkRange.Type;

export const SearchScope = Schema.Literals(["kb", "web"] as const);
export type SearchScope = typeof SearchScope.Type;

export const ThinkingSource = Schema.Struct({
  label: Schema.String,
  type: Schema.Literals(["article", "raw", "search", "query", "links"] as const),
  title: Schema.NullOr(Schema.String),
  scope: Schema.NullOr(SearchScope),
  path: Schema.NullOr(Schema.String),
  thinking: Schema.NullOr(Schema.String),
  ranges: Schema.optionalKey(Schema.Array(ChunkRange)),
  full: Schema.optionalKey(Schema.Boolean),
});
export type ThinkingSource = typeof ThinkingSource.Type;

export const ThinkingBlock = Schema.Struct({
  sources: Schema.optionalKey(Schema.Array(ThinkingSource)),
});
export type ThinkingBlock = typeof ThinkingBlock.Type;

export const BtwExchange = Schema.Struct({
  query: Schema.String,
  thinking: Schema.optionalKey(Schema.Array(ThinkingBlock)),
  answer: Schema.optionalKey(Schema.String),
});
export type BtwExchange = typeof BtwExchange.Type;

export const SessionMetaEvent = Schema.Struct({
  type: Schema.Literal("meta"),
  id: Schema.String,
  query: Schema.String,
  ts: IsoDateTime,
  user_id: Schema.String,
  origin: Schema.NullOr(SessionOrigin),
});
export type SessionMetaEvent = typeof SessionMetaEvent.Type;

export const SessionExchangeEvent = Schema.Struct({
  type: Schema.Literal("exchange"),
  exId: Schema.String,
  reply_id: Schema.optionalKey(Uuid),
  query: Schema.String,
  thinking: Schema.optionalKey(Schema.Array(ThinkingBlock)),
  answer: Schema.optionalKey(Schema.String),
  ts: IsoDateTime,
});
export type SessionExchangeEvent = typeof SessionExchangeEvent.Type;

export const SessionBtwEvent = Schema.Struct({
  type: Schema.Literal("btw"),
  exId: Schema.String,
  reply_id: Schema.optionalKey(Uuid),
  quote: Schema.String,
  blockOffset: Schema.optionalKey(Schema.Number),
  context: Schema.optionalKey(Schema.String),
  exchanges: Schema.Array(BtwExchange),
  ts: IsoDateTime,
});
export type SessionBtwEvent = typeof SessionBtwEvent.Type;

export const SessionEvent = Schema.Union([SessionMetaEvent, SessionExchangeEvent, SessionBtwEvent]);
export type SessionEvent = typeof SessionEvent.Type;

export const SessionOverview = Schema.Struct({
  id: Schema.String,
  query: Schema.String,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  user_id: Uuid,
  origin: Schema.NullOr(SessionOrigin),
});
export type SessionOverview = typeof SessionOverview.Type;

export const SessionPage = pageOf(SessionOverview);
export type SessionPage = typeof SessionPage.Type;

export const SessionResponse = Schema.Struct({
  id: Schema.String,
  events: Schema.Array(SessionEvent),
});
export type SessionResponse = typeof SessionResponse.Type;

export const SessionMarkdown = Schema.String.pipe(
  HttpApiSchema.asText({ contentType: "text/markdown" }),
);
export type SessionMarkdown = typeof SessionMarkdown.Type;

export const ExchangeData = Schema.Struct({
  id: Schema.String,
  query: Schema.String,
  thinking: Schema.Array(ThinkingBlock).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  answer: Schema.String,
  btws: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});
export type ExchangeData = typeof ExchangeData.Type;

export const BtwData = Schema.Struct({
  quote: Schema.String,
  blockOffset: Schema.Number.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(-1))),
  context: Schema.String.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(""))),
  exchangeId: Schema.String,
  exchanges: Schema.Array(BtwExchange),
});
export type BtwData = typeof BtwData.Type;

export const CreateSessionRequest = Schema.Struct({
  idempotency_key: Schema.String,
  exchange: ExchangeData,
  origin: Schema.optionalKey(SessionOrigin),
});
export type CreateSessionRequest = typeof CreateSessionRequest.Type;

export const SessionPathResponse = Schema.Struct({
  path: Schema.String,
});
export type SessionPathResponse = typeof SessionPathResponse.Type;

export const CreateSessionResponse = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
});
export type CreateSessionResponse = typeof CreateSessionResponse.Type;

export const PromoteExchangeResponse = Schema.Struct({
  mode: Schema.Literals(["ingested", "proposed"] as const),
  path: Schema.String,
  title: Schema.NullOr(Schema.String),
  document_id: Schema.NullOr(Uuid),
  proposal_id: Schema.NullOr(Uuid),
});
export type PromoteExchangeResponse = typeof PromoteExchangeResponse.Type;

export const SourceDocument = Schema.Struct({
  kind: Schema.Literal("source"),
  id: Uuid,
  vault_id: Uuid,
  file_path: Schema.String,
  body_hash: Schema.String,
  source_type: Schema.String,
  etag: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
  provenance_session_id: Schema.NullOr(Uuid),
  provenance_exchange_id: Schema.NullOr(Schema.String),
  provenance_session_query: Schema.NullOr(Schema.String),
  provenance_source_doc_path: Schema.NullOr(Schema.String),
  provenance_source_anchor: Schema.NullOr(Schema.String),
  provenance_source_paragraph_index: Schema.NullOr(Schema.Number),
  provenance_anchored_to: Schema.NullOr(Schema.String),
  provenance_anchored_section: Schema.NullOr(Schema.String),
  provenance_intent: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  precis: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Schema.String),
  published_date: Schema.NullOr(Schema.String),
  genre: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  derived_extras: Schema.Record(Schema.String, Schema.Unknown),
  created_at: Schema.NullOr(IsoDateTime),
  updated_at: Schema.NullOr(IsoDateTime),
});
export type SourceDocument = typeof SourceDocument.Type;

export const ReferenceCreate = Schema.Struct({
  url: Schema.String,
});
export type ReferenceCreate = typeof ReferenceCreate.Type;

export const ReferencePromote = Schema.Struct({
  path: Schema.String,
});
export type ReferencePromote = typeof ReferencePromote.Type;

export const ReferenceOverview = Schema.Struct({
  id: Uuid,
  file_path: Schema.String,
  title: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type ReferenceOverview = typeof ReferenceOverview.Type;

export const ReferenceDetail = Schema.Struct({
  ...ReferenceOverview.fields,
});
export type ReferenceDetail = typeof ReferenceDetail.Type;

export const ReferencePage = pageOf(ReferenceOverview);
export type ReferencePage = typeof ReferencePage.Type;

export const ReferenceDocumentResponse = Schema.Struct({
  reference: ReferenceOverview,
  body: Schema.String,
});
export type ReferenceDocumentResponse = typeof ReferenceDocumentResponse.Type;

export const ReferencePathParams = Schema.Struct({
  "*": Schema.String,
});
export type ReferencePathParams = typeof ReferencePathParams.Type;

export const ShareSubjectKind = Schema.Literals(["session", "reference"] as const);
export type ShareSubjectKind = typeof ShareSubjectKind.Type;

export const ShareCreate = Schema.Struct({
  subject_kind: ShareSubjectKind,
  subject_id: Uuid,
  include_annotations: Schema.optionalKey(Schema.Boolean),
  expires_at: Schema.optionalKey(IsoDateTime),
});
export type ShareCreate = typeof ShareCreate.Type;

export const ShareOverview = Schema.Struct({
  id: Uuid,
  subject_kind: ShareSubjectKind,
  subject_id: Uuid,
  created_by: Uuid,
  include_annotations: Schema.Boolean,
  created_at: IsoDateTime,
  expires_at: Schema.NullOr(IsoDateTime),
  revoked_at: Schema.NullOr(IsoDateTime),
});
export type ShareOverview = typeof ShareOverview.Type;

export const ShareCreated = Schema.Struct({
  ...ShareOverview.fields,
  token: Schema.String,
});
export type ShareCreated = typeof ShareCreated.Type;

export const SharedSessionDetail = Schema.Struct({
  subject_kind: Schema.Literal("session"),
  title: Schema.String,
  markdown: Schema.String,
  created_at: IsoDateTime,
});
export type SharedSessionDetail = typeof SharedSessionDetail.Type;

export const SharedReferenceDetail = Schema.Struct({
  subject_kind: Schema.Literal("reference"),
  title: Schema.NullOr(Schema.String),
  markdown: Schema.String,
  origin: Schema.NullOr(Schema.String),
  created_at: IsoDateTime,
});
export type SharedReferenceDetail = typeof SharedReferenceDetail.Type;

export const SharedShareDetail = Schema.Union([SharedSessionDetail, SharedReferenceDetail]);
export type SharedShareDetail = typeof SharedShareDetail.Type;

export const WikiArticle = Schema.Struct({
  kind: Schema.Literal("wiki"),
  id: Uuid,
  vault_id: Uuid,
  topic_id: Uuid,
  file_path: Schema.String,
  body_hash: Schema.String,
  title: Schema.String,
  precis: Schema.String,
  tags: Schema.Array(Schema.String),
  created_at: Schema.NullOr(IsoDateTime),
  updated_at: Schema.NullOr(IsoDateTime),
  slug: Schema.String,
});
export type WikiArticle = typeof WikiArticle.Type;

export const DocResponse = Schema.Struct({
  article: Schema.Union([SourceDocument, WikiArticle]),
  body: Schema.String,
  archived: Schema.Boolean,
  superseded_by: Schema.NullOr(Schema.String),
});
export type DocResponse = typeof DocResponse.Type;

export const DocPathParams = Schema.Struct({
  vault_id: Uuid,
  "*": Schema.String,
});
export type DocPathParams = typeof DocPathParams.Type;

export const SourcePathParams = Schema.Struct({
  vault_id: Uuid,
  "*": Schema.String,
});
export type SourcePathParams = typeof SourcePathParams.Type;

const ChunkBoundary = Schema.NumberFromString.pipe(Schema.check(Schema.isInt()));

export const ChunkRangeQuery = Schema.Struct({
  path: Schema.String,
  start: ChunkBoundary,
  end: ChunkBoundary,
});
export type ChunkRangeQuery = typeof ChunkRangeQuery.Type;

export const Chunk = Schema.Struct({
  path: Schema.String,
  chunk_index: Schema.Number,
  heading: Schema.String,
  body: Schema.String,
  content_hash: Schema.String,
});
export type Chunk = typeof Chunk.Type;

export const LinkQuery = Schema.Struct({
  path: Schema.String,
});
export type LinkQuery = typeof LinkQuery.Type;

export const LinkedArticles = Schema.Struct({
  outgoing: Schema.Array(WikiArticleOverview),
  incoming: Schema.Array(WikiArticleOverview),
});
export type LinkedArticles = typeof LinkedArticles.Type;

export const HistoryMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"] as const),
  content: Schema.String,
});
export type HistoryMessage = typeof HistoryMessage.Type;

export const QueryMode = Schema.Literals(["query", "btw"] as const);
export type QueryMode = typeof QueryMode.Type;

export const QueryRequest = Schema.Struct({
  question: Schema.String,
  model: Schema.optionalKey(Schema.String),
  mode: QueryMode.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed("query" as const))),
  origin_path: Schema.optionalKey(Schema.String),
  origin_scope: OriginScope.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed("vault" as const)),
  ),
  history: Schema.Array(HistoryMessage).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  extra_instructions: Schema.optionalKey(Schema.String),
});
export type QueryRequest = typeof QueryRequest.Type;

export const QuerySourceArticle = Schema.Struct({
  type: Schema.Literals(["article", "raw"] as const),
  path: Schema.String,
  title: Schema.NullOr(Schema.String),
  start: Schema.optionalKey(Schema.Number),
  end: Schema.optionalKey(Schema.Number),
});
export type QuerySourceArticle = typeof QuerySourceArticle.Type;

export const QuerySourceSearch = Schema.Struct({
  type: Schema.Literal("search"),
  query: Schema.String,
  scope: SearchScope,
  // Set when the search was scoped to a single document.
  path: Schema.optionalKey(Schema.String),
  title: Schema.NullOr(Schema.String),
});
export type QuerySourceSearch = typeof QuerySourceSearch.Type;

export const QuerySourceQuery = Schema.Struct({
  type: Schema.Literal("query"),
  filters: Schema.Record(Schema.String, Schema.Unknown),
});
export type QuerySourceQuery = typeof QuerySourceQuery.Type;

export const QuerySourceLinks = Schema.Struct({
  type: Schema.Literal("links"),
  path: Schema.String,
  title: Schema.NullOr(Schema.String),
});
export type QuerySourceLinks = typeof QuerySourceLinks.Type;

export const QuerySourceData = Schema.Union([
  QuerySourceArticle,
  QuerySourceSearch,
  QuerySourceQuery,
  QuerySourceLinks,
]);
export type QuerySourceData = typeof QuerySourceData.Type;

export const QueryStreamPayload = Schema.Union([
  Schema.Struct({ event: Schema.Literal("token"), data: Schema.Struct({ text: Schema.String }) }),
  Schema.Struct({
    event: Schema.Literal("source_pending"),
    data: Schema.Struct({ call_id: Schema.String, source: QuerySourceData }),
  }),
  Schema.Struct({
    event: Schema.Literal("source_settled"),
    data: Schema.Struct({ call_id: Schema.String }),
  }),
  Schema.Struct({ event: Schema.Literal("source"), data: QuerySourceData }),
  Schema.Struct({ event: Schema.Literal("done"), data: Schema.Struct({}) }),
  Schema.Struct({
    event: Schema.Literal("error"),
    data: Schema.Struct({ message: Schema.String }),
  }),
]);
export type QueryStreamPayload = typeof QueryStreamPayload.Type;

export const ReplySource = Schema.Struct({
  ...ThinkingSource.fields,
  pending: Schema.optionalKey(Schema.Boolean),
});
export type ReplySource = typeof ReplySource.Type;

const CreateReplyFields = {
  ...QueryRequest.fields,
};

const CreateReplySession = Schema.Struct({
  idempotency_key: Schema.String,
  origin_scope: OriginScope.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed("vault" as const)),
  ),
  origin: Schema.optionalKey(SessionOrigin),
});

export const CreateReplyRequest = Schema.Union([
  Schema.Struct({
    ...CreateReplyFields,
    kind: Schema.Literal("exchange"),
    exchange_id: Schema.String,
    session_id: SessionId,
  }),
  Schema.Struct({
    ...CreateReplyFields,
    kind: Schema.Literal("exchange"),
    exchange_id: Schema.String,
    create: CreateReplySession,
  }),
  Schema.Struct({
    ...CreateReplyFields,
    kind: Schema.Literal("btw"),
    session_id: SessionId,
    btw: BtwData,
  }),
  Schema.Struct({
    ...CreateReplyFields,
    kind: Schema.Literal("ephemeral"),
  }),
]);
export type CreateReplyRequest = typeof CreateReplyRequest.Type;

export const CreateReplyResponse = Schema.Struct({
  reply_id: Uuid,
  session_id: Schema.NullOr(SessionId),
});
export type CreateReplyResponse = typeof CreateReplyResponse.Type;

export const ReplySnapshot = Schema.Struct({
  reply_id: Uuid,
  session_id: Schema.NullOr(SessionId),
  kind: Schema.Literals(["exchange", "btw", "ephemeral"] as const),
  status: Schema.Literals(["running", "completed", "failed"] as const),
  answer: Schema.String,
  sources: Schema.Array(ReplySource),
  error: Schema.NullOr(Schema.String),
  version: Schema.Number,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type ReplySnapshot = typeof ReplySnapshot.Type;

export const ReplySseEvent = Sse.EventEncoded;
export type ReplySseEvent = typeof ReplySseEvent.Type;

export const DraftHintRequest = Schema.Struct({
  description: Schema.String,
});
export type DraftHintRequest = typeof DraftHintRequest.Type;

export const DraftHintResponse = Schema.Struct({
  thematic_hint: Schema.String,
});
export type DraftHintResponse = typeof DraftHintResponse.Type;

export class CurrentAuth extends Context.Service<CurrentAuth, AuthContext>()(
  "@great-minds/domain/CurrentAuth",
) {}

export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()("Unauthorized", {
  detail: Schema.String,
}) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()("Forbidden", {
  detail: Schema.String,
}) {}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("NotFound", {
  detail: Schema.String,
}) {}

export class Validation extends Schema.TaggedErrorClass<Validation>()("Validation", {
  detail: Schema.String,
}) {}

export class BadRequest extends Schema.TaggedErrorClass<BadRequest>()("BadRequest", {
  detail: Schema.String,
}) {}

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("Conflict", {
  detail: Schema.String,
}) {}

export class ServiceUnavailable extends Schema.TaggedErrorClass<ServiceUnavailable>()(
  "ServiceUnavailable",
  {
    detail: Schema.String,
  },
) {}

export type DomainError =
  | Unauthorized
  | Forbidden
  | NotFound
  | Validation
  | BadRequest
  | Conflict
  | ServiceUnavailable;

const ErrorDetail = Schema.Struct({
  detail: Schema.String,
});

const BadRequestResponse = ErrorDetail.pipe(HttpApiSchema.status(400));
const UnauthorizedResponse = ErrorDetail.pipe(HttpApiSchema.status(401));
const ConflictResponse = ErrorDetail.pipe(HttpApiSchema.status(409));
const ForbiddenResponse = ErrorDetail.pipe(HttpApiSchema.status(403));
const NotFoundResponse = ErrorDetail.pipe(HttpApiSchema.status(404));
const ValidationResponse = ErrorDetail.pipe(HttpApiSchema.status(422));
const ServiceUnavailableResponse = ErrorDetail.pipe(HttpApiSchema.status(503));

const ValidationErrors = [ValidationResponse] as const;
const UnauthorizedValidationErrors = [UnauthorizedResponse, ValidationResponse] as const;
const NotFoundValidationErrors = [NotFoundResponse, ValidationResponse] as const;
const ForbiddenValidationErrors = [ForbiddenResponse, ValidationResponse] as const;
const ForbiddenNotFoundValidationErrors = [
  ForbiddenResponse,
  NotFoundResponse,
  ValidationResponse,
] as const;
const ForbiddenNotFoundConflictValidationErrors = [
  ForbiddenResponse,
  NotFoundResponse,
  ConflictResponse,
  ValidationResponse,
] as const;
const DocumentErrors = [
  BadRequestResponse,
  ForbiddenResponse,
  NotFoundResponse,
  ValidationResponse,
] as const;
const ReferenceDocumentErrors = [
  BadRequestResponse,
  NotFoundResponse,
  ValidationResponse,
] as const;
const CreateReplyErrors = [
  ForbiddenResponse,
  NotFoundResponse,
  ServiceUnavailableResponse,
  ValidationResponse,
] as const;

export class AuthMiddleware extends HttpApiMiddleware.Service<
  AuthMiddleware,
  {
    provides: CurrentAuth;
  }
>()("@great-minds/domain/AuthMiddleware", {
  error: UnauthorizedResponse,
  security: {
    bearer: HttpApiSecurity.bearer,
  },
}) {}

const CreatedApiKeyWithSecret = ApiKeyWithSecret.pipe(HttpApiSchema.status("Created"));
const ApiKeys = Schema.Array(ApiKey);
const CreatedPasskey = Passkey.pipe(HttpApiSchema.status("Created"));
const Passkeys = Schema.Array(Passkey);
const CreatedVault = Vault.pipe(HttpApiSchema.status("Created"));
const CreatedMember = MemberWithEmail.pipe(HttpApiSchema.status("Created"));
const CreatedProposal = Proposal.pipe(HttpApiSchema.status("Created"));
const CreatedIngestedDocument = IngestedDocument.pipe(HttpApiSchema.status("Created"));
const CreatedJobResponse = JobResponse.pipe(HttpApiSchema.status("Created"));
const CreatedSessionResponse = CreateSessionResponse.pipe(HttpApiSchema.status("Created"));
const CreatedReferenceDetail = ReferenceDetail.pipe(HttpApiSchema.status("Created"));
const CreatedShare = ShareCreated.pipe(HttpApiSchema.status("Created"));
const Shares = Schema.Array(ShareOverview);
const CreatedPromoteExchangeResponse = PromoteExchangeResponse.pipe(
  HttpApiSchema.status("Created"),
);
const AcceptedJobResponse = JobResponse.pipe(HttpApiSchema.status(202));
const JobStream = HttpApiSchema.StreamSse({ events: JobSseEvent });
const AcceptedReplyResponse = CreateReplyResponse.pipe(HttpApiSchema.status(202));
const ReplyStream = HttpApiSchema.StreamSse({ events: ReplySseEvent });

export const AuthApiGroup = HttpApiGroup.make("auth").add(
  HttpApiEndpoint.post("requestCode", "/auth/request-code", {
    payload: RequestCodeInput,
    success: HttpApiSchema.NoContent,
    error: ValidationErrors,
  }),
  HttpApiEndpoint.post("verifyCode", "/auth/verify-code", {
    payload: VerifyCodeInput,
    success: TokenPair,
    error: UnauthorizedValidationErrors,
  }),
  HttpApiEndpoint.post("refresh", "/auth/refresh", {
    payload: RefreshInput,
    success: TokenPair,
    error: UnauthorizedValidationErrors,
  }),
  HttpApiEndpoint.post("passkeyRegisterOptions", "/auth/passkeys/register-options", {
    success: PasskeyRegistrationOptions,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post("registerPasskey", "/auth/passkeys/register", {
    payload: PasskeyRegistration,
    success: CreatedPasskey,
    error: ValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post("passkeyAuthenticationOptions", "/auth/passkeys/options", {
    success: PasskeyAuthenticationOptions,
  }),
  HttpApiEndpoint.post("verifyPasskey", "/auth/passkeys/verify", {
    payload: PasskeyAuthentication,
    success: TokenPair,
    error: UnauthorizedValidationErrors,
  }),
  HttpApiEndpoint.get("listPasskeys", "/auth/passkeys", {
    success: Passkeys,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.delete("deletePasskey", "/auth/passkeys/:id", {
    params: {
      id: Uuid,
    },
    success: HttpApiSchema.NoContent,
    error: NotFoundValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post("createApiKey", "/auth/api-keys", {
    payload: ApiKeyCreate,
    success: CreatedApiKeyWithSecret,
    error: ValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("listApiKeys", "/auth/api-keys", {
    success: ApiKeys,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.delete("deleteApiKey", "/auth/api-keys/:key_id", {
    params: {
      key_id: Uuid,
    },
    success: HttpApiSchema.NoContent,
    error: NotFoundValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.delete("deleteMe", "/auth/me", {
    payload: AccountDeleteRequest,
    success: HttpApiSchema.NoContent,
    error: NotFoundValidationErrors,
  }).middleware(AuthMiddleware),
);

export const MetaApiGroup = HttpApiGroup.make("meta").add(
  HttpApiEndpoint.get("health", "/health", {
    success: Schema.Struct({ status: Schema.Literal("ok") }),
  }),
);

export const RefsApiGroup = HttpApiGroup.make("refs")
  .add(
    HttpApiEndpoint.post("createReference", "/me/refs", {
      payload: ReferenceCreate,
      success: CreatedReferenceDetail,
      error: [BadRequestResponse, ValidationResponse] as const,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get("listReferences", "/me/refs", {
      query: PageParamsQuery,
      success: ReferencePage,
      error: ValidationErrors,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get("readReference", "/me/refs/doc/*", {
      params: ReferencePathParams,
      success: ReferenceDocumentResponse,
      error: ReferenceDocumentErrors,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete("deleteReference", "/me/refs/*", {
      params: ReferencePathParams,
      success: HttpApiSchema.NoContent,
      error: ReferenceDocumentErrors,
    }).middleware(AuthMiddleware),
  );

export const VaultsApiGroup = HttpApiGroup.make("vaults").add(
  HttpApiEndpoint.get("listVaults", "/vaults", {
    query: PageParamsQuery,
    success: VaultPage,
    error: ValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post("createVault", "/vaults", {
    payload: VaultCreate,
    success: CreatedVault,
    error: ValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post("draftVaultHint", "/vaults/draft-hint", {
    payload: DraftHintRequest,
    success: DraftHintResponse,
    error: [BadRequestResponse, ServiceUnavailableResponse, ValidationResponse] as const,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("getVault", "/vaults/:vault_id", {
    params: {
      vault_id: Uuid,
    },
    success: VaultDetail,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("getVaultConfig", "/vaults/:vault_id/config", {
    params: {
      vault_id: Uuid,
    },
    success: VaultConfig,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.patch("updateVaultConfig", "/vaults/:vault_id/config", {
    params: {
      vault_id: Uuid,
    },
    payload: VaultConfigUpdate,
    success: VaultConfig,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("listVaultMembers", "/vaults/:vault_id/members", {
    params: {
      vault_id: Uuid,
    },
    query: PageParamsQuery,
    success: MemberPage,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post("inviteVaultMember", "/vaults/:vault_id/members", {
    params: {
      vault_id: Uuid,
    },
    payload: MembershipInvite,
    success: CreatedMember,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.put("updateVaultMember", "/vaults/:vault_id/members/:member_user_id", {
    params: {
      vault_id: Uuid,
      member_user_id: Uuid,
    },
    payload: MembershipUpdate,
    success: MemberWithEmail,
    error: ForbiddenNotFoundValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.delete("removeVaultMember", "/vaults/:vault_id/members/:member_user_id", {
    params: {
      vault_id: Uuid,
      member_user_id: Uuid,
    },
    success: HttpApiSchema.NoContent,
    error: ForbiddenNotFoundValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post("transferVaultOwnership", "/vaults/:vault_id/transfer-ownership", {
    params: {
      vault_id: Uuid,
    },
    payload: OwnershipTransfer,
    success: HttpApiSchema.NoContent,
    error: [BadRequestResponse, ForbiddenResponse, ValidationResponse] as const,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.delete("deleteVault", "/vaults/:vault_id", {
    params: {
      vault_id: Uuid,
    },
    success: HttpApiSchema.NoContent,
    error: ForbiddenNotFoundValidationErrors,
  }).middleware(AuthMiddleware),
);

export const WikiApiGroup = HttpApiGroup.make("wiki").add(
  HttpApiEndpoint.get("listWikiArticles", "/vaults/:vault_id/wiki", {
    params: {
      vault_id: Uuid,
    },
    query: WikiListQuery,
    success: WikiArticlePage,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("listRecentWikiArticles", "/vaults/:vault_id/wiki/recent", {
    params: {
      vault_id: Uuid,
    },
    query: PageParamsQuery,
    success: WikiArticlePage,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
);

export const SourcesApiGroup = HttpApiGroup.make("sources").add(
  HttpApiEndpoint.get("listSources", "/vaults/:vault_id/raw/sources", {
    params: {
      vault_id: Uuid,
    },
    query: SourceListQuery,
    success: SourceDocumentPage,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.delete("deleteSource", "/vaults/:vault_id/raw/sources/*", {
    params: SourcePathParams,
    success: HttpApiSchema.NoContent,
    error: DocumentErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post("requestSourceDeletion", "/vaults/:vault_id/raw/sources/*", {
    params: SourcePathParams,
    success: CreatedProposal,
    error: [
      BadRequestResponse,
      ForbiddenResponse,
      NotFoundResponse,
      ConflictResponse,
      ValidationResponse,
    ] as const,
  }).middleware(AuthMiddleware),
);

export const ProposalsApiGroup = HttpApiGroup.make("proposals").add(
  HttpApiEndpoint.get("listProposals", "/vaults/:vault_id/proposals", {
    params: {
      vault_id: Uuid,
    },
    query: ProposalListQuery,
    success: ProposalPage,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post("createProposal", "/vaults/:vault_id/proposals", {
    params: {
      vault_id: Uuid,
    },
    payload: ProposalCreate,
    success: CreatedProposal,
    error: [BadRequestResponse, ForbiddenResponse, ValidationResponse] as const,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("getProposal", "/vaults/:vault_id/proposals/:proposal_id", {
    params: {
      vault_id: Uuid,
      proposal_id: Uuid,
    },
    success: Proposal,
    error: ForbiddenNotFoundValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.patch("reviewProposal", "/vaults/:vault_id/proposals/:proposal_id", {
    params: {
      vault_id: Uuid,
      proposal_id: Uuid,
    },
    payload: ProposalUpdate,
    success: Proposal,
    error: ForbiddenNotFoundConflictValidationErrors,
  }).middleware(AuthMiddleware),
);

export const IngestApiGroup = HttpApiGroup.make("ingest").add(
  HttpApiEndpoint.post("ingestRaw", "/vaults/:vault_id/ingest", {
    params: {
      vault_id: Uuid,
    },
    payload: RawSource,
    success: CreatedIngestedDocument,
    error: [ForbiddenResponse, ValidationResponse] as const,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post("promoteReference", "/vaults/:vault_id/ingest/reference", {
    params: {
      vault_id: Uuid,
    },
    payload: ReferencePromote,
    success: CreatedIngestedDocument,
    error: [
      BadRequestResponse,
      ForbiddenResponse,
      NotFoundResponse,
      ValidationResponse,
    ] as const,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post("ingestUserSuggestion", "/vaults/:vault_id/ingest/user-suggestion", {
    params: {
      vault_id: Uuid,
    },
    payload: UserSuggestion,
    success: CreatedIngestedDocument,
    error: [BadRequestResponse, ForbiddenResponse, ValidationResponse] as const,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post(
    "checkStagedFileDupes",
    "/vaults/:vault_id/ingest/staged-files/check-dupes",
    {
      params: {
        vault_id: Uuid,
      },
      payload: CheckDupesRequest,
      success: CheckDupesResponse,
      error: ForbiddenValidationErrors,
    },
  ).middleware(AuthMiddleware),
  HttpApiEndpoint.post("signStagedFiles", "/vaults/:vault_id/ingest/staged-files/sign", {
    params: {
      vault_id: Uuid,
    },
    payload: StagedFileSignRequest,
    success: StagedFileSignResponse,
    error: [BadRequestResponse, ForbiddenResponse, ValidationResponse] as const,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post("processStagedFiles", "/vaults/:vault_id/ingest/staged-files/process", {
    params: {
      vault_id: Uuid,
    },
    payload: StagedFileProcessRequest,
    success: JobResponse,
    error: [BadRequestResponse, ForbiddenResponse, ValidationResponse] as const,
  }).middleware(AuthMiddleware),
);

export const JobsApiGroup = HttpApiGroup.make("jobs").add(
  HttpApiEndpoint.post("startUrlJob", "/vaults/:vault_id/jobs/url", {
    params: {
      vault_id: Uuid,
    },
    payload: URLSource,
    success: CreatedJobResponse,
    error: [BadRequestResponse, ForbiddenResponse, ValidationResponse] as const,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("listJobs", "/vaults/:vault_id/jobs", {
    params: { vault_id: Uuid },
    query: JobListQuery,
    success: JobPage,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("getJob", "/vaults/:vault_id/jobs/:job_id", {
    params: { vault_id: Uuid, job_id: Uuid },
    success: JobResponse,
    error: ForbiddenNotFoundValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("streamJob", "/vaults/:vault_id/jobs/:job_id/stream", {
    params: { vault_id: Uuid, job_id: Uuid },
    success: JobStream,
    error: ForbiddenNotFoundValidationErrors,
  }).middleware(AuthMiddleware),
);

export const CompileApiGroup = HttpApiGroup.make("compile")
  .add(
    HttpApiEndpoint.post("requestCompile", "/vaults/:vault_id/compile", {
      params: { vault_id: Uuid },
      payload: CompileRequest,
      success: AcceptedJobResponse,
      error: [ForbiddenResponse, ServiceUnavailableResponse, ValidationResponse] as const,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post("cancelCompile", "/vaults/:vault_id/compile/:run_id/cancel", {
      params: { vault_id: Uuid, run_id: Uuid },
      success: HttpApiSchema.NoContent,
      error: ForbiddenValidationErrors,
    }).middleware(AuthMiddleware),
  );

export const LintApiGroup = HttpApiGroup.make("lint").add(
  HttpApiEndpoint.get("getLint", "/vaults/:vault_id/lint", {
    params: { vault_id: Uuid },
    success: LintReport,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
);

export const CostsApiGroup = HttpApiGroup.make("costs")
  .add(
    HttpApiEndpoint.get("getUserCosts", "/costs", {
      query: CostQuery,
      success: CostAggregate,
      error: ValidationErrors,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get("getVaultCosts", "/vaults/:vault_id/costs", {
      params: { vault_id: Uuid },
      query: CostQuery,
      success: CostAggregate,
      error: ForbiddenValidationErrors,
    }).middleware(AuthMiddleware),
  );

export const DocumentsApiGroup = HttpApiGroup.make("documents").add(
  HttpApiEndpoint.get("readDocument", "/vaults/:vault_id/doc/*", {
    params: DocPathParams,
    success: DocResponse,
    error: DocumentErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("readChunks", "/vaults/:vault_id/chunks", {
    params: {
      vault_id: Uuid,
    },
    query: ChunkRangeQuery,
    success: Schema.Array(Chunk),
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("readLinks", "/vaults/:vault_id/links", {
    params: {
      vault_id: Uuid,
    },
    query: LinkQuery,
    success: LinkedArticles,
    error: ForbiddenNotFoundValidationErrors,
  }).middleware(AuthMiddleware),
);

export const SessionsApiGroup = HttpApiGroup.make("sessions").add(
  HttpApiEndpoint.post("createSession", "/vaults/:vault_id/sessions", {
    params: {
      vault_id: Uuid,
    },
    payload: CreateSessionRequest,
    success: CreatedSessionResponse,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.patch("appendSessionExchange", "/vaults/:vault_id/sessions/:session_id", {
    params: {
      vault_id: Uuid,
      session_id: SessionId,
    },
    payload: ExchangeData,
    success: SessionPathResponse,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.patch("appendSessionBtw", "/vaults/:vault_id/sessions/:session_id/btw", {
    params: {
      vault_id: Uuid,
      session_id: SessionId,
    },
    payload: BtwData,
    success: SessionPathResponse,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.post(
    "promoteSessionExchange",
    "/vaults/:vault_id/sessions/:session_id/exchanges/:exchange_id/promote",
    {
      params: {
        vault_id: Uuid,
        session_id: SessionId,
        exchange_id: Schema.String,
      },
      success: CreatedPromoteExchangeResponse,
      error: [BadRequestResponse, ForbiddenResponse, NotFoundResponse, ValidationResponse] as const,
    },
  ).middleware(AuthMiddleware),
  HttpApiEndpoint.get("listSessions", "/vaults/:vault_id/sessions", {
    params: {
      vault_id: Uuid,
    },
    query: PageParamsQuery,
    success: SessionPage,
    error: ForbiddenValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("readSession", "/vaults/:vault_id/sessions/:session_id", {
    params: {
      vault_id: Uuid,
      session_id: SessionId,
    },
    success: SessionResponse,
    error: ForbiddenNotFoundValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("readSessionMarkdown", "/vaults/:vault_id/sessions/:session_id/markdown", {
    params: {
      vault_id: Uuid,
      session_id: SessionId,
    },
    success: SessionMarkdown,
    error: ForbiddenNotFoundValidationErrors,
  }).middleware(AuthMiddleware),
);

export const RepliesApiGroup = HttpApiGroup.make("replies")
  .add(
    HttpApiEndpoint.post("createReply", "/vaults/:vault_id/replies", {
      params: {
        vault_id: Uuid,
      },
      payload: CreateReplyRequest,
      success: AcceptedReplyResponse,
      error: CreateReplyErrors,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get("streamReply", "/vaults/:vault_id/replies/:reply_id/stream", {
      params: {
        vault_id: Uuid,
        reply_id: Uuid,
      },
      success: ReplyStream,
      error: ForbiddenNotFoundValidationErrors,
    }).middleware(AuthMiddleware),
  );

export const SharesApiGroup = HttpApiGroup.make("shares").add(
  HttpApiEndpoint.post("createShare", "/shares", {
    payload: ShareCreate,
    success: CreatedShare,
    error: ForbiddenNotFoundValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("listShares", "/shares", {
    success: Shares,
    error: ValidationErrors,
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.delete("deleteShare", "/shares/:share_id", {
    params: {
      share_id: Uuid,
    },
    success: HttpApiSchema.NoContent,
    error: NotFoundValidationErrors,
  }).middleware(AuthMiddleware),
);

export const PublicApiGroup = HttpApiGroup.make("public").add(
  HttpApiEndpoint.get("resolveShare", "/public/shares/:token", {
    params: {
      token: Schema.String,
    },
    success: SharedShareDetail,
    error: NotFoundValidationErrors,
  }),
);

export const GreatMindsApi = HttpApi.make("great-minds").add(
  MetaApiGroup,
  AuthApiGroup,
  RefsApiGroup,
  VaultsApiGroup,
  WikiApiGroup,
  SourcesApiGroup,
  ProposalsApiGroup,
  IngestApiGroup,
  JobsApiGroup,
  CompileApiGroup,
  LintApiGroup,
  CostsApiGroup,
  DocumentsApiGroup,
  SessionsApiGroup,
  RepliesApiGroup,
  SharesApiGroup,
  PublicApiGroup,
);

import { Context, Effect, Schema } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

export const Email = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(320)),
  Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  Schema.brand("Email")
);
export type Email = typeof Email.Type;

export const Uuid = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  ),
  Schema.brand("Uuid")
);
export type Uuid = typeof Uuid.Type;

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

export const RequestCodeInput = Schema.Struct({
  email: Email
});
export type RequestCodeInput = typeof RequestCodeInput.Type;

export const VerifyCodeInput = Schema.Struct({
  email: Email,
  code: Schema.String
});
export type VerifyCodeInput = typeof VerifyCodeInput.Type;

export const RefreshInput = Schema.Struct({
  refresh_token: Schema.String
});
export type RefreshInput = typeof RefreshInput.Type;

export const TokenPair = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  token_type: Schema.Literal("bearer")
});
export type TokenPair = typeof TokenPair.Type;

export const ApiKeyCreate = Schema.Struct({
  label: Schema.String
});
export type ApiKeyCreate = typeof ApiKeyCreate.Type;

export const ApiKey = Schema.Struct({
  id: Uuid,
  label: Schema.String,
  created_at: IsoDateTime,
  revoked: Schema.Boolean
});
export type ApiKey = typeof ApiKey.Type;

export const ApiKeyWithSecret = Schema.Struct({
  ...ApiKey.fields,
  raw_key: Schema.String
});
export type ApiKeyWithSecret = typeof ApiKeyWithSecret.Type;

export const AccountDeleteRequest = Schema.Struct({
  confirm: Schema.Literal("DELETE")
});
export type AccountDeleteRequest = typeof AccountDeleteRequest.Type;

export const CredentialKind = Schema.Literals(["jwt", "api_key"] as const);
export type CredentialKind = typeof CredentialKind.Type;

export const AuthContext = Schema.Struct({
  user_id: Uuid,
  email: Email,
  credential_kind: CredentialKind
});
export type AuthContext = typeof AuthContext.Type;

const PageLimit = Schema.NumberFromString.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(200)
  ),
  Schema.withDecodingDefaultTypeKey(Effect.succeed(50))
);

const PageOffset = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  Schema.withDecodingDefaultTypeKey(Effect.succeed(0))
);

export const PageParamsQuery = Schema.Struct({
  limit: PageLimit,
  offset: PageOffset
});
export type PageParams = typeof PageParamsQuery.Type;

export const PageInfo = Schema.Struct({
  limit: Schema.Number,
  offset: Schema.Number,
  total: Schema.Number
});
export type PageInfo = typeof PageInfo.Type;

const pageOf = <A extends Schema.Top>(item: A) =>
  Schema.Struct({
    items: Schema.Array(item),
    pagination: PageInfo
  });

export const MemberRole = Schema.Literals(["owner", "editor", "viewer"] as const);
export type MemberRole = typeof MemberRole.Type;

export const Vault = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  owner_id: Uuid,
  created_at: IsoDateTime,
  r2_bucket_name: Schema.NullOr(Schema.String)
});
export type Vault = typeof Vault.Type;

export const VaultPage = Schema.Struct({
  items: Schema.Array(Vault),
  pagination: PageInfo,
  roles: Schema.Record(Schema.String, MemberRole)
});
export type VaultPage = typeof VaultPage.Type;

export const VaultDetail = Schema.Struct({
  ...Vault.fields,
  role: MemberRole,
  member_count: Schema.Number,
  article_count: Schema.Number
});
export type VaultDetail = typeof VaultDetail.Type;

export const VaultConfig = Schema.Struct({
  thematic_hint: Schema.String,
  kinds: Schema.Array(Schema.String)
});
export type VaultConfig = typeof VaultConfig.Type;

export const MemberWithEmail = Schema.Struct({
  user_id: Uuid,
  email: Email,
  role: MemberRole
});
export type MemberWithEmail = typeof MemberWithEmail.Type;

export const MemberPage = pageOf(MemberWithEmail);
export type MemberPage = typeof MemberPage.Type;

export const WikiArticleOverview = Schema.Struct({
  file_path: Schema.String,
  title: Schema.String,
  precis: Schema.String,
  updated_at: Schema.NullOr(IsoDateTime),
  slug: Schema.String
});
export type WikiArticleOverview = typeof WikiArticleOverview.Type;

export const WikiArticlePage = pageOf(WikiArticleOverview);
export type WikiArticlePage = typeof WikiArticlePage.Type;

export const WikiListQuery = Schema.Struct({
  ...PageParamsQuery.fields,
  run: Schema.optionalKey(Uuid)
});
export type WikiListQuery = typeof WikiListQuery.Type;

export const FacetCount = Schema.Struct({
  value: Schema.String,
  count: Schema.Number
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
  updated_at: Schema.NullOr(IsoDateTime)
});
export type SourceDocumentSummary = typeof SourceDocumentSummary.Type;

export const SourceDocumentFacets = Schema.Struct({
  source_types: Schema.Array(FacetCount)
});
export type SourceDocumentFacets = typeof SourceDocumentFacets.Type;

export const SourceDocumentPage = Schema.Struct({
  items: Schema.Array(SourceDocumentSummary),
  pagination: PageInfo,
  facets: SourceDocumentFacets
});
export type SourceDocumentPage = typeof SourceDocumentPage.Type;

export const SourceListQuery = Schema.Struct({
  ...PageParamsQuery.fields,
  source_type: Schema.optionalKey(Schema.String),
  search: Schema.optionalKey(Schema.String)
});
export type SourceListQuery = typeof SourceListQuery.Type;

export class CurrentAuth extends Context.Service<CurrentAuth, AuthContext>()(
  "@great-minds/domain/CurrentAuth"
) {}

export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()("Unauthorized", {
  detail: Schema.String
}) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()("Forbidden", {
  detail: Schema.String
}) {}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("NotFound", {
  detail: Schema.String
}) {}

export class Validation extends Schema.TaggedErrorClass<Validation>()("Validation", {
  detail: Schema.String
}) {}

export type DomainError = Unauthorized | Forbidden | NotFound | Validation;

export class AuthMiddleware extends HttpApiMiddleware.Service<AuthMiddleware, {
  provides: CurrentAuth;
}>()("@great-minds/domain/AuthMiddleware", {
  error: Unauthorized,
  security: {
    bearer: HttpApiSecurity.bearer
  }
}) {}

const CreatedApiKeyWithSecret = ApiKeyWithSecret.pipe(HttpApiSchema.status("Created"));
const ApiKeys = Schema.Array(ApiKey);

export const AuthApiGroup = HttpApiGroup.make("auth").add(
  HttpApiEndpoint.post("requestCode", "/auth/request-code", {
    payload: RequestCodeInput,
    success: HttpApiSchema.NoContent
  }),
  HttpApiEndpoint.post("verifyCode", "/auth/verify-code", {
    payload: VerifyCodeInput,
    success: TokenPair
  }),
  HttpApiEndpoint.post("refresh", "/auth/refresh", {
    payload: RefreshInput,
    success: TokenPair
  }),
  HttpApiEndpoint.post("createApiKey", "/auth/api-keys", {
    payload: ApiKeyCreate,
    success: CreatedApiKeyWithSecret
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("listApiKeys", "/auth/api-keys", {
    success: ApiKeys
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.delete("deleteApiKey", "/auth/api-keys/:key_id", {
    params: {
      key_id: Uuid
    },
    success: HttpApiSchema.NoContent
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.delete("deleteMe", "/auth/me", {
    payload: AccountDeleteRequest,
    success: HttpApiSchema.NoContent
  }).middleware(AuthMiddleware)
);

export const MetaApiGroup = HttpApiGroup.make("meta").add(
  HttpApiEndpoint.get("health", "/health", {
    success: Schema.Struct({ status: Schema.Literal("ok") })
  })
);

export const VaultsApiGroup = HttpApiGroup.make("vaults").add(
  HttpApiEndpoint.get("listVaults", "/vaults", {
    query: PageParamsQuery,
    success: VaultPage
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("getVault", "/vaults/:vault_id", {
    params: {
      vault_id: Uuid
    },
    success: VaultDetail
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("getVaultConfig", "/vaults/:vault_id/config", {
    params: {
      vault_id: Uuid
    },
    success: VaultConfig
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("listVaultMembers", "/vaults/:vault_id/members", {
    params: {
      vault_id: Uuid
    },
    query: PageParamsQuery,
    success: MemberPage
  }).middleware(AuthMiddleware)
);

export const WikiApiGroup = HttpApiGroup.make("wiki").add(
  HttpApiEndpoint.get("listWikiArticles", "/vaults/:vault_id/wiki", {
    params: {
      vault_id: Uuid
    },
    query: WikiListQuery,
    success: WikiArticlePage
  }).middleware(AuthMiddleware),
  HttpApiEndpoint.get("listRecentWikiArticles", "/vaults/:vault_id/wiki/recent", {
    params: {
      vault_id: Uuid
    },
    query: PageParamsQuery,
    success: WikiArticlePage
  }).middleware(AuthMiddleware)
);

export const SourcesApiGroup = HttpApiGroup.make("sources").add(
  HttpApiEndpoint.get("listSources", "/vaults/:vault_id/raw/sources", {
    params: {
      vault_id: Uuid
    },
    query: SourceListQuery,
    success: SourceDocumentPage
  }).middleware(AuthMiddleware)
);

export const GreatMindsApi = HttpApi.make("great-minds").add(
  MetaApiGroup,
  AuthApiGroup,
  VaultsApiGroup,
  WikiApiGroup,
  SourcesApiGroup
);

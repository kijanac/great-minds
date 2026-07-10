import { Context, Schema } from "effect";
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

export const GreatMindsApi = HttpApi.make("great-minds").add(MetaApiGroup, AuthApiGroup);

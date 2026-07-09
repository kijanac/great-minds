import { Schema } from "effect";

export const Email = Schema.String.pipe(
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

export const RequestCodeInput = Schema.Struct({
  email: Email
});
export type RequestCodeInput = typeof RequestCodeInput.Type;

export const VerifyCodeInput = Schema.Struct({
  email: Email,
  code: Schema.String.pipe(
    Schema.check(Schema.isMinLength(4), Schema.isMaxLength(12))
  )
});
export type VerifyCodeInput = typeof VerifyCodeInput.Type;

export const TokenPair = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  tokenType: Schema.Literal("bearer")
});
export type TokenPair = typeof TokenPair.Type;

export const AuthenticatedUser = Schema.Struct({
  id: Uuid,
  email: Email
});
export type AuthenticatedUser = typeof AuthenticatedUser.Type;

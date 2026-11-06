import { Context, Effect, Layer, Option, Redacted } from "effect";

import { AppConfig } from "./config.ts";
import { scopedAbortSignal } from "./scoped-abort-signal.ts";

type EmailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
};

type MailerShape = {
  readonly configured: boolean;
  readonly send: (message: EmailMessage) => Effect.Effect<void>;
};

export class Mailer extends Context.Service<Mailer, MailerShape>()("@great-minds/server/Mailer") {}

const sendWithResend = (
  apiKey: Redacted.Redacted<string>,
  fromEmail: string,
  message: EmailMessage,
) =>
  Effect.gen(function* () {
    const signal = yield* scopedAbortSignal;
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${Redacted.value(apiKey)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [message.to],
            subject: message.subject,
            text: message.body,
          }),
          signal,
        }),
      catch: (error) => error,
    });
    if (!response.ok) {
      return yield* Effect.die(new Error(`Resend returned ${response.status}`));
    }
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.orDie);

export const MailerLive = Layer.effect(
  Mailer,
  Effect.map(AppConfig, (config): MailerShape => {
    const resend = Option.all([config.resendApiKey, config.resendFromEmail]);
    return Option.match(resend, {
      onNone: () => ({
        configured: false,
        send: () =>
          Effect.die(
            new Error("Email is not set up: RESEND_API_KEY and RESEND_FROM_EMAIL are required"),
          ),
      }),
      onSome: ([apiKey, fromEmail]) => ({
        configured: true,
        send: (message) => sendWithResend(apiKey, fromEmail, message),
      }),
    });
  }),
);

export const makeTestMailer = () => {
  const sent: EmailMessage[] = [];
  const settings = { configured: true };
  return {
    sent,
    settings,
    layer: Layer.succeed(Mailer, {
      get configured() {
        return settings.configured;
      },
      send: (message) =>
        Effect.sync(() => {
          sent.push(message);
        }),
    }),
  };
};

import { Context, Effect, Layer, Redacted } from "effect";

import { AppConfig } from "./config.ts";

export type EmailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
};

export type MailerShape = {
  readonly send: (message: EmailMessage) => Effect.Effect<void>;
};

export class Mailer extends Context.Service<Mailer, MailerShape>()(
  "@great-minds/server/Mailer"
) {}

export const MailerLive = Layer.effect(
  Mailer,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return {
      send: (message) =>
        Effect.tryPromise({
          try: async () => {
            const response = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                authorization: `Bearer ${Redacted.value(config.resendApiKey)}`,
                "content-type": "application/json"
              },
              body: JSON.stringify({
                from: config.resendFromEmail,
                to: [message.to],
                subject: message.subject,
                text: message.body
              })
            });
            if (!response.ok) {
              throw new Error(`Resend returned ${response.status}`);
            }
          },
          catch: (error) => error
        }).pipe(Effect.timeout("10 seconds"), Effect.orDie)
    } satisfies MailerShape;
  })
);

export const makeTestMailer = () => {
  const sent: EmailMessage[] = [];
  return {
    sent,
    layer: Layer.succeed(Mailer, {
      send: (message) =>
        Effect.sync(() => {
          sent.push(message);
        })
    })
  };
};

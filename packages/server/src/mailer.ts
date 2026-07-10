import { Context, Effect, Layer, Option, Redacted } from "effect";

import { AppConfig } from "./config.ts";
import { StructuredLogger } from "./logging.ts";

type EmailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
};

type MailerShape = {
  readonly send: (message: EmailMessage) => Effect.Effect<void>;
};

export class Mailer extends Context.Service<Mailer, MailerShape>()(
  "@great-minds/server/Mailer"
) {}

export const MailerLive = Layer.effect(
  Mailer,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const logger = yield* StructuredLogger;
    return {
      send: (message) =>
        Option.match(config.resendApiKey, {
          onNone: () =>
            logger.warn("mailer.resend_not_configured", {
              to: message.to,
              subject: message.subject,
            }),
          onSome: (apiKey) =>
            Option.match(config.resendFromEmail, {
              onNone: () =>
                logger.warn("mailer.resend_not_configured", {
                  to: message.to,
                  subject: message.subject,
                }),
              onSome: (fromEmail) =>
                Effect.tryPromise({
                  try: async () => {
                    const response = await fetch("https://api.resend.com/emails", {
                      method: "POST",
                      headers: {
                        authorization: `Bearer ${Redacted.value(apiKey)}`,
                        "content-type": "application/json"
                      },
                      body: JSON.stringify({
                        from: fromEmail,
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
            })
        })
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

import { Data, Effect } from "effect";
import { Resend } from "resend";
import type { AuthCodeDeliveryConfig } from "./context.js";

export type MailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
};

export class MailDeliveryFailed extends Data.TaggedError("MailDeliveryFailed")<{
  message: string;
}> {}

export type MailerService = {
  readonly send: (message: MailMessage) => Effect.Effect<void, MailDeliveryFailed>;
};

export function createMailer(config: AuthCodeDeliveryConfig): MailerService {
  if (config.kind === "console") {
    return {
      send: (message) =>
        Effect.sync(() => {
          console.warn(
            `email delivery not configured — logging email: to=${message.to} subject=${message.subject}`,
          );
          console.warn(message.text);
        }),
    };
  }

  const resend = new Resend(config.apiKey);
  return {
    send: (message) =>
      Effect.tryPromise({
        try: async () => {
          const { error } = await resend.emails.send({
            from: config.fromEmail,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          });
          if (error) throw error;
        },
        catch: () => new MailDeliveryFailed({ message: "Failed to send email" }),
      }),
  };
}

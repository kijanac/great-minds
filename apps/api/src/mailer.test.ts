import { Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMailer } from "./mailer.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createMailer", () => {
  test("sends email through the Resend SDK", async () => {
    const fetch = vi.fn(
      (
        _input: Parameters<typeof globalThis.fetch>[0],
        _init?: Parameters<typeof globalThis.fetch>[1],
      ) => Promise.resolve(Response.json({ id: "email_123" })),
    );
    vi.stubGlobal("fetch", fetch);

    const mailer = createMailer({
      kind: "resend",
      apiKey: "re_test",
      fromEmail: "Great Minds <hello@greatminds.local>",
    });

    await Effect.runPromise(
      mailer.send({
        to: "user@greatminds.local",
        subject: "Hello",
        text: "Welcome",
      }),
    );

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.resend.com/emails");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      from: "Great Minds <hello@greatminds.local>",
      to: ["user@greatminds.local"],
      subject: "Hello",
      text: "Welcome",
    });
  });

  test("maps Resend API errors to MailDeliveryFailed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({ message: "invalid api key", name: "validation_error" }, { status: 401 }),
        ),
      ),
    );

    const mailer = createMailer({
      kind: "resend",
      apiKey: "re_test",
      fromEmail: "Great Minds <hello@greatminds.local>",
    });

    const result = await Effect.runPromiseExit(
      mailer.send({ to: "user@greatminds.local", subject: "Hello", text: "Welcome" }),
    );

    expect(result._tag).toBe("Failure");
  });
});

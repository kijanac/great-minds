import { createServer } from "node:http";

const host = process.env.FIXTURE_HOST ?? "127.0.0.1";
const port = Number(process.env.FIXTURE_PORT ?? "4174");

const page = ({ title, author, published, heading = title, body }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <meta name="author" content="${author}">
    <meta property="article:published_time" content="${published}">
  </head>
  <body>
    <main>
      <article>
        <h1>${heading}</h1>
        ${body.map((paragraph) => `<p>${paragraph}</p>`).join("\n        ")}
      </article>
    </main>
  </body>
</html>`;

const articles = new Map([
  [
    "/article",
    page({
      title: "External verification article",
      author: "Fixture Author",
      published: "2025-03-04",
      body: [
        "The external fixture has a stable claim about collective research.",
        "Its second paragraph exists to verify extraction, reading, and metadata.",
      ],
    }),
  ],
  [
    "/host-a/report",
    page({
      title: "Report from host A",
      author: "Alpha Fixture",
      published: "2025-04-01",
      body: ["Alpha report content must remain distinguishable after ingest."],
    }),
  ],
  [
    "/host-b/report",
    page({
      title: "Report from host B",
      author: "Beta Fixture",
      published: "2025-04-02",
      body: ["Beta report content must not overwrite the alpha report silently."],
    }),
  ],
  [
    "/redirect-target",
    page({
      title: "Redirect destination",
      author: "Redirect Fixture",
      published: "2025-05-06",
      body: ["This body is served only after an HTTP redirect."],
    }),
  ],
]);

const send = (response, status, headers, body) => {
  response.writeHead(status, {
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

  if (url.pathname === "/health") {
    send(response, 200, { "content-type": "application/json" }, JSON.stringify({ status: "ok" }));
    return;
  }

  if (url.pathname === "/redirect") {
    send(response, 302, { location: "/redirect-target" }, "redirecting");
    return;
  }

  if (url.pathname === "/error") {
    send(response, 503, { "content-type": "text/plain; charset=utf-8" }, "fixture unavailable");
    return;
  }

  if (url.pathname === "/slow") {
    const requested = Number(url.searchParams.get("ms") ?? "4000");
    const delay = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 30_000) : 4_000;
    setTimeout(() => {
      send(
        response,
        200,
        { "content-type": "text/html; charset=utf-8" },
        page({
          title: "Delayed verification article",
          author: "Slow Fixture",
          published: "2025-06-07",
          body: ["This response is deliberately delayed for interruption and navigation checks."],
        }),
      );
    }, delay);
    return;
  }

  if (url.pathname === "/empty") {
    send(
      response,
      200,
      { "content-type": "text/html; charset=utf-8" },
      "<!doctype html><title>Empty fixture</title>",
    );
    return;
  }

  if (url.pathname === "/document.pdf") {
    send(
      response,
      200,
      { "content-type": "application/pdf" },
      "%PDF-1.4\n% deterministic non-convertible fixture\n",
    );
    return;
  }

  const article = articles.get(url.pathname);
  if (article !== undefined) {
    send(response, 200, { "content-type": "text/html; charset=utf-8" }, article);
    return;
  }

  send(response, 404, { "content-type": "text/plain; charset=utf-8" }, "fixture not found");
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "fixture_server_listening", url: `http://${host}:${port}` }));
});

const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);

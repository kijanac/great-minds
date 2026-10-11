import { Readable } from "node:stream";

import { S3Client } from "@aws-sdk/client-s3";

export const makeFakeBucket = (
  hooks: {
    beforeGet?: (key: string) => void | Promise<void>;
    beforePut?: (key: string) => void | Promise<void>;
    afterPut?: (key: string) => void | Promise<void>;
    omitEtag?: boolean;
  } = {},
) => {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const requests: { method: string; key: string; ifMatch?: string; ifNoneMatch?: string }[] = [];
  let version = 0;
  const write = (key: string, bytes: Uint8Array) => {
    version += 1;
    objects.set(key, { bytes: bytes.slice(), etag: `"v${version}"` });
  };
  const response = (
    statusCode: number,
    body: Uint8Array | string,
    headers: Record<string, string> = {},
  ) => ({
    response: { statusCode, headers, body: Readable.from([body]) },
  });
  const errorResponse = (status: number, code: string) =>
    response(status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`, {
      "content-type": "application/xml",
    });
  const client = new S3Client({
    region: "auto",
    endpoint: "http://fake-r2.invalid",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    requestHandler: {
      handle: async (request: {
        method: string;
        path: string;
        headers: Record<string, string>;
        body?: unknown;
      }) => {
        if (!request.path.startsWith("/bucket/")) throw new Error("Unexpected test bucket");
        const key = decodeURIComponent(request.path.slice("/bucket/".length));
        const ifMatch = request.headers["if-match"];
        const ifNoneMatch = request.headers["if-none-match"];
        requests.push({ method: request.method, key, ifMatch, ifNoneMatch });
        if (request.method === "GET") {
          await hooks.beforeGet?.(key);
          const stored = objects.get(key);
          if (stored === undefined) return errorResponse(404, "NoSuchKey");
          return response(200, stored.bytes.slice(), hooks.omitEtag ? {} : { etag: stored.etag });
        }
        if (request.method !== "PUT") throw new Error("Unexpected test request");
        await hooks.beforePut?.(key);
        const current = objects.get(key);
        if (
          (ifNoneMatch === "*" && current !== undefined) ||
          (ifMatch !== undefined && current?.etag !== ifMatch)
        ) {
          return errorResponse(412, "PreconditionFailed");
        }
        if (!(request.body instanceof Uint8Array)) throw new Error("Expected byte request body");
        write(key, request.body);
        await hooks.afterPut?.(key);
        return response(200, "", { etag: objects.get(key)!.etag });
      },
    },
  });
  return { client, objects, requests, write };
};

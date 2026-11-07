import {
  FileFingerprint,
  type FileIngestBatch,
  type FileIngestUploadTarget,
} from "@great-minds/domain";
import { Data, Effect } from "effect";
import { HttpBody, HttpClientRequest } from "effect/http";

import type { makeApi } from "./runtime.ts";

type Connection = ReturnType<typeof makeApi>;

export interface UploadFile {
  readonly name: string;
  readonly content: Blob;
  readonly hash: FileFingerprint;
  readonly mimetype: string;
}

export class UploadRejected extends Data.TaggedError("UploadRejected")<{
  readonly status: number;
}> {
  override get message() {
    return `Upload returned ${this.status}`;
  }
}

export const fingerprint = async (content: Blob) => {
  const digest = await crypto.subtle.digest("SHA-256", await content.arrayBuffer());
  return FileFingerprint.make(
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
};

export const manifestOf = (files: readonly UploadFile[]) =>
  files.map((file) => ({
    name: file.name,
    size: file.content.size,
    hash: file.hash,
    mimetype: file.mimetype,
  }));

const transfer = (
  connection: Connection,
  batch: FileIngestBatch,
  target: FileIngestUploadTarget,
  file: UploadFile,
) => {
  if (target.transport === "presigned")
    return connection
      .use(
        connection.externalHttp.execute(
          HttpClientRequest.put(target.url).pipe(
            HttpClientRequest.setBody(
              HttpBody.raw(file.content, {
                contentType: file.mimetype || "application/octet-stream",
              }),
            ),
          ),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.void
            : Effect.fail(new UploadRejected({ status: response.status })),
        ),
      );
  const form = new FormData();
  form.append("file", file.content, file.name);
  return connection.use(
    connection.api.ingest.uploadFileIngestFile({
      params: { batch_id: batch.id, hash: target.hash },
      payload: form,
    }),
  );
};

export const uploadTarget = (
  connection: Connection,
  batch: FileIngestBatch,
  target: FileIngestUploadTarget,
  file: UploadFile,
) =>
  transfer(connection, batch, target, file).pipe(
    Effect.andThen(
      connection.use(
        connection.api.ingest.acknowledgeFileIngestUpload({
          params: { batch_id: batch.id, hash: target.hash },
        }),
      ),
    ),
  );

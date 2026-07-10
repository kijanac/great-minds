import { randomBytes } from "node:crypto";

import { Context, Effect, Layer } from "effect";

type RandomBytesServiceShape = {
  readonly bytes: (size: number) => Effect.Effect<Uint8Array>;
};

export class RandomBytesService extends Context.Service<
  RandomBytesService,
  RandomBytesServiceShape
>()("@great-minds/server/RandomBytesService") {}

export const RandomBytesLive = Layer.succeed(RandomBytesService, {
  bytes: (size) => Effect.sync(() => new Uint8Array(randomBytes(size))),
});

const hex = (byte: number) => byte.toString(16).padStart(2, "0");

const formatUuid = (bytes: Uint8Array) => {
  const segments = [
    bytes.subarray(0, 4),
    bytes.subarray(4, 6),
    bytes.subarray(6, 8),
    bytes.subarray(8, 10),
    bytes.subarray(10, 16),
  ];
  return segments.map((segment) => Array.from(segment, hex).join("")).join("-");
};

const MAX_UUID7_TIMESTAMP = 2 ** 48 - 1;

export const formatUuid7 = (timestampMillis: number, random: Uint8Array) => {
  if (random.length < 16) {
    throw new Error("uuid7 requires at least 16 random bytes");
  }
  const bytes = new Uint8Array(random.slice(0, 16));
  const timestamp = Math.min(Math.max(0, Math.trunc(timestampMillis)), MAX_UUID7_TIMESTAMP);
  bytes[0] = Math.floor(timestamp / 2 ** 40);
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
};

export const makeTestRandomBytes = (seed = 0) => {
  let counter = seed;
  return {
    layer: Layer.succeed(RandomBytesService, {
      bytes: (size) =>
        Effect.sync(() => {
          const bytes = new Uint8Array(size);
          for (let index = 0; index < size; index += 1) {
            bytes[index] = (counter + index) & 0xff;
          }
          counter += size;
          return bytes;
        }),
    }),
    reset: (next = seed) => {
      counter = next;
    },
  };
};

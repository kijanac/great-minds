import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgTypes from "@effect/sql-pg/PgTypes";
import { refineCodecs } from "drizzle-orm/codecs";
import { effectPgCodecs } from "drizzle-orm/effect-postgres";
import { Context, Effect, Layer, Result, Schema } from "effect";

const TSVECTOR_OID = 3614;
const TSVECTOR_ARRAY_OID = 3643;

const header = (bytes: Uint8Array, width: number, name: string) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensions = view.getUint16(0);
  return bytes.byteLength === 4 + dimensions * width
    ? Result.succeed({ view, dimensions })
    : Result.fail(
        new PgTypes.CodecError({
          message: `Expected ${dimensions} ${name} dimensions, received ${bytes.byteLength} bytes`,
        }),
      );
};

const floatVector = (
  name: string,
  width: number,
  read: (view: DataView, offset: number) => number,
  write: (view: DataView, offset: number, value: number) => void,
): PgTypes.Codec<readonly number[]> => ({
  encode: (values) => {
    const bytes = new Uint8Array(4 + values.length * width);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, values.length);
    values.forEach((value, index) => write(view, 4 + index * width, value));
    return Result.succeed(bytes);
  },
  decode: (bytes) =>
    Result.map(header(bytes, width, name), ({ view, dimensions }) =>
      Array.from({ length: dimensions }, (_, index) => read(view, 4 + index * width)),
    ),
});

const vectorCodec = floatVector(
  "vector",
  4,
  (view, offset) => view.getFloat32(offset),
  (view, offset, value) => view.setFloat32(offset, value),
);

const halfvecCodec = floatVector(
  "halfvec",
  2,
  (view, offset) => view.getFloat16(offset),
  (view, offset, value) => view.setFloat16(offset, value),
);

const WEIGHTS = ["", "C", "B", "A"] as const;
const utf8 = new TextDecoder("utf-8", { fatal: true });

const readTsvector = (bytes: Uint8Array): string => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: string[] = [];
  let offset = 4;
  for (let entry = view.getInt32(0); entry > 0; entry--) {
    const end = bytes.indexOf(0, offset);
    if (end < 0) throw new PgTypes.CodecError({ message: "Unterminated tsvector lexeme" });
    const lexeme = utf8.decode(bytes.subarray(offset, end)).replace(/['\\]/g, "$&$&");
    const positionCount = view.getUint16(end + 1);
    const positions = Array.from({ length: positionCount }, (_, index) => {
      const position = view.getUint16(end + 3 + index * 2);
      return `${position & 0x3fff}${WEIGHTS[position >> 14]}`;
    });
    entries.push(positions.length === 0 ? `'${lexeme}'` : `'${lexeme}':${positions.join(",")}`);
    offset = end + 3 + positionCount * 2;
  }
  return entries.join(" ");
};

const tsvectorCodec: PgTypes.Codec<string> = {
  encode: () =>
    Result.fail(
      new PgTypes.CodecError({ message: "Write tsvector values as text with to_tsvector" }),
    ),
  decode: (bytes) => {
    try {
      return Result.succeed(readTsvector(bytes));
    } catch (cause) {
      return Result.fail(
        cause instanceof PgTypes.CodecError
          ? cause
          : new PgTypes.CodecError({ message: `Malformed tsvector: ${String(cause)}` }),
      );
    }
  },
};

const ExtensionTypes = Schema.Array(
  Schema.Struct({
    typname: Schema.Literals(["vector", "halfvec"]),
    oid: Schema.Number,
    typarray: Schema.Number,
  }),
);

const extensionCodecs = { vector: vectorCodec, halfvec: halfvecCodec } as const;

const registerExtensionTypes = (client: PgClient.PgClient, types: PgTypes.Registry) =>
  Effect.gen(function* () {
    const rows = yield* client`
      select typname, oid::int4 as oid, typarray::int4 as typarray
      from pg_type
      where typname in ('vector', 'halfvec')
        and typnamespace = (
          select extnamespace from pg_extension where extname = 'vector'
        )`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ExtensionTypes)), Effect.orDie);
    for (const { typname, oid, typarray } of rows) {
      types.register(oid, extensionCodecs[typname], { arrayOid: typarray });
    }
  });

export const layerPgClient = (options: PgClient.PgPoolConfig) => {
  const types = PgTypes.makeRegistry();
  types.register(TSVECTOR_OID, tsvectorCodec, { arrayOid: TSVECTOR_ARRAY_OID });
  return PgClient.layer({ ...options, types }).pipe(
    Layer.tap((context) => registerExtensionTypes(Context.get(context, PgClient.PgClient), types)),
  );
};

export const drizzleCodecs = refineCodecs(effectPgCodecs, {
  vector: { normalize: undefined, normalizeArray: undefined },
  halfvec: { normalize: undefined, normalizeArray: undefined },
});

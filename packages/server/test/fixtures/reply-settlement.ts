import { Effect, type Scope } from "effect";

import { makeReplySettlement } from "../../src/conversation-history/settlement.ts";
import { completion } from "./conversation-history.ts";
import { command, type ReplyAdmissionFixture, withAdmission } from "./reply-admission.ts";

const setup = (f: ReplyAdmissionFixture) =>
  Effect.gen(function* () {
    const input = command();
    const { session_id } = yield* f.admission.accept(f.userId, f.vaultId, input);
    const replyId = input.reply_id;
    const progress = {
      answer: "Visible partial. é 漢字",
      sources: [
        { ...completion().sources[0], pending: false },
        { ...completion().sources[0], label: "Pending tool", pending: true },
      ],
    };
    yield* f.updateReply(replyId, {
      ...progress,
      activeGenerationStep: 1,
      activeGenerationKind: "model",
      activeGenerationKey: "model-attempt-1",
    });
    return {
      ...f,
      replyId,
      address: f.address(session_id),
      key: f.key(session_id),
      admission: (yield* f.histories.read(f.address(session_id)))!,
      progress,
      finalizer: makeReplySettlement(f.db, f.histories, f.clock),
      reply: () => f.reply(replyId),
      session: () => f.session(session_id),
      updateReply: (values: Parameters<typeof f.updateReply>[1]) => f.updateReply(replyId, values),
      updateSession: (values: Parameters<typeof f.updateSession>[1]) =>
        f.updateSession(session_id, values),
    };
  });

export const withSettlement = <Value, Error>(
  use: (
    fixture: Effect.Success<ReturnType<typeof setup>>,
  ) => Effect.Effect<Value, Error, Scope.Scope>,
) =>
  withAdmission((f) =>
    Effect.gen(function* () {
      return yield* use(yield* setup(f));
    }),
  );

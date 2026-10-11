import { Database, replies } from "@great-minds/database";
import {
  composeAnchoredQuestion,
  CreateReplyRequest,
  type ThinkingSource,
  type Uuid,
} from "@great-minds/domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { ClockService } from "../../src/clock.ts";
import {
  acceptedRequestFor,
  makeReplyAdmission,
} from "../../src/conversation-history/admission.ts";
import { makeReplySettlement } from "../../src/conversation-history/settlement.ts";
import { HistoryStore } from "../../src/conversation-history/store.ts";
import { promptContentHash } from "../../src/crypto.ts";
import type { LlmMessage } from "../../src/llm.ts";
import { RandomBytesService } from "../../src/random.ts";
import { VaultAccessService } from "../../src/vaults.ts";

export const seedConversationReply = (
  userId: Uuid,
  vaultId: Uuid,
  command: CreateReplyRequest,
  content: {
    readonly answer: string;
    readonly sources?: readonly ThinkingSource[];
    readonly messages?: readonly LlmMessage[];
  },
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const histories = yield* HistoryStore;
    const clock = yield* ClockService;
    const random = yield* RandomBytesService;
    const access = yield* VaultAccessService;
    const admission = makeReplyAdmission(db, histories, clock, random, access, true);
    const settlement = makeReplySettlement(db, histories, clock);
    const response = yield* admission.accept(userId, vaultId, command);
    const rows = yield* db.query((d) =>
      d.select().from(replies).where(eq(replies.id, response.reply_id)),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("Seeded reply disappeared");
    const accepted = yield* acceptedRequestFor(row);
    const origin = accepted.header?.origin;
    const question =
      origin?.anchor === undefined || origin.anchor === null
        ? command.question
        : composeAnchoredQuestion(
            { quote: origin.anchor, context: origin.paragraph },
            command.question,
          );
    yield* settlement.begin(response.reply_id, {
      status: "completed",
      answer: content.answer,
      sources: content.sources ?? [],
      context_messages: content.messages ?? [
        { role: "user", content: question },
        { role: "assistant", content: content.answer },
      ],
      generation: {
        mode: accepted.mode,
        system_prompt_hash: {
          scheme: "gm-prompt-v1",
          value: promptContentHash(
            "Synthetic verification fixture; no language model was invoked.",
          ),
        },
        requested_model: "fixture/static",
      },
    });
    yield* settlement.publish(response.reply_id);
    return response;
  });

export type ConversationSeedServices = Effect.Services<ReturnType<typeof seedConversationReply>>;

import {
  Uuid,
  type Proposal,
  type ProposalCreate,
  type ProposalOverview,
  type ProposalPage,
  type ProposalStatus,
  type ProposalUpdate,
} from "@great-minds/domain";
import { Schema } from "effect";

import { api, run } from "./app";

export type { Proposal, ProposalOverview, ProposalPage, ProposalStatus };

const uuid = Schema.decodeSync(Uuid);

export async function listProposals(
  vaultId: string,
  params: { status?: ProposalStatus; limit: number; offset: number },
): Promise<ProposalPage> {
  const query = params.status
    ? { limit: params.limit, offset: params.offset, status: params.status }
    : { limit: params.limit, offset: params.offset };
  return run(
    api.proposals.listProposals({
      params: { vault_id: uuid(vaultId) },
      query,
    }),
  );
}

export async function getProposal(vaultId: string, proposalId: string): Promise<Proposal> {
  return run(
    api.proposals.getProposal({
      params: { vault_id: uuid(vaultId), proposal_id: uuid(proposalId) },
    }),
  );
}

export async function createProposal(vaultId: string, input: ProposalCreate): Promise<Proposal> {
  return run(
    api.proposals.createProposal({
      params: { vault_id: uuid(vaultId) },
      payload: {
        content: input.content,
        ...(input.content_type !== undefined ? { content_type: input.content_type } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.author !== undefined ? { author: input.author } : {}),
      },
    }),
  );
}

export async function reviewProposal(
  vaultId: string,
  proposalId: string,
  status: ProposalUpdate["status"],
): Promise<Proposal> {
  return run(
    api.proposals.reviewProposal({
      params: { vault_id: uuid(vaultId), proposal_id: uuid(proposalId) },
      payload: { status },
    }),
  );
}

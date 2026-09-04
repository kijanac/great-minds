import type {
  Proposal,
  ProposalCreate,
  ProposalOverview,
  ProposalPage,
  ProposalStatus,
  ProposalUpdate,
  Uuid,
} from "@great-minds/domain";

import { api, run } from "./app";

export type { Proposal, ProposalOverview, ProposalPage, ProposalStatus };

export function listProposals(
  vaultId: Uuid,
  params: { status?: ProposalStatus; limit: number; offset: number },
): Promise<ProposalPage> {
  const query = params.status
    ? { limit: params.limit, offset: params.offset, status: params.status }
    : { limit: params.limit, offset: params.offset };
  return run(
    api.proposals.listProposals({
      params: { vault_id: vaultId },
      query,
    }),
  );
}

export function getProposal(vaultId: Uuid, proposalId: Uuid): Promise<Proposal> {
  return run(
    api.proposals.getProposal({
      params: { vault_id: vaultId, proposal_id: proposalId },
    }),
  );
}

export function createProposal(vaultId: Uuid, input: ProposalCreate): Promise<Proposal> {
  return run(
    api.proposals.createProposal({
      params: { vault_id: vaultId },
      payload: {
        content: input.content,
        ...(input.content_type !== undefined ? { content_type: input.content_type } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.author !== undefined ? { author: input.author } : {}),
      },
    }),
  );
}

export function reviewProposal(
  vaultId: Uuid,
  proposalId: Uuid,
  status: ProposalUpdate["status"],
): Promise<Proposal> {
  return run(
    api.proposals.reviewProposal({
      params: { vault_id: vaultId, proposal_id: proposalId },
      payload: { status },
    }),
  );
}

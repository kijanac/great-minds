import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  type Proposal,
  type ProposalCreateInput,
  type ProposalStatus,
  createProposal,
  listProposals,
  reviewProposal,
} from "@/api/proposals";
import { useOffsetInfiniteQuery } from "@/hooks/use-offset-infinite-query";

const PAGE_SIZE = 20;

function queryKey(brainId: string, status?: ProposalStatus) {
  return ["proposals", brainId, status ?? "all"] as const;
}

export function useProposals(
  brainId: string,
  status?: ProposalStatus,
  enabled: boolean = true,
) {
  return useOffsetInfiniteQuery({
    queryKey: queryKey(brainId, status),
    enabled: enabled && !!brainId,
    pageSize: PAGE_SIZE,
    queryFn: (params) => listProposals(brainId, { status, ...params }),
  });
}

export function useCreateProposal(brainId: string) {
  const qc = useQueryClient();
  return useMutation<Proposal, Error, ProposalCreateInput>({
    mutationFn: (input) => createProposal(brainId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposals", brainId] });
    },
  });
}

export function useReviewProposal(brainId: string) {
  const qc = useQueryClient();
  return useMutation<
    Proposal,
    Error,
    { proposalId: string; status: "approved" | "rejected" }
  >({
    mutationFn: ({ proposalId, status }) =>
      reviewProposal(brainId, proposalId, status),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposals", brainId] });
    },
  });
}

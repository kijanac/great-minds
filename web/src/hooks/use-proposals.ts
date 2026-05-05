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

function queryKey(vaultId: string, status?: ProposalStatus) {
  return ["proposals", vaultId, status ?? "all"] as const;
}

export function useProposals(vaultId: string, status?: ProposalStatus, enabled: boolean = true) {
  return useOffsetInfiniteQuery({
    queryKey: queryKey(vaultId, status),
    enabled: enabled && !!vaultId,
    pageSize: PAGE_SIZE,
    queryFn: (params) => listProposals(vaultId, { status, ...params }),
  });
}

export function useCreateProposal(vaultId: string) {
  const qc = useQueryClient();
  return useMutation<Proposal, Error, ProposalCreateInput>({
    mutationFn: (input) => createProposal(vaultId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposals", vaultId] });
    },
  });
}

export function useReviewProposal(vaultId: string) {
  const qc = useQueryClient();
  return useMutation<Proposal, Error, { proposalId: string; status: "approved" | "rejected" }>({
    mutationFn: ({ proposalId, status }) => reviewProposal(vaultId, proposalId, status),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposals", vaultId] });
    },
  });
}

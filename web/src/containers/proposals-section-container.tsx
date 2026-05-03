import { useCallback, useState } from "react";

import type { ProposalStatus } from "@/api/proposals";
import { ProposalsSection } from "@/components/proposals-section";
import {
  useCreateProposal,
  useProposals,
  useReviewProposal,
} from "@/hooks/use-proposals";

export type ProposalFilter = ProposalStatus | "all";

interface ProposalsSectionContainerProps {
  vaultId: string;
  isOwner: boolean;
}

export function ProposalsSectionContainer({
  vaultId,
  isOwner,
}: ProposalsSectionContainerProps) {
  const [status, setStatus] = useState<ProposalFilter>("pending");
  const proposals = useProposals(
    vaultId,
    status === "all" ? undefined : status,
  );
  const create = useCreateProposal(vaultId);
  const review = useReviewProposal(vaultId);

  const items = proposals.data?.pages.flatMap((p) => p.items) ?? [];

  const handleCreate = useCallback(
    async (input: {
      content: string;
      content_type: string;
      title?: string;
      author?: string;
    }) => {
      await create.mutateAsync(input);
    },
    [create],
  );

  const handleReview = useCallback(
    async (proposalId: string, status: "approved" | "rejected") => {
      await review.mutateAsync({ proposalId, status });
    },
    [review],
  );

  return (
    <ProposalsSection
      proposals={items}
      loading={proposals.isLoading || proposals.isFetchingNextPage}
      hasMore={proposals.hasNextPage ?? false}
      isOwner={isOwner}
      activeStatus={status}
      creating={create.isPending}
      reviewing={review.isPending}
      onStatusFilter={setStatus}
      onCreate={handleCreate}
      onReview={handleReview}
      onLoadMore={() => proposals.fetchNextPage()}
    />
  );
}

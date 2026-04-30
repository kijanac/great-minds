import { apiFetch, readJson } from "./client";
import {
  proposalListSchema,
  proposalSchema,
  type Proposal,
  type ProposalList,
  type ProposalOverview,
  type ProposalStatus,
} from "./schemas";

export type { Proposal, ProposalList, ProposalOverview, ProposalStatus };

export interface ProposalCreateInput {
  content: string;
  content_type?: string;
  title?: string;
  author?: string;
}

export async function listProposals(
  brainId: string,
  params?: { status?: ProposalStatus; limit?: number; offset?: number },
): Promise<ProposalList> {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.limit !== undefined) query.set("limit", String(params.limit));
  if (params?.offset !== undefined) query.set("offset", String(params.offset));
  const qs = query.toString();
  const path = `/brains/${brainId}/proposals${qs ? `?${qs}` : ""}`;
  const res = await apiFetch(path);
  if (!res.ok) throw new Error("Failed to list proposals");
  return readJson(res, proposalListSchema);
}

export async function getProposal(
  brainId: string,
  proposalId: string,
): Promise<Proposal> {
  const res = await apiFetch(`/brains/${brainId}/proposals/${proposalId}`);
  if (!res.ok) throw new Error("Failed to fetch proposal");
  return readJson(res, proposalSchema);
}

export async function createProposal(
  brainId: string,
  input: ProposalCreateInput,
): Promise<Proposal> {
  const res = await apiFetch(`/brains/${brainId}/proposals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error("Failed to submit proposal");
  return readJson(res, proposalSchema);
}

export async function reviewProposal(
  brainId: string,
  proposalId: string,
  status: "approved" | "rejected",
): Promise<Proposal> {
  const res = await apiFetch(`/brains/${brainId}/proposals/${proposalId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error("Failed to review proposal");
  return readJson(res, proposalSchema);
}

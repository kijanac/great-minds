import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";

import {
  type BrainConfig,
  type BrainDetail,
  type Membership,
  getBrainConfig,
  getBrainDetail,
  inviteMember,
  listMembers,
  removeMember,
  updateBrainConfig,
  updateMemberRole,
} from "@/api/brains";
import { ProjectSettings } from "@/components/project-settings";
import { ApiKeysSectionContainer } from "@/containers/api-keys-section-container";
import { ProposalsSectionContainer } from "@/containers/proposals-section-container";
import { useViewNavigate } from "@/hooks/use-view-navigate";
import { useAuth } from "@/lib/auth";

export function ProjectSettingsContainer() {
  const { id } = useParams<{ id: string }>();
  const { userId } = useAuth();
  const navigate = useViewNavigate();
  const [project, setProject] = useState<BrainDetail | null>(null);
  const [members, setMembers] = useState<Membership[]>([]);
  const [config, setConfig] = useState<BrainConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.all([getBrainDetail(id), listMembers(id), getBrainConfig(id)])
      .then(([detail, memberList, cfg]) => {
        setProject(detail);
        setMembers(memberList);
        setConfig(cfg);
      })
      .catch(() => {
        setProject(null);
        setMembers([]);
        setConfig(null);
      })
      .finally(() => setLoading(false));
  }, [id]);

  const isOwner = members.some((m) => m.user_id === userId && m.role === "owner");

  const handleInvite = useCallback(
    async (email: string) => {
      if (!id) return;
      const member = await inviteMember(id, email);
      setMembers((prev) => [...prev, member]);
    },
    [id],
  );

  const handleChangeRole = useCallback(
    async (memberId: string, role: string) => {
      if (!id) return;
      const updated = await updateMemberRole(id, memberId, role);
      setMembers((prev) => prev.map((m) => (m.user_id === memberId ? updated : m)));
    },
    [id],
  );

  const handleRemoveMember = useCallback(
    async (memberId: string) => {
      if (!id) return;
      await removeMember(id, memberId);
      setMembers((prev) => prev.filter((m) => m.user_id !== memberId));
    },
    [id],
  );

  const handleSaveConfig = useCallback(
    async (thematic_hint: string) => {
      if (!id) return;
      const updated = await updateBrainConfig(id, { thematic_hint });
      setConfig(updated);
    },
    [id],
  );

  return (
    <ProjectSettings
      project={project}
      members={members}
      config={config}
      isOwner={isOwner}
      loading={loading}
      proposalsSlot={
        id ? (
          <ProposalsSectionContainer brainId={id} isOwner={isOwner} />
        ) : null
      }
      apiKeysSlot={<ApiKeysSectionContainer />}
      onHome={() => navigate("/")}
      onInvite={handleInvite}
      onChangeRole={handleChangeRole}
      onRemoveMember={handleRemoveMember}
      onSaveConfig={handleSaveConfig}
    />
  );
}

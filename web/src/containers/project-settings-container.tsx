import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";

import {
  type BrainDetail,
  type Membership,
  getBrainDetail,
  inviteMember,
  listMembers,
  removeMember,
  updateMemberRole,
} from "@/api/brains";
import { ProjectSettings } from "@/components/project-settings";
import { useViewNavigate } from "@/hooks/use-view-navigate";
import { useAuth } from "@/lib/auth";

export function ProjectSettingsContainer() {
  const { id } = useParams<{ id: string }>();
  const { userId } = useAuth();
  const navigate = useViewNavigate();
  const [project, setProject] = useState<BrainDetail | null>(null);
  const [members, setMembers] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.all([getBrainDetail(id), listMembers(id)])
      .then(([detail, memberList]) => {
        setProject(detail);
        setMembers(memberList);
      })
      .catch(() => {
        setProject(null);
        setMembers([]);
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

  return (
    <ProjectSettings
      project={project}
      members={members}
      isOwner={isOwner}
      loading={loading}
      onHome={() => navigate("/")}
      onInvite={handleInvite}
      onChangeRole={handleChangeRole}
      onRemoveMember={handleRemoveMember}
    />
  );
}

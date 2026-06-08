import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";

import { ProjectSettings } from "@/components/project-settings";
import { useViewNavigate } from "@/hooks/use-view-navigate";
import { useLocalApp } from "@/local/app-provider";
import { localApi } from "@/local/worker/client";

export function ProjectSettingsContainer() {
  const { id } = useParams<{ id: string }>();
  const {
    workspace: { user },
    updateVault,
  } = useLocalApp();
  const navigate = useViewNavigate();
  const queryClient = useQueryClient();

  const settings = useQuery({
    queryKey: ["vault", id, "settings"],
    enabled: Boolean(id),
    queryFn: () => localApi.getVaultSettings(id!),
  });

  const members = settings.data?.members ?? [];
  const isOwner = members.some((member) => member.userId === user.id && member.role === "owner");

  const handleInvite = useCallback(async (_email: string) => {
    throw new Error("Local sharing is not available yet.");
  }, []);

  const handleChangeRole = useCallback(async (_memberId: string, _role: string) => {
    throw new Error("Local sharing is not available yet.");
  }, []);

  const handleRemoveMember = useCallback(async (_memberId: string) => {
    throw new Error("Local sharing is not available yet.");
  }, []);

  const handleSaveConfig = useCallback(
    async (thematicHint: string) => {
      if (!id) return;
      await updateVault({ vaultId: id, thematicHint });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["vault", id, "settings"] }),
        queryClient.invalidateQueries({ queryKey: ["vaults"] }),
      ]);
    },
    [id, queryClient, updateVault],
  );

  const handleDeleteVault = useCallback(async () => {
    throw new Error("Local vault deletion is not available yet.");
  }, []);

  return (
    <ProjectSettings
      project={settings.data?.vault ?? null}
      members={members}
      articleCount={settings.data?.articleCount ?? 0}
      isOwner={isOwner}
      loading={settings.isLoading}
      memberManagementEnabled={false}
      dangerZoneEnabled={false}
      proposalsSlot={null}
      apiKeysSlot={null}
      onHome={() => navigate("/")}
      onInvite={handleInvite}
      onChangeRole={handleChangeRole}
      onRemoveMember={handleRemoveMember}
      onSaveConfig={handleSaveConfig}
      onDeleteVault={handleDeleteVault}
    />
  );
}

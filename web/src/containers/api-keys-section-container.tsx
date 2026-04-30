import { useCallback } from "react";

import { ApiKeysSection } from "@/components/api-keys-section";
import {
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
} from "@/hooks/use-api-keys";

export function ApiKeysSectionContainer() {
  const apiKeys = useApiKeys();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();

  const handleCreate = useCallback(
    async (label: string) => {
      await create.mutateAsync(label);
    },
    [create],
  );

  const handleRevoke = useCallback(
    async (keyId: string) => {
      await revoke.mutateAsync(keyId);
    },
    [revoke],
  );

  return (
    <ApiKeysSection
      keys={apiKeys.data ?? []}
      justCreated={create.data ?? null}
      creating={create.isPending}
      loading={apiKeys.isLoading}
      onCreate={handleCreate}
      onRevoke={handleRevoke}
      onDismissCreated={() => create.reset()}
    />
  );
}

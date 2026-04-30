import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type ApiKey,
  type ApiKeyCreated,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "@/api/api-keys";

const QUERY_KEY = ["api-keys"] as const;

export function useApiKeys(enabled: boolean = true) {
  return useQuery<ApiKey[]>({
    queryKey: QUERY_KEY,
    queryFn: listApiKeys,
    enabled,
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation<ApiKeyCreated, Error, string>({
    mutationFn: createApiKey,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: revokeApiKey,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

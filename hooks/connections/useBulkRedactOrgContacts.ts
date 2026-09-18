"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { randomId } from "@/lib/random-id";

interface BulkRedactInput {
  justification: string;
}

interface BulkRedactResponse {
  data: {
    requested: number;
    skipped_already_requested: number;
    request_ids: string[];
  };
}

export function useBulkRedactOrgContacts() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ justification }: BulkRedactInput) => {
      const idempotencyKey = randomId();
      return apiClient.post<BulkRedactResponse>(
        "/api/v1/lgpd/requests/bulk-redact",
        { justification },
        { idempotencyKey },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["lgpd-requests"] });
      void queryClient.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}

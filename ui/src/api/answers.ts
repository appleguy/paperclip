import type { AnswersQuery, AnswersResponse } from "@paperclipai/shared";
import { api } from "./client";

export const answersApi = {
  list: (companyId: string, options: AnswersQuery = {}) => {
    const params = new URLSearchParams();
    if (options.search) params.set("search", options.search);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.issueId) params.set("issueId", options.issueId);
    const query = params.toString();
    return api.get<AnswersResponse>(`/companies/${companyId}/answers${query ? `?${query}` : ""}`);
  },
};

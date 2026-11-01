import { useQuery } from "@tanstack/react-query";
import { accessApi, type CurrentBoardAccess } from "../api/access";
import { queryKeys } from "../lib/queryKeys";

export function canObserveNativeSessions(companyId: string | null, access: CurrentBoardAccess | undefined): boolean {
  return !!companyId && !!access?.userId && access.isInstanceAdmin === true &&
    access.source !== "local_implicit" && access.companyIds.includes(companyId);
}

/** Presentation hint only; the API independently enforces authenticated host access. */
export function useNativeSessionObserverAccess(companyId: string | null): boolean {
  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: !!companyId,
    retry: false,
  });
  return canObserveNativeSessions(companyId, access.data);
}

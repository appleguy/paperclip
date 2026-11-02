/**
 * Quota Sentinel's state is a *recent velocity projection* (up to 48h), not
 * a statement about cumulative progress through the subscription window.
 * Keep the raw machine states unchanged for dispatch/alert compatibility.
 */
const recentRateLabels: Record<string, string> = {
  ahead_of_pace: "recent rate above goal",
  on_pace: "recent rate near goal",
  behind_pace: "recent rate below goal",
  need_trend: "recent trend unmeasured",
  reset_imminent_underused: "reset soon, allowance left",
  exhausted_early: "allowance exhausted early",
  target_reached: "target reached",
  reset_due: "reset due",
  unknown: "usage or reset unknown",
};

export function quotaPaceLabel(state: string): string {
  return recentRateLabels[state] ?? state.replaceAll("_", " ");
}

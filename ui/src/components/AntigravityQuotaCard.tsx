import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { quotaPaceLabel } from "@/lib/quota-pace-labels";

interface AntigravityPool {
  pool: string;
  usedPercent: number | null;
  resetsAt: string | null;
  state: string;
}

const poolNames: Record<string, string> = {
  "3p:5h": "Third-party · 5-hour",
  "3p:weekly": "Third-party · weekly",
  "gemini:5h": "Gemini · 5-hour",
  "gemini:weekly": "Gemini · weekly",
  "gemini-argon-wtu:weekly": "Gemini Argon · weekly",
};

const pacificFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

export function AntigravityQuotaCard({
  pools,
  observedAt,
  stale,
  loading,
  error,
}: {
  pools: AntigravityPool[];
  observedAt?: string | null;
  stale?: boolean;
  loading?: boolean;
  error?: boolean;
}) {
  return (
    <Card data-testid="antigravity-quota-card">
      <CardHeader>
        <CardTitle>Antigravity subscription quota</CardTitle>
        <CardDescription>
          Live quota from Quota Sentinel, independent of Paperclip cost events. Pace describes recent consumption speed, not total weekly progress.
          {observedAt && !Number.isNaN(Date.parse(observedAt))
            ? ` Observed ${pacificFormat.format(new Date(observedAt))}.`
            : ""}
          {stale ? " Stale reading, verify before dispatch." : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading Antigravity quota…</p>
        ) : error || pools.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            Antigravity quota is unavailable. Unknown usage is not zero.
          </p>
        ) : (
          pools.map(({ pool, usedPercent, resetsAt, state }) => (
            <div key={pool} className="space-y-1.5">
              <div className="flex justify-between gap-3 text-sm">
                <span>{poolNames[pool] ?? pool}</span>
                <span className="tabular-nums">
                  {usedPercent == null ? "Unknown" : `${usedPercent.toFixed(1)}% used`}
                </span>
              </div>
              <div className="h-2 rounded bg-muted overflow-hidden"
                role="progressbar"
                aria-label={`${poolNames[pool] ?? pool} usage`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={usedPercent ?? undefined}>
                {usedPercent != null && (
                  <div className="h-full bg-primary" style={{ width: `${usedPercent}%` }} />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {resetsAt && !Number.isNaN(Date.parse(resetsAt))
                  ? `Resets ${pacificFormat.format(new Date(resetsAt))}`
                  : "Reset unknown"}
                {" · "}{quotaPaceLabel(state)}
              </p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

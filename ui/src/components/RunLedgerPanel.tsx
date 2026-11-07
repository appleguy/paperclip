import type { RunLedgerDailyReport, RunLedgerDailyRow } from "@paperclipai/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageSkeleton } from "./PageSkeleton";
import { formatCents, formatTokens } from "../lib/utils";

const outcomeColors = {
  succeeded: "var(--status-task-icon-done)",
  failed: "var(--status-task-icon-blocked)",
  timedOut: "var(--hex-eab308)",
  cancelled: "var(--status-task-cancelled)",
  interrupted: "var(--status-task-in_review)",
  other: "var(--hex-737373)",
} as const;

type DailyPoint = {
  date: string;
  tokens: number;
  costCents: number;
  outcomes: Pick<RunLedgerDailyRow, "succeeded" | "failed" | "timedOut" | "cancelled" | "interrupted" | "other">;
};

function formatDateLabel(date: string): string {
  const value = new Date(`${date}T12:00:00Z`);
  return `${value.getUTCMonth() + 1}/${value.getUTCDate()}`;
}

function pointsForChart(rows: RunLedgerDailyRow[]): DailyPoint[] {
  const byDate = new Map<string, DailyPoint>();
  for (const row of rows) {
    const point = byDate.get(row.date) ?? {
      date: row.date,
      tokens: 0,
      costCents: 0,
      outcomes: { succeeded: 0, failed: 0, timedOut: 0, cancelled: 0, interrupted: 0, other: 0 },
    };
    point.tokens += row.inputTokens + row.cachedInputTokens + row.outputTokens;
    point.costCents += row.costCents;
    point.outcomes.succeeded += row.succeeded;
    point.outcomes.failed += row.failed;
    point.outcomes.timedOut += row.timedOut;
    point.outcomes.cancelled += row.cancelled;
    point.outcomes.interrupted += row.interrupted;
    point.outcomes.other += row.other;
    byDate.set(row.date, point);
  }
  const sorted = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  return sorted.slice(-30);
}

function DateAxis({ points }: { points: DailyPoint[] }) {
  return (
    <div className="flex gap-1 pt-1 text-xs tabular-nums text-muted-foreground">
      {points.map((point, index) => (
        <div key={point.date} className="min-w-0 flex-1 text-center">
          {index === 0 || index % 7 === 0 || index === points.length - 1 ? formatDateLabel(point.date) : ""}
        </div>
      ))}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function MetricChart({
  title,
  description,
  points,
  value,
  color,
  format,
}: {
  title: string;
  description: string;
  points: DailyPoint[];
  value: (point: DailyPoint) => number;
  color: string;
  format: (value: number) => string;
}) {
  const max = Math.max(1, ...points.map(value));
  const hasData = points.some((point) => value(point) > 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <>
            <div role="img" aria-label={`${title}, daily values`} className="flex h-24 items-end gap-1">
              {points.map((point) => {
                const amount = value(point);
                return (
                  <div key={point.date} className="flex h-full min-w-0 flex-1 items-end" title={`${point.date}: ${format(amount)}`}>
                    <div className="w-full rounded-t-sm" style={{ height: `${amount > 0 ? Math.max(2, amount / max * 100) : 2}%`, backgroundColor: amount > 0 ? color : "var(--muted)" }} />
                  </div>
                );
              })}
            </div>
            <DateAxis points={points} />
          </>
        ) : <p className="py-8 text-center text-xs text-muted-foreground">No recorded usage in this range.</p>}
      </CardContent>
    </Card>
  );
}

function OutcomeChart({ points }: { points: DailyPoint[] }) {
  const keys = Object.keys(outcomeColors) as (keyof typeof outcomeColors)[];
  const max = Math.max(1, ...points.map((point) => keys.reduce((sum, key) => sum + point.outcomes[key], 0)));
  const hasData = points.some((point) => keys.some((key) => point.outcomes[key] > 0));
  const labels: Record<keyof typeof outcomeColors, string> = {
    succeeded: "Succeeded",
    failed: "Failed",
    timedOut: "Timed out",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
    other: "Other",
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Daily outcomes</CardTitle>
        <CardDescription>Run counts grouped by terminal result.</CardDescription>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <>
            <div role="img" aria-label="Daily run outcome counts" className="flex h-24 items-end gap-1">
              {points.map((point) => {
                const total = keys.reduce((sum, key) => sum + point.outcomes[key], 0);
                return (
                  <div key={point.date} className="flex h-full min-w-0 flex-1 items-end" title={`${point.date}: ${total} runs`}>
                    {total > 0 ? (
                      <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm" style={{ height: `${Math.max(2, total / max * 100)}%` }}>
                        {keys.map((key) => point.outcomes[key] > 0 ? (
                          <div key={key} style={{ flex: point.outcomes[key], backgroundColor: outcomeColors[key] }} />
                        ) : null)}
                      </div>
                    ) : <div className="w-full rounded-sm bg-muted" style={{ height: 2 }} />}
                  </div>
                );
              })}
            </div>
            <DateAxis points={points} />
            <Legend items={keys.map((key) => ({ label: labels[key], color: outcomeColors[key] }))} />
          </>
        ) : <p className="py-8 text-center text-xs text-muted-foreground">No runs in this range.</p>}
      </CardContent>
    </Card>
  );
}

function outcomeSummary(row: RunLedgerDailyRow): string {
  return [
    row.succeeded ? `${row.succeeded} ok` : null,
    row.failed ? `${row.failed} failed` : null,
    row.timedOut ? `${row.timedOut} timed out` : null,
    row.cancelled ? `${row.cancelled} cancelled` : null,
    row.interrupted ? `${row.interrupted} interrupted` : null,
    row.other ? `${row.other} other` : null,
  ].filter(Boolean).join(" · ") || "—";
}

export function RunLedgerPanel({
  report,
  isLoading,
  error,
}: {
  report?: RunLedgerDailyReport;
  isLoading: boolean;
  error: unknown;
}) {
  if (isLoading && !report) return <PageSkeleton variant="costs" />;
  if (!report && error) return <p role="alert" className="text-sm text-destructive">Run data could not be loaded. Please try again shortly.</p>;
  if (!report) return null;

  const points = pointsForChart(report.rows);
  const rows = [...report.rows].sort((a, b) => b.date.localeCompare(a.date) || a.agentName.localeCompare(b.agentName));

  return (
    <div className="space-y-4">
      {error ? <p role="status" className="text-sm text-muted-foreground">Showing the last loaded run data. Updates will resume automatically.</p> : null}
      <p className="text-xs text-muted-foreground">Days use UTC run start time, with creation time as a fallback. Costs use linked cost events; runs awaiting accounting are marked below. Charts show the latest 30 days in the selected range.</p>
      <div className="grid gap-4 xl:grid-cols-3">
        <MetricChart title="Daily tokens" description="Input, cached input and output tokens." points={points} value={(point) => point.tokens} color="var(--status-task-in_review)" format={formatTokens} />
        <MetricChart title="Daily run cost" description="Allocated spend from the cost ledger." points={points} value={(point) => point.costCents} color="var(--status-task-icon-done)" format={formatCents} />
        <OutcomeChart points={points} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Daily runs by agent</CardTitle>
          <CardDescription>One row per agent and UTC day, including typed failure causes, retries and wasted work.</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? <p className="text-sm text-muted-foreground">No runs in this range.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-left text-xs">
                <thead className="border-b border-border text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 font-medium">UTC day</th>
                    <th className="px-2 py-2 font-medium">Agent</th>
                    <th className="px-2 py-2 text-right font-medium">Runs</th>
                    <th className="px-2 py-2 font-medium">Outcomes</th>
                    <th className="px-2 py-2 text-right font-medium">Tokens</th>
                    <th className="px-2 py-2 text-right font-medium">Cost</th>
                    <th className="px-2 py-2 font-medium">Failure causes</th>
                    <th className="px-2 py-2 text-right font-medium">Retries</th>
                    <th className="px-2 py-2 font-medium">Wasted work</th>
                    <th className="px-2 py-2 text-right font-medium">Accounting pending</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const causes = Object.entries(row.errorCauses).sort((a, b) => b[1] - a[1]);
                    const retryDetails = `${row.scheduledRetryAttempts} scheduled attempts; ${row.processLossRetryCount} process-loss retries`;
                    return (
                      <tr key={`${row.date}:${row.agentId}`} className="border-b border-border/60 align-top last:border-0">
                        <td className="whitespace-nowrap px-2 py-2 tabular-nums">{row.date}</td>
                        <td className="whitespace-nowrap px-2 py-2 font-medium">{row.agentName}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.runCount}</td>
                        <td className="min-w-44 px-2 py-2">{outcomeSummary(row)}</td>
                        <td className="px-2 py-2 text-right tabular-nums" title={`Input ${formatTokens(row.inputTokens)} · cached ${formatTokens(row.cachedInputTokens)} · output ${formatTokens(row.outputTokens)}`}>
                          {formatTokens(row.inputTokens + row.cachedInputTokens + row.outputTokens)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatCents(row.costCents)}</td>
                        <td className="max-w-64 px-2 py-2">
                          {causes.length ? causes.map(([cause, count]) => `${cause} × ${count}`).join(" · ") : "—"}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums" title={retryDetails}>{row.retryRunCount}</td>
                        <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                          {row.wastedRunCount ? `${row.wastedRunCount} runs · ${formatTokens(row.wastedTokens)} tokens · ${formatCents(row.wastedCostCents)}` : "—"}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.accountingPendingRuns || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

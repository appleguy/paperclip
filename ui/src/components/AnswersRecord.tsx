import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, FileText, MessageSquare } from "lucide-react";
import type { AnswerRecordItem } from "@paperclipai/shared";
import { answersApi } from "@/api/answers";
import { Link } from "@/lib/router";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface AnswersRecordProps {
  companyId: string;
  companyPrefix?: string | null;
}

export function AnswersRecord({ companyId, companyPrefix = "SCO" }: AnswersRecordProps) {
  const [search, setSearch] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["answers", companyId, search],
    queryFn: () => answersApi.list(companyId, { search: search.trim() || undefined, limit: 50 }),
    enabled: Boolean(companyId),
  });

  const items = useMemo(() => data?.items ?? [], [data?.items]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
        <ToolbarSearch
          query={search}
          onQueryChange={setSearch}
          label="Search answers"
          placeholder="Search questions, answers, tasks…"
        />
        <div className="text-xs text-muted-foreground self-center sm:self-auto tabular-nums">
          {items.length} {items.length === 1 ? "answer" : "answers"}
        </div>
      </div>

      {isLoading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading past answers…
        </p>
      )}

      {error && (
        <div role="alert" className="text-sm text-destructive">
          Failed to load answers: {String((error as Error).message || error)}
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {search.trim() ? "No past answers match your search." : "No past answers recorded yet."}
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {items.map((item: AnswerRecordItem) => {
          const issueRef = item.issueIdentifier ?? item.issueId;
          const href = companyPrefix
            ? `/${encodeURIComponent(companyPrefix)}/issues/${encodeURIComponent(issueRef)}#interaction-${encodeURIComponent(item.id)}`
            : item.href;

          return (
            <Card key={item.id} className="transition-colors hover:border-foreground/20">
              <CardHeader className="space-y-2 pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono text-xs">
                      {item.issueIdentifier ?? "Task"}
                    </Badge>
                    {item.projectName && (
                      <Badge variant="secondary" className="text-xs">
                        {item.projectName}
                      </Badge>
                    )}
                    {item.agentName && (
                      <span className="text-xs text-muted-foreground">
                        via {item.agentName}
                      </span>
                    )}
                  </div>
                  <time className="text-xs text-muted-foreground tabular-nums" dateTime={item.resolvedAt}>
                    {new Date(item.resolvedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                </div>
                <CardTitle className="text-base font-semibold leading-snug">
                  <Link to={href} className="hover:underline flex items-center gap-1.5">
                    {item.issueTitle}
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  </Link>
                </CardTitle>
                {item.title && item.title !== item.issueTitle && (
                  <CardDescription className="text-xs text-foreground/80 flex items-center gap-1">
                    <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0" />
                    {item.title}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                {item.questions.length > 0 ? (
                  <div className="space-y-2 rounded-md bg-muted/40 p-3 text-xs">
                    {item.questions.map((q) => (
                      <div key={q.questionId} className="space-y-1">
                        <div className="text-muted-foreground font-medium">
                          {q.prompt}
                        </div>
                        <div className="flex items-start gap-1.5 text-foreground font-semibold">
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
                          <span>{q.answers.join(", ") || "Answer recorded"}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  item.summary && (
                    <div className="rounded-md bg-muted/40 p-3 text-xs text-foreground/90 whitespace-pre-wrap">
                      {item.summary}
                    </div>
                  )
                )}

                {item.documents.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="text-xs text-muted-foreground">Documents:</span>
                    {item.documents.map((doc) => (
                      <Button key={doc.key} variant="outline" size="sm" asChild className="h-6 text-xs px-2">
                        <Link to={doc.href} className="flex items-center gap-1">
                          <FileText className="h-3 w-3" />
                          {doc.title || doc.key}
                        </Link>
                      </Button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

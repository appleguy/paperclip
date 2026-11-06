import { and, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
  agents,
  companies,
  documents,
  issues,
  issueDocuments,
  issueThreadInteractions,
  projects,
  type Db,
} from "@paperclipai/db";
import type {
  AnswerDocumentLink,
  AnswerRecordItem,
  AnswersQuery,
  AnswersResponse,
  AskUserQuestionsPayload,
  AskUserQuestionsResult,
  FormattedQuestionAnswer,
} from "@paperclipai/shared";
import { issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";

export type ListAnswersOptions = AnswersQuery & {
  actor: AuthorizationActor;
  userId?: string | null;
};

export function answersService(db: Db) {
  return {
    async list(companyId: string, options: ListAnswersOptions): Promise<AnswersResponse> {
      const limit = Math.min(Math.max(1, options.limit ?? 50), 100);
      const readable = await issueReadSqlCondition(db, options.actor);

      const [company] = await db
        .select({ prefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, companyId));

      if (!company) {
        return { items: [], nextCursor: null };
      }

      const conditions = [
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.kind, "ask_user_questions"),
        eq(issueThreadInteractions.status, "answered"),
        isNotNull(issueThreadInteractions.resolvedAt),
        readable,
      ];

      if (options.projectId) {
        conditions.push(eq(issues.projectId, options.projectId));
      }

      if (options.issueId) {
        conditions.push(eq(issues.id, options.issueId));
      }

      if (options.search?.trim()) {
        const term = options.search.trim().replace(/[\\%_]/g, "\\$&");
        conditions.push(
          or(
            ilike(issues.identifier, `%${term}%`),
            ilike(issues.title, `%${term}%`),
            ilike(issueThreadInteractions.title, `%${term}%`),
            ilike(issueThreadInteractions.summary, `%${term}%`),
            sql`(${issueThreadInteractions.payload})::text ILIKE ${"%" + term + "%"}`,
            sql`(${issueThreadInteractions.result})::text ILIKE ${"%" + term + "%"}`
          )!
        );
      }

      if (options.cursor) {
        const cursorDate = new Date(options.cursor);
        if (Number.isFinite(cursorDate.getTime())) {
          conditions.push(sql`${issueThreadInteractions.resolvedAt} < ${cursorDate.toISOString()}::timestamptz`);
        }
      }

      const rows = await db
        .select({
          id: issueThreadInteractions.id,
          companyId: issueThreadInteractions.companyId,
          issueId: issues.id,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueStatus: issues.status,
          projectId: projects.id,
          projectName: projects.name,
          title: issueThreadInteractions.title,
          summary: issueThreadInteractions.summary,
          payload: issueThreadInteractions.payload,
          result: issueThreadInteractions.result,
          resolvedAt: issueThreadInteractions.resolvedAt,
          resolvedByUserId: issueThreadInteractions.resolvedByUserId,
          resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
          agentId: agents.id,
          agentName: agents.name,
          createdAt: issueThreadInteractions.createdAt,
        })
        .from(issueThreadInteractions)
        .innerJoin(issues, and(eq(issues.id, issueThreadInteractions.issueId), eq(issues.companyId, companyId)))
        .leftJoin(agents, and(eq(agents.id, issueThreadInteractions.createdByAgentId), eq(agents.companyId, companyId)))
        .leftJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, companyId)))
        .where(and(...conditions))
        .orderBy(desc(issueThreadInteractions.resolvedAt), desc(issueThreadInteractions.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const issueIds = [...new Set(pageRows.map((r) => r.issueId))];
      const docsByIssueId = new Map<string, AnswerDocumentLink[]>();

      if (issueIds.length > 0) {
        const docRows = await db
          .select({
            issueId: issueDocuments.issueId,
            key: issueDocuments.key,
            title: documents.title,
          })
          .from(issueDocuments)
          .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
          .where(and(eq(issueDocuments.companyId, companyId), inArray(issueDocuments.issueId, issueIds)));

        for (const doc of docRows) {
          const list = docsByIssueId.get(doc.issueId) ?? [];
          const issueRef = pageRows.find((r) => r.issueId === doc.issueId)?.issueIdentifier ?? doc.issueId;
          list.push({
            key: doc.key,
            title: doc.title,
            href: `/${encodeURIComponent(company.prefix)}/issues/${encodeURIComponent(issueRef)}#document-${encodeURIComponent(doc.key)}`,
          });
          docsByIssueId.set(doc.issueId, list);
        }
      }

      const items: AnswerRecordItem[] = pageRows.map((row) => {
        const payload = row.payload as AskUserQuestionsPayload;
        const result = row.result as AskUserQuestionsResult | null | undefined;

        const questionsList: Array<{
          id: string;
          prompt: string;
          header?: string;
          helpText?: string | null;
          options: Array<{ id: string; label: string; description?: string | null }>;
        }> = [];

        if (payload?.questionSet?.questions?.length) {
          for (const q of payload.questionSet.questions) {
            questionsList.push({
              id: q.id,
              prompt: q.prompt,
              header: q.header,
              helpText: q.helpText,
              options: (q.options ?? []).map((o) => ({ id: o.id, label: o.label, description: o.description })),
            });
          }
        } else if (payload?.questions?.length) {
          for (const q of payload.questions) {
            questionsList.push({
              id: q.id,
              prompt: q.prompt,
              helpText: q.helpText,
              options: (q.options ?? []).map((o) => ({ id: o.id, label: o.label, description: o.description })),
            });
          }
        }

        const answersByQuestionId = new Map(
          (result?.answers ?? []).map((a) => [a.questionId, a])
        );

        const formattedQuestions: FormattedQuestionAnswer[] = questionsList.map((q) => {
          const answer = answersByQuestionId.get(q.id);
          const optionMap = new Map(q.options.map((o) => [o.id, o.label]));
          const selectedOptionLabels = (answer?.optionIds ?? []).map(
            (optId) => optionMap.get(optId) ?? optId
          );
          const otherText = answer?.otherText?.trim() || null;
          const answerTexts = [...selectedOptionLabels];
          if (otherText) answerTexts.push(otherText);

          return {
            questionId: q.id,
            prompt: q.prompt,
            header: q.header ?? null,
            helpText: q.helpText ?? null,
            selectedOptionLabels,
            otherText,
            answers: answerTexts,
          };
        });

        let summary = result?.summaryMarkdown?.trim() ?? "";
        if (!summary && formattedQuestions.length > 0) {
          const lines = formattedQuestions.map((fq) => {
            const qText = fq.header && fq.header !== fq.prompt ? `${fq.header}: ${fq.prompt}` : fq.prompt;
            return `- ${qText}: ${fq.answers.join(", ") || "No answer"}`;
          });
          summary = lines.join("\n");
        }
        if (!summary) {
          summary = row.summary ?? row.title ?? "Answer recorded";
        }

        const issueRef = row.issueIdentifier ?? row.issueId;
        const href = `/${encodeURIComponent(company.prefix)}/issues/${encodeURIComponent(issueRef)}#interaction-${encodeURIComponent(row.id)}`;

        return {
          id: row.id,
          issueId: row.issueId,
          issueIdentifier: row.issueIdentifier,
          issueTitle: row.issueTitle,
          issueStatus: row.issueStatus,
          projectId: row.projectId,
          projectName: row.projectName,
          title: row.title ?? formattedQuestions[0]?.prompt ?? row.issueTitle,
          summary,
          questions: formattedQuestions,
          documents: docsByIssueId.get(row.issueId) ?? [],
          resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : new Date().toISOString(),
          resolvedByUserId: row.resolvedByUserId,
          resolvedByAgentId: row.resolvedByAgentId,
          agentId: row.agentId,
          agentName: row.agentName,
          href,
        };
      });

      const nextCursor =
        hasMore && pageRows.length > 0 && pageRows[pageRows.length - 1].resolvedAt
          ? pageRows[pageRows.length - 1].resolvedAt!.toISOString()
          : null;

      return {
        items,
        nextCursor,
      };
    },
  };
}

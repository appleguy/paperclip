import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueComments, issueThreadInteractions } from "@paperclipai/db";
import { badRequest, conflict, notFound } from "../errors.js";

/**
 * Short displayed references for API-only ids.
 *
 * Continuation rendering already shortens issue ids to their identifier, the
 * company id to `$PAPERCLIP_COMPANY_ID` and source digests to their first 12
 * hex characters. Message, interaction and run ids have no readable equivalent,
 * so they keep the display convention already used for pending waits in
 * `task-watchdogs`: the first 8 id characters plus an ellipsis. Storage and wire
 * payloads keep the full ids; this module only maps the displayed prefix back.
 */
export const SHORT_REFERENCE_LENGTH = 8;

const MAX_PREFIX_CANDIDATES = 2;

export type ShortReferenceKind = "message" | "interaction" | "run";

const KIND_LABELS: Record<ShortReferenceKind, string> = {
  message: "Message",
  interaction: "Interaction",
  run: "Run",
};

/** Presentation only: never changes the stored id. */
export function shortReference(id: string): string {
  return id.length > SHORT_REFERENCE_LENGTH ? `${id.slice(0, SHORT_REFERENCE_LENGTH)}…` : id;
}

/**
 * Normalize a displayed reference to lowercase hex without dashes. Accepts the
 * rendered `abcdef12…` form, a bare prefix and the 12-character digest-style
 * prefix used for source revisions.
 */
export function normalizeShortReference(reference: string): string | null {
  const raw = reference.trim().replace(/(?:…|\.{3})$/, "").toLowerCase();
  const hex = raw.replace(/-/g, "");
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  if (hex.length < SHORT_REFERENCE_LENGTH) return null;
  return hex;
}

export type ShortReferenceMatch =
  | { status: "resolved"; id: string }
  | { status: "ambiguous" }
  | { status: "missing" }
  | { status: "invalid" };

/**
 * Unique-prefix match against ids already scoped to one company. Callers must
 * pass company-scoped candidates; a reference must never resolve across
 * companies.
 */
export function matchShortReference(reference: string, ids: readonly string[]): ShortReferenceMatch {
  const prefix = normalizeShortReference(reference);
  if (!prefix) return { status: "invalid" };
  const matches = ids.filter((id) => id.toLowerCase().replace(/-/g, "").startsWith(prefix));
  if (matches.length === 1) return { status: "resolved", id: matches[0]! };
  if (matches.length > 1) return { status: "ambiguous" };
  return { status: "missing" };
}

/** Resolve or throw a clear 400/404/409, matching the existing reference routes. */
export function requireShortReference(
  kind: ShortReferenceKind,
  reference: string,
  ids: readonly string[],
): string {
  const match = matchShortReference(reference, ids);
  const label = KIND_LABELS[kind];
  if (match.status === "resolved") return match.id;
  if (match.status === "ambiguous") {
    throw conflict(`${label} reference "${reference.trim()}" is ambiguous in this company. Use the full id.`);
  }
  if (match.status === "missing") {
    throw notFound(`${label} reference "${reference.trim()}" was not found in this company.`);
  }
  throw badRequest(
    `${label} reference "${reference.trim()}" is not a full id or a short reference of at least ${SHORT_REFERENCE_LENGTH} hex characters.`,
  );
}

export interface ShortReferenceResolverDeps {
  /** Candidate ids visible inside one company for the requested kind. */
  loadCandidateIds(kind: ShortReferenceKind, companyId: string, prefix: string): Promise<string[]>;
}

export interface ShortReferenceResolver {
  display(id: string): string;
  resolve(input: { companyId: string; kind: ShortReferenceKind; reference: string }): Promise<string>;
}

export function createShortReferenceResolver(deps: ShortReferenceResolverDeps): ShortReferenceResolver {
  return {
    display: shortReference,
    async resolve(input) {
      const prefix = normalizeShortReference(input.reference);
      if (!prefix) {
        // Preserve the clear 400 rather than querying with a meaningless prefix.
        return requireShortReference(input.kind, input.reference, []);
      }
      const ids = await deps.loadCandidateIds(input.kind, input.companyId, prefix);
      return requireShortReference(input.kind, input.reference, ids);
    },
  };
}

/**
 * Company-scoped loader over the real tables. Only ids matching the displayed
 * prefix are read, and only two are needed to distinguish unique from ambiguous.
 */
export function createDbShortReferenceResolver(db: Db): ShortReferenceResolver {
  return createShortReferenceResolver({
    async loadCandidateIds(kind, companyId, prefix) {
      const pattern = `${prefix}%`;
      if (kind === "message") {
        return db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(and(
            eq(issueComments.companyId, companyId),
            sql`replace(${issueComments.id}::text, '-', '') like ${pattern}`,
          ))
          .limit(MAX_PREFIX_CANDIDATES)
          .then((rows) => rows.map((row) => row.id));
      }
      if (kind === "interaction") {
        return db
          .select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions)
          .where(and(
            eq(issueThreadInteractions.companyId, companyId),
            sql`replace(${issueThreadInteractions.id}::text, '-', '') like ${pattern}`,
          ))
          .limit(MAX_PREFIX_CANDIDATES)
          .then((rows) => rows.map((row) => row.id));
      }
      return db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          sql`replace(${heartbeatRuns.id}::text, '-', '') like ${pattern}`,
        ))
        .limit(MAX_PREFIX_CANDIDATES)
        .then((rows) => rows.map((row) => row.id));
    },
  });
}

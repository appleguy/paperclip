import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/** Former identifiers (e.g. SCO-727 after a re-key to A-1) that must keep resolving. */
export const issueIdentifierAliases = pgTable(
  "issue_identifier_aliases",
  {
    identifier: text("identifier").primaryKey(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("issue_identifier_aliases_issue_idx").on(table.issueId),
  }),
);

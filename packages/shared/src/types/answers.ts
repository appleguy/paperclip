export interface FormattedQuestionAnswer {
  questionId: string;
  prompt: string;
  header?: string | null;
  helpText?: string | null;
  selectedOptionLabels: string[];
  otherText?: string | null;
  answers: string[];
}

export interface AnswerDocumentLink {
  key: string;
  title: string | null;
  href: string;
}

export interface AnswerRecordItem {
  id: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  issueStatus: string;
  projectId: string | null;
  projectName: string | null;
  title: string | null;
  summary: string;
  questions: FormattedQuestionAnswer[];
  documents: AnswerDocumentLink[];
  resolvedAt: string;
  resolvedByUserId: string | null;
  resolvedByAgentId: string | null;
  agentId: string | null;
  agentName: string | null;
  href: string;
}

export interface AnswersQuery {
  search?: string;
  limit?: number;
  cursor?: string;
  projectId?: string;
  issueId?: string;
}

export interface AnswersResponse {
  items: AnswerRecordItem[];
  nextCursor: string | null;
  totalCount?: number;
}

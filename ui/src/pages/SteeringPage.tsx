import { useEffect } from "react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { AnswersRecord } from "@/components/AnswersRecord";

export function SteeringPage() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Steering" }, { label: "Answers record" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Select a company to view the Steering answers record.
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Steering · Answers record</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Search and read past owner questions and their answers across tasks and documents.
        </p>
      </div>
      <AnswersRecord
        companyId={selectedCompanyId}
        companyPrefix={selectedCompany?.issuePrefix ?? null}
      />
    </div>
  );
}

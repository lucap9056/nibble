import type { ExpectedBubble } from "@/expected-bubble";

export interface ReportError {
  name: string;
  message: string;
}

export type BootstrapRejectReason = "invalid" | "duplicate" | "missing-source";

export interface BootstrapRejection {
  index: number;
  name?: string;
  reason: BootstrapRejectReason;
  error: ReportError;
}

export type BubbleSyncStage = "build" | "resolve" | "start";

export type AcceptedBubble = ExpectedBubble &
  (
    | { status: "running"; runningHash: string }
    | { status: "failed"; stage: BubbleSyncStage; error: ReportError }
  );

export type EngineReport =
  | { type: "received" }
  | {
      type: "processed";
      bubbles: AcceptedBubble[];
      rejected: BootstrapRejection[];
    };

export interface DaemonEndpoint {
  id: string;
  reportSocket: string;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const isDaemonEndpoint = (value: unknown): value is DaemonEndpoint => {
  if (typeof value !== "object" || value === null) return false;
  const { id, reportSocket } = value as Record<string, unknown>;
  return isNonEmptyString(id) && isNonEmptyString(reportSocket);
};

export const toReportError = (err: unknown): ReportError => {
  const { name, message } = err instanceof Error ? err : new Error(String(err));
  return { name, message };
};

export const sendReport = async (
  daemon: DaemonEndpoint | undefined,
  report: EngineReport,
) => {
  if (daemon === undefined) return;
  const body = JSON.stringify({ ...report, id: daemon.id });
  const response = await fetch("http://daemon/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    unix: daemon.reportSocket,
  });
  if (!response.ok) {
    const reason = await response.text();
    throw new Error(`Daemon rejected ${report.type} report: ${reason}`);
  }
};

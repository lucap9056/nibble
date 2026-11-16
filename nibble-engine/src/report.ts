export type BootstrapFailureStage =
  | "invalid"
  | "duplicate"
  | "build"
  | "resolve"
  | "start";

export interface BootstrapFailure {
  index: number;
  name?: string;
  stage: BootstrapFailureStage;
  error: { name: string; message: string };
}

export type EngineReport =
  | { type: "received" }
  | { type: "processed"; failures: BootstrapFailure[] };

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

export const toBootstrapFailure = (
  index: number,
  name: string | undefined,
  stage: BootstrapFailureStage,
  err: unknown,
): BootstrapFailure => {
  const { name: errorName, message } =
    err instanceof Error ? err : new Error(String(err));
  return { index, name, stage, error: { name: errorName, message } };
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

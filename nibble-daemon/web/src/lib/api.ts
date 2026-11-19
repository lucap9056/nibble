import { session } from "./session.svelte";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Session {
  token: string;
  expiresAt: string;
}

export type BubbleStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "exited";

export interface Source {
  name: string;
  entry: string;
}

export interface RunningBubble {
  name: string;
  route: string;
  state: BubbleStatus;
  snapshotHash: string;
  createdAt: string;
  routing: boolean;
  routed: boolean;
}

export interface DesiredInput {
  snapshotHash: string;
  enabled: boolean;
  routing: boolean;
}

export interface Desired extends DesiredInput {
  name: string;
}

export interface Bubble {
  name: string;
  source: Source | null;
  running: RunningBubble | null;
  desired: Desired | null;
}

export interface Snapshot {
  hash: string;
  createdAt: string;
  running: boolean;
  desired: boolean;
}

export interface BubbleDetail extends Bubble {
  snapshots: Snapshot[];
}

export const errorMessage = (err: unknown) =>
  err instanceof ApiError ? err.message : "Unable to reach the daemon";

const request = async (method: string, path: string, body?: unknown) => {
  const token = session.current?.token;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const payload = body === undefined ? undefined : JSON.stringify(body);
  const response = await fetch(path, { method, headers, body: payload });
  if (!response.ok) {
    if (response.status === 401 && token) {
      session.end();
    }
    const failure = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new ApiError(response.status, failure.error ?? response.statusText);
  }
  return response;
};

export const login = async (password: string): Promise<Session> => {
  const response = await request("POST", "api/login", { password });
  return response.json();
};

export const changePassword = async (
  currentPassword: string,
  newPassword: string,
) => {
  await request("PUT", "api/password", { currentPassword, newPassword });
};

export const listBubbles = async (): Promise<Bubble[]> => {
  const response = await request("GET", "api/bubbles");
  const { bubbles } = (await response.json()) as { bubbles: Bubble[] };
  return bubbles;
};

export const getBubble = async (name: string): Promise<BubbleDetail> => {
  const response = await request("GET", `api/bubbles/${name}`);
  return response.json();
};

export const saveBubble = async (name: string, input: DesiredInput) => {
  await request("PUT", `api/bubbles/${name}`, input);
};

export const restartBubble = async (name: string) => {
  await request("POST", `api/bubbles/${name}`);
};

export const deleteBubble = async (name: string) => {
  await request("DELETE", `api/bubbles/${name}`);
};

export const buildSnapshot = async (name: string) => {
  await request("POST", `api/snapshots/${name}`);
};

export const deleteSnapshot = async (name: string, hash: string) => {
  const query = new URLSearchParams({ hash });
  await request("DELETE", `api/snapshots/${name}?${query}`);
};

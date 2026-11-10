export interface DefaultNibbleWebSocketContext {
  connId: string;
}

export const createDefaultNibbleWebSocketContext =
  (): DefaultNibbleWebSocketContext => ({
    connId: Bun.randomUUIDv7(),
  });

export type NibbleWebSocket<T = DefaultNibbleWebSocketContext> =
  Bun.ServerWebSocket<T>;

export interface NibbleWebSocketHandlers<T = DefaultNibbleWebSocketContext> {
  upgrade?: (req: Request) => T | Response | Promise<T | Response>;
  onconnect?: (ws: NibbleWebSocket<T>) => void | Promise<void>;
  onmessage?: (
    ws: NibbleWebSocket<T>,
    message: string | Buffer<ArrayBuffer>,
  ) => void | Promise<void>;
  onclose?: (
    ws: NibbleWebSocket<T>,
    code: number,
    reason: string,
  ) => void | Promise<void>;
}

export const NIBBLE_HTTP_METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
] as const;

export type NibbleHttpMethod = (typeof NIBBLE_HTTP_METHODS)[number];

export type NibbleHttpHandler = (req: Request) => Response | Promise<Response>;

export type NibbleHandlers<T = DefaultNibbleWebSocketContext> = {
  [Method in NibbleHttpMethod]?: NibbleHttpHandler;
} & {
  wss?: NibbleWebSocketHandlers<T>;
};

export interface NibbleBubble<T = DefaultNibbleWebSocketContext> {
  handlers: NibbleHandlers<T>;
}

export class NibbleDefinitionError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    const details = issues.map((issue) => `  - ${issue}`).join("\n");
    super(`Invalid bubble definition:\n${details}`);
    this.name = "NibbleDefinitionError";
    this.issues = issues;
  }
}

const FUNCTION_KEYS = ["handlers"] as const;

const WEBSOCKET_EVENT_KEYS = [
  "onconnect",
  "onmessage",
  "onclose",
] as const satisfies readonly (keyof NibbleWebSocketHandlers)[];

const WEBSOCKET_KEYS = ["upgrade", ...WEBSOCKET_EVENT_KEYS] as const;

const HANDLER_KEYS = [...NIBBLE_HTTP_METHODS, "wss"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function collectUnknownKeyIssues(
  value: Record<string, unknown>,
  knownKeys: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!knownKeys.includes(key)) {
      issues.push(`${path}${key} is not a recognized option`);
    }
  }
}

function collectOptionalIssue(
  value: unknown,
  guard: (value: unknown) => boolean,
  message: string,
  issues: string[],
): void {
  if (value !== undefined && !guard(value)) {
    issues.push(message);
  }
}

function collectWebSocketIssues(value: unknown, issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push("handlers.wss must be an object");
    return;
  }

  collectUnknownKeyIssues(value, WEBSOCKET_KEYS, "handlers.wss.", issues);
  for (const key of WEBSOCKET_KEYS) {
    collectOptionalIssue(
      value[key],
      isFunction,
      `handlers.wss.${key} must be a function`,
      issues,
    );
  }

  if (!WEBSOCKET_EVENT_KEYS.some((key) => isFunction(value[key]))) {
    issues.push(
      `handlers.wss must define at least one of ${WEBSOCKET_EVENT_KEYS.join(", ")}`,
    );
  }
}

function collectHandlersIssues(value: unknown, issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push("handlers must be an object");
    return;
  }

  collectUnknownKeyIssues(value, HANDLER_KEYS, "handlers.", issues);
  for (const method of NIBBLE_HTTP_METHODS) {
    collectOptionalIssue(
      value[method],
      isFunction,
      `handlers.${method} must be a function`,
      issues,
    );
  }

  if (value.wss !== undefined) {
    collectWebSocketIssues(value.wss, issues);
  }

  const hasHttpHandler = NIBBLE_HTTP_METHODS.some((method) =>
    isFunction(value[method]),
  );
  if (!hasHttpHandler && value.wss === undefined) {
    issues.push(
      `handlers must define at least one of ${HANDLER_KEYS.join(", ")}`,
    );
  }
}

function collectFunctionIssues(value: unknown): string[] {
  const issues: string[] = [];

  if (!isPlainObject(value)) {
    issues.push("definition must be an object");
    return issues;
  }

  collectUnknownKeyIssues(value, FUNCTION_KEYS, "", issues);
  collectHandlersIssues(value.handlers, issues);

  return issues;
}

export function assertBubble(
  value: unknown,
): asserts value is NibbleBubble<unknown> {
  const issues = collectFunctionIssues(value);
  if (issues.length > 0) {
    throw new NibbleDefinitionError(issues);
  }
}

/**
 * @example
 * ```ts
 * interface UserWebSocketContext {
 *   user: string;
 * }
 *
 * export default define({
 *   handlers: {
 *     get: (req) => Response.json({ url: req.url }),
 *     post: async (req) => Response.json(await req.json(), { status: 201 }),
 *     put: async (req) => Response.json(await req.json()),
 *     patch: async (req) => Response.json(await req.json()),
 *     delete: () => new Response(null, { status: 204 }),
 *     options: () =>
 *       new Response(null, {
 *         status: 204,
 *         headers: { Allow: "GET, POST, PUT, PATCH, DELETE, OPTIONS" },
 *       }),
 *     wss: {
 *       upgrade: (req): UserWebSocketContext | Response => {
 *         const user = req.headers.get("X-User");
 *         if (!user) return new Response(null, { status: 401 });
 *         return { user };
 *       },
 *       onconnect: (ws) => { ws.send(`hello ${ws.data.user}`) }, // ws.data is UserWebSocketContext
 *       onmessage: (ws, message) => { ws.send(message) },
 *       onclose: (ws, code, reason) => { console.log(ws.data.user, code, reason) },
 *     },
 *   },
 * });
 * ```
 */
export function define<T = DefaultNibbleWebSocketContext>(
  f: NibbleBubble<T>,
): NibbleBubble<T> {
  assertBubble(f);
  return f;
}

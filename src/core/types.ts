export interface DefaultNibbleWebSocketContext {
  connId: string;
}

export type NibbleWebSocket<T = DefaultNibbleWebSocketContext> =
  Bun.ServerWebSocket<T>;

export interface NibbleWebSocketHandlers<T = DefaultNibbleWebSocketContext> {
  upgrade?: (req: Request) => T;
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
] as const;

export type NibbleHttpMethod = (typeof NIBBLE_HTTP_METHODS)[number];

export type NibbleHttpHandler = (req: Request) => Response | Promise<Response>;

export type NibbleHandlers<T = DefaultNibbleWebSocketContext> = {
  [Method in NibbleHttpMethod]?: NibbleHttpHandler;
} & {
  wss?: NibbleWebSocketHandlers<T>;
};

export type NibbleCorsMethod = Uppercase<NibbleHttpMethod> | "HEAD" | "OPTIONS";

export const NIBBLE_CORS_METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
] as const satisfies readonly NibbleCorsMethod[];

export type NibbleOrigin = `${string}://${string}`;

interface NibbleCorsOptions {
  methods?: NibbleCorsMethod[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  maxAge?: number;
}

interface NibbleWildcardCors extends NibbleCorsOptions {
  origin?: "*";
  credentials?: false;
}

interface NibbleExplicitOriginCors extends NibbleCorsOptions {
  origin: NibbleOrigin | NibbleOrigin[];
  credentials?: boolean;
}

export type NibbleCors = NibbleWildcardCors | NibbleExplicitOriginCors;

export interface NibbleBubble<T = DefaultNibbleWebSocketContext> {
  cors?: NibbleCors;
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

const FUNCTION_KEYS = ["cors", "handlers"] as const;

const CORS_KEYS = [
  "origin",
  "methods",
  "allowedHeaders",
  "exposedHeaders",
  "credentials",
  "maxAge",
] as const satisfies readonly (keyof NibbleExplicitOriginCors)[];

const WEBSOCKET_EVENT_KEYS = [
  "onconnect",
  "onmessage",
  "onclose",
] as const satisfies readonly (keyof NibbleWebSocketHandlers)[];

const WEBSOCKET_KEYS = ["upgrade", ...WEBSOCKET_EVENT_KEYS] as const;

const HANDLER_KEYS = [...NIBBLE_HTTP_METHODS, "wss"] as const;

const ORIGIN_PATTERN = /^[a-z][a-z\d+.-]*:\/\/[^/?#\s]+$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNibbleOrigin(value: unknown): value is NibbleOrigin {
  return typeof value === "string" && ORIGIN_PATTERN.test(value);
}

function isOrigin(
  value: unknown,
): value is "*" | NibbleOrigin | NibbleOrigin[] {
  return (
    value === "*" ||
    isNibbleOrigin(value) ||
    (Array.isArray(value) && value.length > 0 && value.every(isNibbleOrigin))
  );
}

function isCorsMethod(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (NIBBLE_CORS_METHODS as readonly string[]).includes(value.toUpperCase())
  );
}

function isCorsMethodArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isCorsMethod);
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

function collectCorsIssues(value: unknown, issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push("cors must be an object");
    return;
  }

  collectUnknownKeyIssues(value, CORS_KEYS, "cors.", issues);
  collectOptionalIssue(
    value.origin,
    isOrigin,
    'cors.origin must be "*", an origin such as "https://example.com" (no trailing slash), or a non-empty array of origins',
    issues,
  );
  collectOptionalIssue(
    value.methods,
    isCorsMethodArray,
    `cors.methods must be an array of ${NIBBLE_CORS_METHODS.join(", ")}`,
    issues,
  );
  collectOptionalIssue(
    value.allowedHeaders,
    isNonEmptyStringArray,
    "cors.allowedHeaders must be an array of non-empty strings",
    issues,
  );
  collectOptionalIssue(
    value.exposedHeaders,
    isNonEmptyStringArray,
    "cors.exposedHeaders must be an array of non-empty strings",
    issues,
  );
  collectOptionalIssue(
    value.credentials,
    isBoolean,
    "cors.credentials must be a boolean",
    issues,
  );
  collectOptionalIssue(
    value.maxAge,
    isNonNegativeInteger,
    "cors.maxAge must be a non-negative integer",
    issues,
  );

  const isWildcardOrigin = value.origin === undefined || value.origin === "*";
  if (value.credentials === true && isWildcardOrigin) {
    issues.push(
      'cors.credentials cannot be true when cors.origin is "*" (browsers reject this combination); list explicit origins instead',
    );
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
  if (value.cors !== undefined) {
    collectCorsIssues(value.cors, issues);
  }
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
 *   cors: {
 *     origin: ["https://example.com"],
 *     methods: ["GET", "POST"],
 *     allowedHeaders: ["Content-Type", "Authorization"],
 *     exposedHeaders: ["X-Request-Id"],
 *     credentials: true,
 *     maxAge: 600,
 *   },
 *   handlers: {
 *     get: (req) => Response.json({ url: req.url }),
 *     post: async (req) => Response.json(await req.json(), { status: 201 }),
 *     put: async (req) => Response.json(await req.json()),
 *     patch: async (req) => Response.json(await req.json()),
 *     delete: () => new Response(null, { status: 204 }),
 *     wss: {
 *       upgrade: (req): UserWebSocketContext => ({
 *         user: req.headers.get("X-User") ?? "anonymous",
 *       }),
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

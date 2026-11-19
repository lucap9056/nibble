import {
  type DefaultNibbleWebSocketContext,
  NIBBLE_HTTP_METHODS,
  NibbleDefinitionError,
  type NibbleHandlers,
  type NibbleHttpHandler,
  type NibbleHttpMethod,
  type NibbleWebSocketHandlers,
} from "@lucap9056/nibble";

export type NibbleCorsMethod = Uppercase<NibbleHttpMethod>;

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

const CORS_KEYS = [
  "origin",
  "methods",
  "allowedHeaders",
  "exposedHeaders",
  "credentials",
  "maxAge",
] as const satisfies readonly (keyof NibbleExplicitOriginCors)[];

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

function isCorsMethod(value: unknown): value is NibbleCorsMethod {
  return (
    typeof value === "string" &&
    (NIBBLE_HTTP_METHODS as readonly string[]).includes(value.toLowerCase())
  );
}

function isCorsMethodArray(value: unknown): value is NibbleCorsMethod[] {
  return Array.isArray(value) && value.every(isCorsMethod);
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

function collectCorsIssues(value: unknown): string[] {
  const issues: string[] = [];

  if (!isPlainObject(value)) {
    issues.push("cors must be an object");
    return issues;
  }

  for (const key of Object.keys(value)) {
    if (!(CORS_KEYS as readonly string[]).includes(key)) {
      issues.push(`cors.${key} is not a recognized option`);
    }
  }
  collectOptionalIssue(
    value.origin,
    isOrigin,
    'cors.origin must be "*", an origin such as "https://example.com" (no trailing slash), or a non-empty array of origins',
    issues,
  );
  collectOptionalIssue(
    value.methods,
    isCorsMethodArray,
    `cors.methods must be an array of ${NIBBLE_HTTP_METHODS.map((method) => method.toUpperCase()).join(", ")}`,
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

  return issues;
}

function assertCors(value: unknown): asserts value is NibbleCors {
  const issues = collectCorsIssues(value);
  if (issues.length > 0) {
    throw new NibbleDefinitionError(issues);
  }
}

interface ResolvedCors {
  allowedOrigins?: ReadonlySet<string>;
  allowMethods: string;
  allow: string;
  allowedHeaders?: string;
  exposedHeaders?: string;
  credentials: boolean;
  maxAge?: string;
}

function listDefinedMethods(handlers: NibbleHandlers<unknown>): string[] {
  return NIBBLE_HTTP_METHODS.filter((method) => handlers[method]).map(
    (method) => method.toUpperCase(),
  );
}

function resolveCors(
  options: NibbleCors,
  handlers: NibbleHandlers<unknown>,
): ResolvedCors {
  const definedMethods = listDefinedMethods(handlers);
  const allow = [...new Set([...definedMethods, "OPTIONS"])].join(", ");
  const isWildcard = options.origin === undefined || options.origin === "*";

  return {
    allowedOrigins: isWildcard
      ? undefined
      : new Set(
          [options.origin]
            .flat()
            .map((origin) => (origin as NibbleOrigin).toLowerCase()),
        ),
    allowMethods: (options.methods ?? definedMethods).join(", "),
    allow,
    allowedHeaders: options.allowedHeaders?.join(", "),
    exposedHeaders: options.exposedHeaders?.join(", "),
    credentials: options.credentials === true,
    maxAge: options.maxAge?.toString(),
  };
}

function isAllowedOrigin(cors: ResolvedCors, origin: string): boolean {
  return cors.allowedOrigins?.has(origin.toLowerCase()) ?? true;
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", value);
    return;
  }

  const values = current.split(",").map((item) => item.trim().toLowerCase());
  if (values.includes("*") || values.includes(value.toLowerCase())) {
    return;
  }
  headers.set("Vary", `${current}, ${value}`);
}

function applyOriginHeaders(
  headers: Headers,
  cors: ResolvedCors,
  origin: string | null,
): boolean {
  if (cors.allowedOrigins) {
    appendVary(headers, "Origin");
  }
  if (origin === null || !isAllowedOrigin(cors, origin)) {
    return false;
  }

  headers.set(
    "Access-Control-Allow-Origin",
    cors.allowedOrigins ? origin : "*",
  );
  if (cors.credentials) {
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  return true;
}

function withCorsHeaders(
  handler: NibbleHttpHandler,
  cors: ResolvedCors,
): NibbleHttpHandler {
  return async (req) => {
    const res = await handler(req);
    // Responses from fetch() or Response.redirect() carry immutable headers, so always copy before writing.
    const corsRes = new Response(res.body, res);
    const isAllowed = applyOriginHeaders(
      corsRes.headers,
      cors,
      req.headers.get("Origin"),
    );
    if (isAllowed && cors.exposedHeaders) {
      corsRes.headers.set("Access-Control-Expose-Headers", cors.exposedHeaders);
    }
    return corsRes;
  };
}

function isPreflight(req: Request): boolean {
  return (
    req.headers.has("Origin") &&
    req.headers.has("Access-Control-Request-Method")
  );
}

function createPreflightResponse(req: Request, cors: ResolvedCors): Response {
  const headers = new Headers();
  if (!applyOriginHeaders(headers, cors, req.headers.get("Origin"))) {
    return new Response(null, { status: 204, headers });
  }

  headers.set("Access-Control-Allow-Methods", cors.allowMethods);
  if (cors.allowedHeaders === undefined) {
    appendVary(headers, "Access-Control-Request-Headers");
  }
  const allowedHeaders =
    cors.allowedHeaders ?? req.headers.get("Access-Control-Request-Headers");
  if (allowedHeaders) {
    headers.set("Access-Control-Allow-Headers", allowedHeaders);
  }
  if (cors.maxAge !== undefined) {
    headers.set("Access-Control-Max-Age", cors.maxAge);
  }
  return new Response(null, { status: 204, headers });
}

function createOptionsHandler(
  options: NibbleHttpHandler | undefined,
  cors: ResolvedCors,
): NibbleHttpHandler {
  const fallback: NibbleHttpHandler = () =>
    new Response(null, {
      status: 204,
      headers: new Headers([["Allow", cors.allow]]),
    });
  const nonPreflight = withCorsHeaders(options ?? fallback, cors);

  return (req) =>
    isPreflight(req) ? createPreflightResponse(req, cors) : nonPreflight(req);
}

function withOriginCheck<T>(
  upgrade: NibbleWebSocketHandlers<T>["upgrade"],
  cors: ResolvedCors,
): NonNullable<NibbleWebSocketHandlers<T>["upgrade"]> {
  return (req) => {
    const origin = req.headers.get("Origin");
    if (origin !== null && !isAllowedOrigin(cors, origin)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    // engine fills in its default context when upgrade resolves to undefined
    return upgrade ? upgrade(req) : (undefined as T);
  };
}

/**
 * @example
 * ```ts
 * export default define({
 *   handlers: cors(
 *     {
 *       origin: ["https://example.com"],
 *       allowedHeaders: ["Content-Type", "Authorization"],
 *       exposedHeaders: ["X-Request-Id"],
 *       credentials: true,
 *       maxAge: 600,
 *     },
 *     {
 *       get: (req) => Response.json({ url: req.url }),
 *       wss: { onmessage: (ws, message) => { ws.send(message) } },
 *     },
 *   ),
 * });
 * ```
 */
export function cors<T = DefaultNibbleWebSocketContext>(
  options: NibbleCors,
  handlers: NibbleHandlers<T>,
): NibbleHandlers<T> {
  assertCors(options);
  const resolved = resolveCors(options, handlers as NibbleHandlers<unknown>);
  const corsHandlers: NibbleHandlers<T> = {};

  for (const method of NIBBLE_HTTP_METHODS) {
    const handler = handlers[method];
    if (handler) {
      corsHandlers[method] = withCorsHeaders(handler, resolved);
    }
  }
  if (listDefinedMethods(handlers as NibbleHandlers<unknown>).length > 0) {
    corsHandlers.options = createOptionsHandler(handlers.options, resolved);
  }

  if (handlers.wss) {
    corsHandlers.wss = resolved.allowedOrigins
      ? {
          ...handlers.wss,
          upgrade: withOriginCheck(handlers.wss.upgrade, resolved),
        }
      : handlers.wss;
  }

  return corsHandlers;
}

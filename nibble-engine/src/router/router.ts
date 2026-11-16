import { PendingRequests } from "@/utils/pending-requests";
import { decodeDelimited, encodeDelimited } from "./delimited";
import {
  ControlMessage,
  type Failure,
  ResultMessage,
  type RouteEntry,
  type Success,
} from "./pb";

export type RouterUnixListenAddress = `unix://${string}`;

type RouterCommand = NonNullable<ControlMessage["command"]>;

enum RouterProcessState {
  Idle,
  Running,
  Stopping,
  Exited,
}

const CLOSE_TIMEOUT_MS = 10000;

const toError = ({ name, message }: Failure): Error => {
  const err = new Error(message);
  err.name = name;
  return err;
};

export class RouterProcess {
  private readonly child: Bun.Subprocess<"pipe", "pipe", "inherit">;
  private readonly pending = new PendingRequests<Success>();
  private readonly exit = Promise.withResolvers<void>();
  private state = RouterProcessState.Idle;
  private pendingRoutes?: RouteEntry[];

  constructor(binaryPath: string) {
    this.child = Bun.spawn([binaryPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    this.exit.promise.catch(() => {});

    this.readResults().catch((err: Error) => this.terminate(err));
    this.child.exited.then(() => {
      this.markExited(
        this.state === RouterProcessState.Stopping
          ? undefined
          : new Error("Router process exited unexpectedly"),
      );
    });
  }

  public get exited(): Promise<void> {
    return this.exit.promise;
  }

  private async readResults() {
    for await (const frame of decodeDelimited(this.child.stdout)) {
      this.settle(ResultMessage.decode(frame));
    }
  }

  private settle({ id, outcome }: ResultMessage) {
    switch (outcome?.$case) {
      case "success":
        this.pending.resolve(id, outcome.value);
        return;
      case "failure":
        this.pending.reject(id, toError(outcome.value));
        return;
      default:
        this.pending.reject(id, new Error("Router returned an empty result"));
    }
  }

  private markExited(error?: Error) {
    if (this.state === RouterProcessState.Exited) return;
    this.state = RouterProcessState.Exited;

    this.pending.rejectAll(
      error ?? new Error("Router process exited before responding"),
    );

    if (error) {
      this.exit.reject(error);
    } else {
      this.exit.resolve();
    }
  }

  private terminate(error?: Error) {
    this.child.kill();
    this.markExited(error);
  }

  private send(command: RouterCommand): Promise<Success> {
    switch (this.state) {
      case RouterProcessState.Exited:
        return Promise.reject(new Error("Router process has exited"));
      case RouterProcessState.Stopping:
        if (command.$case !== "close") {
          return Promise.reject(new Error("Router process is stopping"));
        }
    }

    const id = Bun.randomUUIDv7();
    const result = this.pending.register(id);
    this.child.stdin.write(
      encodeDelimited(ControlMessage.encode({ id, command }).finish()),
    );
    this.child.stdin.flush();
    return result;
  }

  public start(
    listen: RouterUnixListenAddress,
    routes?: RouteEntry[],
  ): Promise<undefined>;
  public start(listen: string, routes?: RouteEntry[]): Promise<number>;
  public async start(
    listen: string,
    routes: RouteEntry[] = this.pendingRoutes ?? [],
  ): Promise<number | undefined> {
    if (this.state === RouterProcessState.Idle) {
      this.state = RouterProcessState.Running;
    }
    this.pendingRoutes = undefined;
    try {
      const { port } = await this.send({
        $case: "startup",
        value: { listen, routes },
      });
      return port;
    } catch (err) {
      this.terminate(err as Error);
      throw err;
    }
  }

  public async setRoutes(routes: RouteEntry[]): Promise<void> {
    if (this.state === RouterProcessState.Idle) {
      this.pendingRoutes = routes;
      return;
    }
    await this.send({ $case: "setRoutes", value: { routes } });
  }

  public async stop(force = false): Promise<void> {
    if (
      this.state === RouterProcessState.Stopping ||
      this.state === RouterProcessState.Exited
    ) {
      return this.exited.catch(() => {});
    }
    this.state = RouterProcessState.Stopping;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              `Router process did not respond to close in ${CLOSE_TIMEOUT_MS}ms`,
            ),
          ),
        CLOSE_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([
        this.send({ $case: "close", value: { force } }),
        timedOut,
      ]);
    } finally {
      clearTimeout(timeout);
      this.terminate();
    }
  }
}

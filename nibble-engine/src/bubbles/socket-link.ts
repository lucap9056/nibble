import { link, rename, rm } from "node:fs/promises";

const isNotFound = (err: unknown) =>
  (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const randomSuffix = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");

export class BubbleSocketLink {
  private readonly stablePath: string;
  private desired: string | undefined;
  private applied: string | undefined;
  private synced = false;
  private draining?: Promise<void>;

  constructor(stablePath: string) {
    this.stablePath = stablePath;
  }

  public get target(): string | undefined {
    return this.applied;
  }

  public point(target: string | undefined): Promise<void> {
    this.desired = target;
    if (this.draining) {
      return this.draining;
    }
    if (this.isSettled()) {
      return Promise.resolve();
    }
    this.draining = this.drain();
    return this.draining;
  }

  public release(): Promise<void> {
    return this.point(undefined);
  }

  private isSettled() {
    return this.synced && this.desired === this.applied;
  }

  private async drain(): Promise<void> {
    try {
      while (!this.isSettled()) {
        const next = this.desired;
        try {
          await this.apply(next);
        } catch (err) {
          if (this.desired === next) {
            throw err;
          }
        }
      }
    } finally {
      this.draining = undefined;
    }
  }

  private async apply(next: string | undefined) {
    if (next === undefined) {
      await this.unlinkStable();
      return;
    }

    const tmp = `${this.stablePath}.${randomSuffix()}.tmp`;
    try {
      await link(next, tmp);
      await rename(tmp, this.stablePath);
      this.applied = next;
      this.synced = true;
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      if (isNotFound(err)) {
        await this.unlinkStable();
      }
      throw err;
    }
  }

  private async unlinkStable() {
    await rm(this.stablePath, { force: true });
    this.applied = undefined;
    this.synced = true;
  }
}

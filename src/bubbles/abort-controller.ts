export class BubbleAbortController {
  public static getAbortReason = (signal: AbortSignal): Error | undefined => {
    if (signal.aborted) {
      return signal.reason.error;
    }
    return undefined;
  };

  private readonly controller = new AbortController();

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public abort(error?: Error): void {
    this.controller.abort({ error });
  }
}

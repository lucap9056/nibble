interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export class PendingRequests<T> {
  private readonly requests = new Map<string, PendingRequest<T>>();

  public register(id: string): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.requests.set(id, { resolve, reject });
    return promise;
  }

  public resolve(id: string, value: T): boolean {
    const request = this.take(id);
    request?.resolve(value);
    return request !== undefined;
  }

  public reject(id: string, error: Error): boolean {
    const request = this.take(id);
    request?.reject(error);
    return request !== undefined;
  }

  public rejectAll(error: Error) {
    for (const id of [...this.requests.keys()]) {
      this.reject(id, error);
    }
  }

  private take(id: string): PendingRequest<T> | undefined {
    const request = this.requests.get(id);
    this.requests.delete(id);
    return request;
  }
}

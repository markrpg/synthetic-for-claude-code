export class InFlightCommands<T> {
  private readonly pending = new Map<string, Promise<T>>();

  public run(id: string, action: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(id);
    if (existing) {
      return existing;
    }
    const started = Promise.resolve().then(action);
    this.pending.set(id, started);
    void started
      .finally(() => {
        if (this.pending.get(id) === started) {
          this.pending.delete(id);
        }
      })
      .catch(() => undefined);
    return started;
  }

  public clear(): void {
    this.pending.clear();
  }
}

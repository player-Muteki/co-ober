export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(timeoutMs?: number): Promise<() => void> {
    if (!timeoutMs) {
      return new Promise((resolve) => {
        this.queue.push(() => resolve(() => this.release()));
        this.dispatch();
      });
    }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const idx = this.queue.indexOf(doAcquire);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new Error('Mutex acquire timed out'));
      }, timeoutMs);
      const doAcquire = () => {
        window.clearTimeout(timer);
        resolve(() => this.release());
      };
      this.queue.push(doAcquire);
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.locked) return;
    const next = this.queue.shift();
    if (!next) return;
    this.locked = true;
    next();
  }

  release(): void {
    this.locked = false;
    this.dispatch();
  }

  async runExclusive<T>(callback: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const releaseFn = await this.acquire(timeoutMs);
    try {
      return await callback();
    } finally {
      releaseFn();
    }
  }
}

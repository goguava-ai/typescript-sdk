export class EventCounter {
  private readonly windowMs: number;
  private readonly timestamps: number[] = [];

  constructor(windowSeconds: number) {
    this.windowMs = windowSeconds * 1000;
  }

  addEvent(): void {
    this.timestamps.push(performance.now());
    this.evictOld();
  }

  count(): number {
    this.evictOld();
    return this.timestamps.length;
  }

  private evictOld(): void {
    const cutoff = performance.now() - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }
}

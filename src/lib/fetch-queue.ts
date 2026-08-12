// Tiny client-side concurrency limiter. A results page can mount 30 cards at
// once, each wanting its own /api/hotel-images call — without this they'd
// all fire simultaneously and risk tripping LiteAPI's rate limit (seen
// before with concurrent calls during the city harvest).
class Semaphore {
  private count = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}

  async acquire(): Promise<() => void> {
    if (this.count < this.max) {
      this.count++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.count++;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.count--;
    this.queue.shift()?.();
  }
}

export const hotelExtrasQueue = new Semaphore(4);

export type SavePhase = "pending" | "saving" | "saved" | "failed";

type PendingSnapshot<T> = { value: T; revision: number };

/** Serializes snapshot saves while keeping the latest unsaved snapshot after a failure. */
export class DocumentSaveSession<T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tail = Promise.resolve();
  private pending: PendingSnapshot<T> | null = null;
  private revision = 0;
  private failure: unknown = null;
  private failed = false;

  constructor(
    private readonly persist: (snapshot: T) => Promise<void>,
    private readonly onPhase: (phase: SavePhase, error?: unknown) => void
  ) {}

  schedule(snapshot: T, delay = 0) {
    this.pending = { value: snapshot, revision: ++this.revision };
    this.failed = false;
    this.failure = null;
    this.onPhase("pending");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.enqueue(); }, delay);
  }

  private enqueue() {
    const snapshot = this.pending;
    if (!snapshot) return;
    this.pending = null;
    this.tail = this.tail.then(async () => {
      this.onPhase("saving");
      try {
        await this.persist(snapshot.value);
        if (this.revision === snapshot.revision) this.onPhase("saved");
      } catch (error) {
        if (this.revision !== snapshot.revision) return;
        this.pending = snapshot;
        this.failure = error;
        this.failed = true;
        this.onPhase("failed", error);
      }
    });
  }

  async flush() {
    for (;;) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (this.pending && !this.failed) this.enqueue();
      const tail = this.tail;
      await tail;
      if (tail !== this.tail) continue;
      if (this.failed) throw this.failure;
      if (!this.pending) return;
    }
  }
}

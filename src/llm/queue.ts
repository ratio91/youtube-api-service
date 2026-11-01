/**
 * llama-server runs a single slot: every LLM-bound task (summaries, classifications)
 * goes through one shared queue so they never compete for it.
 */
export class LlmQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private count = 0;

  /** onSettle runs after every task (success or failure), e.g. to mark activity. */
  constructor(private readonly opts: { onSettle?: () => void } = {}) {}

  /** Tasks queued or running. */
  get pending(): number {
    return this.count;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.count++;
    const next = this.tail.then(task, task);
    const settle = () => {
      this.count--;
      this.opts.onSettle?.();
    };
    // Two-argument then: never creates a rejected promise of its own.
    next.then(settle, settle);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

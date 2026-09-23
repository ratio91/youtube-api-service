/**
 * llama-server runs a single slot: every LLM-bound task (summaries, classifications)
 * goes through one shared queue so they never compete for it.
 */
export class LlmQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * Bounded-concurrency batch runner for fleet_* tools.
 *
 * Every operation reports per-VM success or failure. One VM failing never aborts
 * the batch — with a fleet, a partial result is the normal case and the caller
 * needs to know exactly which members are in which state.
 */

export interface FleetOutcome<T> {
  vm: string;
  ok: boolean;
  result?: T;
  error?: string;
}

export interface FleetSummary<T> {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<FleetOutcome<T>>;
}

export async function runFleet<Item, T>(
  items: Item[],
  nameOf: (item: Item) => string,
  work: (item: Item) => Promise<T>,
  maxConcurrency: number,
): Promise<FleetSummary<T>> {
  const results: Array<FleetOutcome<T>> = new Array(items.length);
  const limit = Math.max(1, Math.min(maxConcurrency, items.length || 1));
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      try {
        results[index] = { vm: nameOf(item), ok: true, result: await work(item) };
      } catch (e) {
        results[index] = { vm: nameOf(item), ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));

  return {
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

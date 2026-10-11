/**
 * Bounded-concurrency runner for independent async steps.
 *
 * Cases that each pay for a child process are independent but serial by
 * construction; running a few at a time cuts wall-clock without dropping the
 * isolation, as long as no case writes state the others read.
 *
 * Results keep the input order, one entry per task, so a caller reports by
 * index however the pool happened to interleave.
 *
 * Not a test: lives outside test/runtime so the runner does not execute it.
 */

/**
 * Run every task with at most `limit` in flight.
 *
 * @param {Array<() => unknown | Promise<unknown>>} tasks
 * @param {number} limit
 * @returns {Promise<Array<{status: "fulfilled", value: unknown} | {status: "rejected", reason: unknown}>>}
 */
export async function runBounded(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  const width = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

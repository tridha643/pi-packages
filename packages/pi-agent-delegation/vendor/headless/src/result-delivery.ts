/** Buffer settled results by a caller-defined lifecycle key until the parent can receive them. */
export function createDeferredResultDelivery<T extends { id: string }>(
  keyOf: (result: T) => string = (result) => result.id,
) {
  const pending = new Map<string, T>();

  return {
    defer(result: T) {
      pending.set(keyOf(result), result);
    },
    consume(keys: Iterable<string>) {
      for (const key of keys) pending.delete(key);
    },
    drain() {
      const results = [...pending.values()];
      pending.clear();
      return results;
    },
    clear() {
      pending.clear();
    },
  };
}

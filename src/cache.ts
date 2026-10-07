/** Small insertion-ordered cache that drops the oldest entry past `limit`. */
export class Cache<K, V> {
  private readonly entries = new Map<K, V>()

  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    return this.entries.get(key)
  }

  set(key: K, value: V): V {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    return value
  }

  delete(key: K) {
    this.entries.delete(key)
  }

  get size() {
    return this.entries.size
  }
}

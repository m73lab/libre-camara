export class TtlCache {
  constructor() {
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.value;
  }

  set(key, value, ttlSeconds) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  eliminarDonde(predicado) {
    let eliminadas = 0;
    for (const key of this.store.keys()) {
      if (predicado(key)) {
        this.store.delete(key);
        eliminadas += 1;
      }
    }
    return eliminadas;
  }

  stats() {
    return { entries: this.store.size, hits: this.hits, misses: this.misses };
  }
}

class SimpleCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  set(key, value, ttlMs) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  getOrSet(key, ttlMs, factory) {
    const cached = this.get(key);
    if (cached !== null) return Promise.resolve(cached);
    return Promise.resolve(factory()).then((value) => this.set(key, value, ttlMs));
  }
}

module.exports = { SimpleCache };

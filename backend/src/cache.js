/** Small LRU built on Map insertion order. */
export class LruCache {
  #max;
  #map = new Map();

  constructor(max) {
    this.#max = max;
  }

  get(key) {
    const value = this.#map.get(key);
    if (value === undefined) return undefined;
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.#max === 0) return;
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.#max) {
      this.#map.delete(this.#map.keys().next().value);
    }
  }

  get size() {
    return this.#map.size;
  }
}

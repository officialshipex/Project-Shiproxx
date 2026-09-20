// Tiny in-process memo for identical upstream lookups that arrive together —
// e.g. the "Ship Now" page asks the courier the very same serviceability
// question once per service (15 identical requests for one page open).
//
// The PROMISE is stored, so concurrent callers share one in-flight request.
// Failures are never remembered (the entry is dropped so the next caller
// retries), and a result is only kept if `isCacheable(result)` says so.
const createTtlMemo = (ttlMs, maxEntries = 500) => {
  const store = new Map();

  return (key, load, isCacheable = () => true) => {
    const now = Date.now();
    const hit = store.get(key);
    // age < 0 means the system clock stepped backwards — treat as expired
    // rather than trusting the entry for the whole gap.
    if (hit && now - hit.at >= 0 && now - hit.at < ttlMs) return hit.promise;

    if (store.size >= maxEntries) {
      for (const [k, v] of store) if (now - v.at >= ttlMs || now - v.at < 0) store.delete(k);
      if (store.size >= maxEntries) store.clear();
    }

    const entry = { at: now };
    entry.promise = Promise.resolve().then(load);
    store.set(key, entry);

    const drop = () => { if (store.get(key) === entry) store.delete(key); };
    entry.promise.then((result) => {
      // A predicate that throws must never become an unhandled rejection
      // (which would take the process down) — just don't keep the entry.
      let keep = false;
      try { keep = isCacheable(result); } catch (e) { keep = false; }
      if (!keep) drop();
    }, drop);

    return entry.promise;
  };
};

module.exports = { createTtlMemo };

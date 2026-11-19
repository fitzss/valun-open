// A sliding-window rate limit, keyed (a client address, a token): the network's per-minute budgets (lib/pilot/http.mjs)
// and the A2A front door's (lib/a2a.mjs). Every request is recorded, a refused one too, so a client that keeps sending
// while it is refused stays refused. Returns a function (key, max) => ms: 0 when this request is within max for its key,
// else how long until the key takes a request again if nothing more is sent meanwhile: when enough of the requests in
// the window have left it (at least 1000 ms). That is every rate_limited answer's retry_after_ms (the local-readiness
// audit of Nov 18, MR-4: those 429s gave no wait, unlike the join caps'). Idle keys are pruned every `pruneEvery` calls.
export function slidingWindow({windowMs = 60_000, pruneEvery = 1000} = {}) {
  const hits = new Map();
  let calls = 0;
  return (key, max) => {
    const now = Date.now(), w = (hits.get(key) || []).filter(t => now - t < windowMs);
    w.push(now); hits.set(key, w);
    if (++calls % pruneEvery === 0) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= windowMs) hits.delete(k);
    // Over max: the next request is taken once at most max - 1 of these are still in the window, that is once the
    // (length - max)th oldest (times are in order) has left it.
    return w.length > max ? Math.max(1000, w[w.length - max] + windowMs - now) : 0;
  };
}

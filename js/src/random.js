// Cryptographically secure random bytes from globalThis.crypto.getRandomValues (browsers, Deno, Bun, Node >= 19).
// Node 18 has no global Web Crypto unless started with --experimental-global-webcrypto; there, and only there, the
// module loads node:crypto's webcrypto once. The specifier is computed so browser bundlers never try to resolve it.

let fallback = null;
if (typeof globalThis.crypto?.getRandomValues !== 'function' && globalThis.process?.versions?.node) {
  try {
    const specifier = ['node', 'crypto'].join(':');
    fallback = (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)).webcrypto;
  } catch {
    fallback = null;
  }
}

/** n bytes from the platform CSPRNG. Throws if the platform has none (never falls back to Math.random). */
export function randomBytes(n) {
  const c = typeof globalThis.crypto?.getRandomValues === 'function' ? globalThis.crypto : fallback;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('no cryptographically secure random source: globalThis.crypto.getRandomValues is missing');
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) c.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

// Shared offline world for the agent-tool tests (not a test file): the participants, keys, server responses, DNS table
// and clock that test/fixtures/generate_python_fixtures.py used when it recorded the Python agent. Keys are the PUBLIC
// test keys of the spec vectors (derived from their labels); the token is a test-only string.
import fs from 'node:fs';
import {Client, MemoryStore, ValunAgent, ValunError, bytesToHex, measure} from '../src/index.js';
import {fakeFetch, testKey} from './helpers.js';

export const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/agent-python.json', import.meta.url), 'utf8'));
export const PARITY = JSON.parse(fs.readFileSync(new URL('./fixtures/python-parity.json', import.meta.url), 'utf8'));
export const KEYS = Object.fromEntries(Object.entries(FIX.keys).map(([n, k]) => [n, {secret: testKey(k.label), pubkey: k.pubkey}]));
export const ID = FIX.ids;
export const T0 = FIX.t0_ms;

/** A host checker over the recorded DNS table: names not in it do not exist. */
export const fakeResolveHost = measure.hostResolver(async host => {
  if (!Object.hasOwn(FIX.dns, host)) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
  return FIX.dns[host];
});

/** The recorded scenario with this name. */
export function scenario(name) {
  const s = FIX.scenarios.find(x => x.name === name);
  if (!s) throw new Error(`no scenario ${name}`);
  return s;
}

/**
 * A ValunAgent over a fake server answering from the recorded base routes plus `routes`, with the recorded clock and the
 * same deterministic ids/nonces as the Python run (fill byte 1, 2, ... per call, as the generator's token_hex). `state`
 * is merged into the store's state first (a profile's records, pins or 0.3 record, as the scenario recorded them).
 */
export function world({routes = {}, store = 'alice', agent = {}, state = {}} = {}) {
  // routes: {"METHOD /path": {status, body}}, or a function (key, init) => route | undefined (for the base routes)
  // a route {sequence: [answer, ...]} answers its n-th request with the n-th answer (then the last), as the generator's
  const counts = {};
  const pick = (key, r) => {
    if (!r || !Array.isArray(r.sequence)) return r;
    const n = counts[key] = (counts[key] ?? -1) + 1;
    return r.sequence[Math.min(n, r.sequence.length - 1)];
  };
  const fetch = typeof routes === 'function'
    ? fakeFetch((key, init) => pick(key, routes(key, init) ?? FIX.base_routes[key]), FIX.base)
    : fakeFetch((key) => pick(key, {...FIX.base_routes, ...routes}[key]), FIX.base);
  let n = 0;
  const randomBytes = len => new Uint8Array(len).fill(++n % 256);
  const extra = JSON.parse(JSON.stringify(state ?? {}));
  const st = store === 'unenrolled'
    ? new MemoryStore({state: {server: FIX.base, ...extra}})
    : new MemoryStore({state: {server: FIX.base, participant_id: ID[store], pubkey: KEYS[store].pubkey, issued: {}, ...extra},
      secret: bytesToHex(KEYS[store].secret), token: FIX.token});
  const client = new Client({store: st, server: FIX.base, fetch, now: () => T0, randomBytes});
  const a = new ValunAgent(client, {approvals: agent.approvals ?? '', checkLinkHosts: agent.check_link_hosts ?? true,
    setupHint: agent.setup_hint ?? null, resolveHost: 'resolveHost' in agent ? agent.resolveHost : fakeResolveHost, now: () => T0,
    processConsents: agent.process_consents ?? true, consentsOnReads: agent.consents_on_reads ?? false, declareRoles: agent.declare_roles ?? null});
  return {agent: a, fetch, client, store: st};
}

const isSigKey = k => k === 'signature' || k.endsWith('_signature');

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A body without its signatures (fresh random nonces), as the generator records it: every key named signature or
 * ending in _signature is dropped, in objects at any depth, lists included; a 'signatures' map (slot -> signature)
 * keeps its slots, each with the value '<signature>'.
 */
export function unsigned(body) {
  if (Array.isArray(body)) return body.map(unsigned);
  if (body && typeof body === 'object') {
    return Object.fromEntries(Object.entries(body).filter(([k]) => !isSigKey(k)).map(([k, v]) => [k,
      k === 'signatures' && isMap(v) ? Object.fromEntries(Object.keys(v).map(slot => [slot, '<signature>'])) : unsigned(v)]));
  }
  return body ?? null;
}

/** The signatures in a body, in document order (the walk unsigned() makes; a 'signatures' map's values in order). */
export function signaturesIn(body) {
  if (Array.isArray(body)) return body.flatMap(signaturesIn);
  if (body && typeof body === 'object') {
    return Object.entries(body).flatMap(([k, v]) => {
      if (isSigKey(k) && typeof v === 'string') return [v];
      if (k === 'signatures' && isMap(v)) return Object.values(v).filter(x => typeof x === 'string');
      return signaturesIn(v);
    });
  }
  return [];
}

/** Every request: its key, its body without signatures and its X-Valun-Features header (null: none). */
export const requests = fetch => fetch.calls.map(c => ({key: c.key, body: unsigned(c.body), features: c.headers['X-Valun-Features'] ?? null}));
/** The requests that carried signatures: {key, signatures} in order (the generator records what each was made over). */
export const signedRequests = fetch => fetch.calls.map(c => ({key: c.key, signatures: signaturesIn(c.body)})).filter(c => c.signatures.length);
export const posts = fetch => fetch.calls.filter(c => !c.key.startsWith('GET '));
export const json = v => JSON.parse(JSON.stringify(v));

/** What fn() resolves to, or what it rejects with, as the generator's outcome() records it. */
export async function outcome(fn) {
  try {
    return {value: await fn()};
  } catch (e) {
    if (e instanceof ValunError) {
      const out = {raises: 'ValunError', code: e.code, message: e.message};
      if (Object.hasOwn(e.extra ?? {}, 'cause')) out.cause = e.extra.cause;
      return out;
    }
    return {raises: e?.name, message: e?.message};
  }
}

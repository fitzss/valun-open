// Shared offline world for the agent-tool tests (not a test file): the participants, keys, server responses, DNS table
// and clock that test/fixtures/generate_python_fixtures.py used when it recorded the Python agent. Keys are the PUBLIC
// test keys of the spec vectors (derived from their labels); the token is a test-only string.
import fs from 'node:fs';
import {Client, MemoryStore, ValunAgent, bytesToHex, measure} from '../src/index.js';
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
 * same deterministic ids/nonces as the Python run (fill byte 1, 2, ... per call, as the generator's token_hex).
 */
export function world({routes = {}, store = 'alice', agent = {}} = {}) {
  // routes: {"METHOD /path": {status, body}}, or a function (key, init) => route | undefined (for the base routes)
  const fetch = typeof routes === 'function'
    ? fakeFetch((key, init) => routes(key, init) ?? FIX.base_routes[key], FIX.base)
    : fakeFetch({...FIX.base_routes, ...routes}, FIX.base);
  let n = 0;
  const randomBytes = len => new Uint8Array(len).fill(++n % 256);
  const st = store === 'unenrolled'
    ? new MemoryStore({state: {server: FIX.base}})
    : new MemoryStore({state: {server: FIX.base, participant_id: ID[store], pubkey: KEYS[store].pubkey, issued: {}},
      secret: bytesToHex(KEYS[store].secret), token: FIX.token});
  const client = new Client({store: st, server: FIX.base, fetch, now: () => T0, randomBytes});
  const a = new ValunAgent(client, {approvals: agent.approvals ?? '', checkLinkHosts: agent.check_link_hosts ?? true,
    setupHint: agent.setup_hint ?? null, resolveHost: 'resolveHost' in agent ? agent.resolveHost : fakeResolveHost, now: () => T0});
  return {agent: a, fetch, client, store: st};
}

/** A request body without its signatures (fresh random nonces), as the generator records it. */
export function unsigned(body) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'signature').map(([k, v]) => [k, unsigned(v)]));
  }
  return body ?? null;
}

export const requests = fetch => fetch.calls.map(c => ({key: c.key, body: unsigned(c.body)}));
export const posts = fetch => fetch.calls.filter(c => !c.key.startsWith('GET '));
export const json = v => JSON.parse(JSON.stringify(v));

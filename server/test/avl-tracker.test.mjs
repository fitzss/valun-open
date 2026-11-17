// The twin check (fix inbox #62, step 4): lib/avl.mjs against the tracker itself, not against fixtures. A real tracker
// v4.4 (the testnet's: Valun fork commit 321f09b, binary pinned) runs a random sequence of writes: ordinary notes (a
// first one of total 0 among them), bound notes on bound-only edges, debt transfers and set-offs (which make their edges
// bound-only and can bring an edge to 0), in erg and in a token denomination, with totals above 2^53 and up to
// 2^63 - 1 (the reserve contract's Long). After every write, digest() of the live amount_collected of every note (GET
// /notes read with exact amounts, every denomination) must equal the tracker's own GET /tracker/state local_digest, and
// the tracker's notes must be exactly the totals the test's model expects (so a refused or partial write cannot pass
// unnoticed). No chain is needed: the live tree is built as the anchored one is (TR-19), and with no chain no note is
// committed, which the tracker's GET /notes shows (confirmed_total_debt null) and the committed snapshot follows.
// Two trackers: pure credit (port 3701), and the testnet's pure_credit false (port 3702; its tracker box updater finds
// no node; anchored_netting stays off, as basis/run-tracker.sh, which the image also runs, has no setting for it, and
// with no chain no edge has an on-chain total for it to govern).
// Opt-in, not part of `npm test` (scripts/run-tests.mjs leaves it out). Every test is skipped unless the tracker started
// reports capabilities, its binary is pinned (lib/pilot/pins.mjs) and its build is not one from before TR-19, whose live
// trees were built in timestamp order (fix inbox #17): a later pinned build runs the check, so a rebase that changes the
// order or the keys fails here.
// Run in Ubuntu: BASIS_RUNNER=direct VALUN_BINS=$HOME/valun-bins/v44 node --test test/avl-tracker.test.mjs
// AVL_TRACKER_SEED and AVL_TRACKER_STEPS choose the sequence (a failure names its seed and step).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {PILOT_TOKEN_ID, PILOT_DENOMINATION} from '../lib/pilot/core.mjs';
import {committedRows} from '../lib/pilot/committed.mjs';
import {TRACKER_SHA256_PINS} from '../lib/pilot/pins.mjs';
import {debtKey, digest, insertDigest} from '../lib/avl.mjs';
import {startTracker, runner, signerPath, capabilities, trackerSha256} from './tracker-harness.mjs';

const SEED = Number(process.env.AVL_TRACKER_SEED || 20261114), STEPS = Number(process.env.AVL_TRACKER_STEPS || 90);
// Tracker builds whose note tree is not built in debt-key order (before TR-19): v4.3, v4.2, v4.1, v4, v3.2, v3.1, v3.
const BEFORE_TR19 = new Set(['b84b2e780894beb980d789be22ec888ffe97d65a', '4d91c47f3c51b1a3fa1a44951e7e389243c3fe7e', '6f00d1636d5eff2122dfd2d57b3f2ad876e3a031',
  '602565e3179b1656d4cf35a292006a6899ac5c61', '43704183e1ba372e1b1788c414dfe4c8b0bc3f2a', '24675ec1c0f374f29101812caf2fc87ab48468c9', '08f889931906beff6c2b69346965f400d740aa4a']);
const MODES = [{name: 'pure credit', port: 3701, pureCredit: '1'}, {name: 'the testnet\'s mode (pure_credit false)', port: 3702, pureCredit: '0'}];
const DENOMS = ['erg', PILOT_DENOMINATION];
const MAX = (1n << 63n) - 1n, P53 = 1n << 53n;
const runs = new Map();          // mode name -> {tracker, basis: {erg, token}, keys, enabled, skipWhy}

before(async () => {
  const saved = process.env.BASIS_PURE_CREDIT;
  try {
    for (const m of MODES) {
      process.env.BASIS_PURE_CREDIT = m.pureCredit;
      const tracker = await startTracker(m.port, {servedTokenId: PILOT_TOKEN_ID});
      const caps = await capabilities(tracker.url), bin = caps ? await trackerSha256() : null;
      const enabled = !!caps && TRACKER_SHA256_PINS.includes(bin) && !BEFORE_TR19.has(caps.commit) && caps.pure_credit === (m.pureCredit === '1');
      const skipWhy = !caps ? 'this tracker reports no capabilities (a tracker before v3)' : !TRACKER_SHA256_PINS.includes(bin) ? `basis_server ${bin} is not pinned`
        : BEFORE_TR19.has(caps.commit) ? `tracker commit ${caps.commit.slice(0, 7)} builds its tree before TR-19 (not in debt-key order)`
          : !enabled ? `pure_credit is ${caps.pure_credit}, expected ${m.pureCredit === '1'}` : '';
      const runSigner = makeSignerRunner({mode: runner, signerPath});
      const basis = Object.fromEntries(DENOMS.map(d => [d, new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: d, runSigner})]));
      runs.set(m.name, {tracker, basis, caps, enabled, skipWhy, keys: enabled ? await Promise.all(Array.from({length: 5}, () => basis.erg.keygen())) : []});
    }
  } finally {
    if (saved === undefined) delete process.env.BASIS_PURE_CREDIT; else process.env.BASIS_PURE_CREDIT = saved;
  }
});
after(async () => { for (const r of runs.values()) await r.tracker.stop(); });

// mulberry32: a seeded generator, so a failing sequence can be run again.
function generator(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const big = (lo, hi) => lo + (BigInt(Math.floor(next() * 2 ** 32)) * (1n << 32n) + BigInt(Math.floor(next() * 2 ** 32))) % (hi - lo + 1n);
  return {next, int, big, pick: xs => xs[int(0, xs.length - 1)], shuffle: xs => { const a2 = [...xs]; for (let i = a2.length - 1; i > 0; i--) { const j = int(0, i); [a2[i], a2[j]] = [a2[j], a2[i]]; } return a2; }};
}

// POST with u64 amounts that may pass 2^53: BigInt values are written as JSON numbers in plain digits (the tracker's
// u64), never through a Number.
async function post(url, path, body) {
  const text = JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? `#big:${v}` : v)).replace(/"#big:(\d+)"/g, '$1');
  const r = await fetch(url + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: text, signal: AbortSignal.timeout(15000)});
  const raw = await r.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* plain text */ }
  return {status: r.status, ok: r.status >= 200 && r.status < 300 && json?.success === true, body: raw.slice(0, 600)};
}

// One sequence on one tracker. The model: edge "<denomination>|<issuer>><recipient>" -> {I, R, d, total (BigInt),
// timestamp, bound}. The clock is virtual: it starts 30 minutes back (inside the trackers' 1 h maximum age of a novation
// and of a bound note) and moves forward to the next timestamp with the residue each write needs (an ordinary note
// never ends in 995-999 ms; 997 a bound note, 998 a set-off, 999 a transfer), so every edge's timestamps increase.
async function sequence(run, seed, steps) {
  const rng = generator(seed), {tracker, basis, keys} = run, url = tracker.url;
  const edges = new Map(), seen = {notes: 0, zero_first: 0, bound: 0, transfers: 0, setoffs: 0, setoff_edges: 0, to_zero: 0, above_2_53: 0, token: 0};
  let clock = Date.now() - 30 * 60e3;
  const at = residue => {
    let t = clock + 1;
    if (residue === null) { while (t % 1000 >= 995) t++; } else t += ((residue - (t % 1000)) + 1000) % 1000;
    clock = t;
    return t;
  };
  const K = (d, I, R) => `${d}|${I}>${R}`;
  const msg = async (d, I, R, total, timestamp) => (await basis[d].noteMessage({issuer: I, recipient: R, total, timestamp})).message_hex;
  const ack = async (d, I, R, priorTotal, priorTimestamp, timestamp) => (await basis[d].priorAckMessage({issuer: I, recipient: R, priorTotal, priorTimestamp, timestamp})).message_hex;
  const sign = (k, m) => basis.erg.signHex(k.pubkey_hex, m, k.secret_hex);
  const keyOf = pub => keys.find(k => k.pubkey_hex === pub);
  const where = (step, what) => `seed ${seed}, step ${step} (${what})`;

  // After every write: the tracker's notes are the model's, and their digest is the tracker's live digest.
  async function twin(step, what) {
    const notes = await basis.erg.allNotes({exact: true}), st = await basis.erg.trackerState();
    const got = new Map(notes.map(n => [K(n.denomination, n.issuer_pubkey, n.recipient_pubkey), n.amount_collected]));
    assert.deepEqual(got, new Map([...edges].map(([k, e]) => [k, String(e.total)])), `${where(step, what)}: the tracker holds the totals the model expects`);
    const live = notes.map(n => ({issuer_pubkey: n.issuer_pubkey, recipient_pubkey: n.recipient_pubkey, denomination: n.denomination, total: n.amount_collected}));
    assert.equal(digest(live), st.local_digest, `${where(step, what)}: digest() of the live totals is the tracker's local_digest`);
    // No chain: nothing is committed, the field the committed snapshot reads says so, and no row comes of it.
    assert.ok(notes.every(n => n.confirmation && n.confirmation.confirmed_total_debt === null && n.confirmation.status === 'local_only'), where(step, 'no confirmations'));
    assert.deepEqual([committedRows(notes), st.confirmed_digest ?? null, st.confirmed_box_id ?? null], [[], null, null], where(step, 'no committed rows'));
  }

  async function note(step) {
    const d = rng.next() < 0.7 ? 'erg' : PILOT_DENOMINATION, [I, R] = rng.shuffle(keys).slice(0, 2), k = K(d, I.pubkey_hex, R.pubkey_hex), e = edges.get(k);
    const prior = e?.total ?? 0n, r = rng.next();
    const room = MAX - prior, above = P53 + rng.big(0n, 1_000_000n);
    if (room < 1n) return false;
    // a first note of 0, small amounts, amounts above 2^53, and now and then one near the contract's maximum
    const inc = !e && r < 0.12 ? 0n : r < 0.6 ? BigInt(rng.int(1, 5_000_000)) : r < 0.85 ? (above <= room ? above : 1n)
      : rng.big(1n, room > (1n << 61n) ? (1n << 61n) : room);
    const total = prior + inc;
    if (e?.bound) {
      // a bound-only edge takes a bound note: the issuer's prior acknowledgment of the edge's state, at a 997 ms timestamp
      const T = at(997);
      const body = {issuer_pubkey: I.pubkey_hex, recipient_pubkey: R.pubkey_hex, amount: total, timestamp: T, signature: await sign(I, await msg(d, I.pubkey_hex, R.pubkey_hex, total, T)),
        tracker_nft_id: tracker.nft, denomination: d, prior_signature: await sign(I, await ack(d, I.pubkey_hex, R.pubkey_hex, prior, e.timestamp, T)), prior_total: prior, prior_timestamp: e.timestamp};
      const x = await post(url, '/notes', body);
      assert.ok(x.ok, `${where(step, 'bound note')}: ${x.status} ${x.body}`);
      edges.set(k, {...e, total, timestamp: T});
      seen.bound++;
    } else {
      const T = at(null);
      const body = {issuer_pubkey: I.pubkey_hex, recipient_pubkey: R.pubkey_hex, amount: total, timestamp: T, signature: await sign(I, await msg(d, I.pubkey_hex, R.pubkey_hex, total, T)),
        tracker_nft_id: tracker.nft, denomination: d};
      const x = await post(url, '/notes', body);
      assert.ok(x.ok, `${where(step, `note ${prior} -> ${total}`)}: ${x.status} ${x.body}`);
      edges.set(k, {I: I.pubkey_hex, R: R.pubkey_hex, d, total, timestamp: T, bound: false});
      if (!e && total === 0n) seen.zero_first++;
    }
    seen.notes++;
    if (total > P53) seen.above_2_53++;
    if (d !== 'erg') seen.token++;
    return `note ${d} ${prior} -> ${total}`;
  }

  // A debt transfer A>B -a, A>C +a (tracker POST /notes/transfer, version 4): seven signatures, both new states signed by
  // the issuer, the old creditor's prior acknowledgment and its two new states, the new creditor's prior acknowledgment
  // and its new state.
  async function transfer(step) {
    const from = rng.shuffle([...edges.values()].filter(e => e.total > 0n))[0];
    if (!from) return false;
    const C = rng.shuffle(keys.filter(k => k.pubkey_hex !== from.I && k.pubkey_hex !== from.R))[0];
    const A = keyOf(from.I), B = keyOf(from.R), to = edges.get(K(from.d, from.I, C.pubkey_hex));
    const Y = to?.total ?? 0n, pY = to?.timestamp ?? 0, X = from.total, pX = from.timestamp;
    const cap = X < MAX - Y ? X : MAX - Y;
    if (cap < 1n) return false;
    const a = rng.next() < 0.25 ? cap : rng.big(1n, cap), T = at(999), d = from.d;
    const mFrom = await msg(d, A.pubkey_hex, B.pubkey_hex, X - a, T), mTo = await msg(d, A.pubkey_hex, C.pubkey_hex, Y + a, T);
    const body = {issuer_pubkey: A.pubkey_hex, from_recipient_pubkey: B.pubkey_hex, to_recipient_pubkey: C.pubkey_hex, denomination: d, amount: a, timestamp: T,
      issuer_from_signature: await sign(A, mFrom), issuer_to_signature: await sign(A, mTo),
      from_recipient_prior_signature: await sign(B, await ack(d, A.pubkey_hex, B.pubkey_hex, X, pX, T)), from_recipient_signature: await sign(B, mFrom),
      from_recipient_to_signature: await sign(B, mTo),
      to_recipient_prior_signature: await sign(C, await ack(d, A.pubkey_hex, C.pubkey_hex, Y, pY, T)), to_recipient_signature: await sign(C, mTo),
      from_prior_total: X, to_prior_total: Y, from_prior_timestamp: pX, to_prior_timestamp: pY};
    const x = await post(url, '/notes/transfer', body);
    assert.ok(x.ok, `${where(step, `transfer ${a} of ${X}`)}: ${x.status} ${x.body}`);
    edges.set(K(d, A.pubkey_hex, B.pubkey_hex), {...from, total: X - a, timestamp: T, bound: true});
    edges.set(K(d, A.pubkey_hex, C.pubkey_hex), {I: A.pubkey_hex, R: C.pubkey_hex, d, total: Y + a, timestamp: T, bound: true});
    seen.transfers++;
    if (X - a === 0n) seen.to_zero++;
    if (Y + a > P53 || X > P53) seen.above_2_53++;
    return `transfer ${d} ${a}`;
  }

  // A set-off of a simple cycle of 2 to 4 edges in one denomination (tracker POST /notes/setoff, version 3, per-edge
  // timestamps): each edge lowered by the same amount, signed by its issuer and its creditor over its new total.
  async function setoff(step) {
    for (const d of rng.shuffle(DENOMS)) {
      const out = new Map();
      for (const e of edges.values()) if (e.d === d && e.total > 0n) (out.get(e.I) ?? out.set(e.I, []).get(e.I)).push(e);
      for (const start of rng.shuffle([...out.keys()])) {
        const path = [], used = new Set([start]);
        const walk = (node, depth) => {
          for (const e of rng.shuffle(out.get(node) ?? [])) {
            if (e.R === start && path.length + 1 >= 2) { path.push(e); return true; }
            if (depth < 3 && !used.has(e.R)) { used.add(e.R); path.push(e); if (walk(e.R, depth + 1)) return true; path.pop(); used.delete(e.R); }
          }
          return false;
        };
        if (!walk(start, 0)) continue;
        const least = path.reduce((m, e) => (e.total < m ? e.total : m), path[0].total);
        const dec = rng.next() < 0.3 ? least : rng.big(1n, least);
        const signed = [];
        for (const e of path) {
          const T = at(998), m = await msg(d, e.I, e.R, e.total - dec, T);
          signed.push({e, T, wire: {issuer_pubkey: e.I, recipient_pubkey: e.R, decrease: dec, timestamp: T, issuer_signature: await sign(keyOf(e.I), m), recipient_signature: await sign(keyOf(e.R), m)}});
        }
        const x = await post(url, '/notes/setoff', {denomination: d, timestamp: Math.max(...signed.map(s => s.T)), edges: signed.map(s => s.wire)});
        assert.ok(x.ok, `${where(step, `set-off of ${path.length} edges by ${dec}`)}: ${x.status} ${x.body}`);
        for (const {e, T} of signed) {
          edges.set(K(d, e.I, e.R), {...e, total: e.total - dec, timestamp: T, bound: true});
          if (e.total - dec === 0n) seen.to_zero++;
        }
        seen.setoffs++; seen.setoff_edges += path.length;
        return `set-off ${d} ${path.length} edges by ${dec}`;
      }
    }
    return false;
  }

  await twin(0, 'the empty tracker');
  for (let step = 1; step <= steps; step++) {
    const r = rng.next();
    const what = (r < 0.5 ? await note(step) : r < 0.75 ? await transfer(step) : await setoff(step)) || await note(step);
    if (what) await twin(step, what);
  }
  // The check tells constructions apart: the same notes inserted in their timestamp order (upstream 43e2173's order,
  // the drift TR-19 fixed) give another digest than the tracker's.
  const notes = await basis.erg.allNotes({exact: true}), st = await basis.erg.trackerState();
  const u64 = t => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(t)); return b; };
  const byTime = [...notes].sort((x, y) => x.timestamp - y.timestamp).map(n => ({key: debtKey(n.issuer_pubkey, n.recipient_pubkey, n.denomination), value: u64(n.amount_collected)}));
  assert.ok(byTime.length >= 10, `${byTime.length} notes`);
  assert.notEqual(insertDigest(byTime), st.local_digest, `seed ${seed}: timestamp order is not the tracker's construction`);
  assert.equal(insertDigest([...byTime].sort((x, y) => Buffer.compare(x.key, y.key))), st.local_digest, `seed ${seed}: debt-key order is`);
  return seen;
}

for (const m of MODES) {
  test(`${m.name}: after every note, bound note, transfer and set-off, digest() of the live totals is the tracker's local_digest`, {timeout: 600_000}, async t => {
    const run = runs.get(m.name);
    if (!run.enabled) { t.skip(run.skipWhy); return; }
    const seen = await sequence(run, SEED + m.port, STEPS);
    t.diagnostic(`seed ${SEED + m.port}, ${STEPS} steps: ${JSON.stringify(seen)}`);
    // the sequence exercised what it is for
    for (const [k, least] of Object.entries({notes: 20, zero_first: 1, bound: 2, transfers: 5, setoffs: 5, to_zero: 2, above_2_53: 5, token: 3})) {
      assert.ok(seen[k] >= least, `${k}: ${seen[k]} (at least ${least}); seed ${SEED + m.port}`);
    }
  });
}

test('the debt keys of the tracker\'s notes are lib/avl.mjs\'s, in both denominations (the signer reports them)', async t => {
  const run = runs.get(MODES[0].name);
  if (!run.enabled) { t.skip(run.skipWhy); return; }
  const [I, R] = run.keys;
  for (const d of DENOMS) {
    const {debt_key_hex} = await run.basis[d].noteMessage({issuer: I.pubkey_hex, recipient: R.pubkey_hex, total: 1, timestamp: 1});
    assert.equal(Buffer.from(debtKey(I.pubkey_hex, R.pubkey_hex, d)).toString('hex'), debt_key_hex, d);
  }
});

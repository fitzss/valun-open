// An enrollment whose answer was lost (the Nov 17 tester report): a valun 0.7.1 join registered the agent's
// key, the answer that carried the agent token was lost on the way (RemoteDisconnected), and the participant was left
// with a registered key no one could sign in with: its owner had to revoke it for a new code. The client now keeps the
// key and the code before it sends them, and sends the same enrollment again (valun-open fix/join-enroll); this server
// answers it with a new agent token (enrolled_again) while the code would still be valid and the agent was never
// seen, and refuses it as before otherwise. No tracker: a stub verify stands for the signer.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Pilot, PilotStore, PILOT_DENOMINATION, statements, sha256} from '../lib/pilot/core.mjs';

const hexOf = s => Buffer.from(s, 'utf8').toString('hex');
// The stub signer: a "signature" is 02 + sha256(pubkey + message) twice (the shape the server takes), so only a caller
// that names the right statement for the key makes one; verify() checks exactly that.
const sign = (pubkey, msgHex) => '02' + sha256(pubkey + msgHex).repeat(2);
const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, note: async () => null, allNotes: async () => [],
  verify: async (pubkey, msgHex, sig) => sig === sign(pubkey, msgHex)};
const key = () => '02' + crypto.randomBytes(32).toString('hex');
const proof = (pid, pubkey, code) => sign(pubkey, hexOf(statements.enroll(pid, pubkey, sha256(code))));

function world() {
  const clock = {t: Date.parse('2026-11-17T02:37:09Z')};
  const p = new Pilot({store: new PilotStore(fs.mkdtempSync(path.join(os.tmpdir(), 'valun-enroll-retry-'))), basis,
    now: () => clock.t, log: () => {}});
  return {p, clock};
}
async function joined(p) {
  const inv = p.createInvite();
  return p.join({invite: inv.code, handle: `h-${crypto.randomBytes(3).toString('hex')}`, operator: 'Fitz'});
}
const refusal = async promise => {
  try { await promise; } catch (e) { return e; }
  assert.fail('not refused');
};

test('the same key and code, sent again after a lost answer, get a new agent token; the first one stops working', async () => {
  const {p} = world();
  const j = await joined(p), pk = key();
  const body = {participant_id: j.participant_id, code: j.enrollment_code, pubkey: pk, signature: proof(j.participant_id, pk, j.enrollment_code)};
  const first = await p.enroll(body);                  // its answer is the one lost on the way
  assert.equal(first.enrolled_again, undefined);
  const again = await p.enroll(body);
  assert.equal(again.enrolled_again, true);
  assert.equal(again.participant_id, j.participant_id);
  assert.notEqual(again.agent_token, first.agent_token);
  assert.equal(p.authenticate(first.agent_token), null, 'the token no one received signs nothing');
  assert.equal(p.authenticate(again.agent_token)?.p.id, j.participant_id);
  assert.equal(p.s.participants[j.participant_id].pubkey, pk, 'the same key');
});

test('it is refused as before once the agent was seen, after the code would have expired, or after a revoke', async () => {
  const {p, clock} = world();
  for (const end of ['seen', 'expired', 'revoked']) {
    const j = await joined(p), pk = key();
    const body = {participant_id: j.participant_id, code: j.enrollment_code, pubkey: pk, signature: proof(j.participant_id, pk, j.enrollment_code)};
    const first = await p.enroll(body);
    if (end === 'seen') p.authenticate(first.agent_token);          // the answer arrived: the agent used its token
    if (end === 'expired') clock.t += 31 * 60e3;                     // the code lasts 30 minutes
    if (end === 'revoked') await p.revokeAgent(p.s.participants[j.participant_id]);
    const e = await refusal(p.enroll(body));
    assert.equal(e.code, 'invalid_enrollment', end);
    assert.equal(e.status, 403, end);
    if (end !== 'revoked') assert.equal(p.authenticate(first.agent_token)?.p.id, j.participant_id, `${end}: the token stands`);
  }
});

test('another key, another code or a wrong proof gets nothing', async () => {
  const {p} = world();
  const j = await joined(p), pk = key();
  const first = await p.enroll({participant_id: j.participant_id, code: j.enrollment_code, pubkey: pk,
    signature: proof(j.participant_id, pk, j.enrollment_code)});
  const other = key();
  let e = await refusal(p.enroll({participant_id: j.participant_id, code: j.enrollment_code, pubkey: other,
    signature: proof(j.participant_id, other, j.enrollment_code)}));
  assert.equal(e.code, 'invalid_enrollment');
  e = await refusal(p.enroll({participant_id: j.participant_id, code: 'vpe_not-the-code', pubkey: pk,
    signature: proof(j.participant_id, pk, 'vpe_not-the-code')}));
  assert.equal(e.code, 'invalid_enrollment');
  e = await refusal(p.enroll({participant_id: j.participant_id, code: j.enrollment_code, pubkey: pk, signature: '02' + '0'.repeat(128)}));
  assert.equal(e.code, 'invalid_enrollment', 'a wrong proof: refused as before, saying nothing of the key');
  assert.equal(p.authenticate(first.agent_token)?.p.id, j.participant_id, 'nothing changed');
});

test('a key enrolled after a revoke can be sent again too, with its own code', async () => {
  const {p} = world();
  const j = await joined(p), me = p.s.participants[j.participant_id];
  const pk1 = key();
  await p.enroll({participant_id: j.participant_id, code: j.enrollment_code, pubkey: pk1, signature: proof(j.participant_id, pk1, j.enrollment_code)});
  const {enrollment_code: code} = await p.revokeAgent(me);
  const pk2 = key(), body = {participant_id: j.participant_id, code, pubkey: pk2, signature: proof(j.participant_id, pk2, code)};
  await p.enroll(body);
  const again = await p.enroll(body);
  assert.equal(again.enrolled_again, true);
  assert.equal(me.pubkey, pk2);
});

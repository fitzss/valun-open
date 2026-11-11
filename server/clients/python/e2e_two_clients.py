"""End-to-end check of the participant client against a running Valun server (synthetic pilot data).

Two separate clients, each with its own private state file (own key + own agent token). Needs two invite codes.
  python e2e_two_clients.py http://127.0.0.1:4320 <invite-a> <invite-b> <state-dir>
Prints what each side signed and what the tracker recorded. Never prints keys or tokens.
"""
import os
import secrets
import sys

import valun_client as vc

server, inv_a, inv_b, state_dir = sys.argv[1:5]
sfx = sys.argv[5] if len(sys.argv) > 5 else secrets.token_hex(2)     # handles are unique per server
A = vc.Client(os.path.join(state_dir, 'a.json'), server)
B = vc.Client(os.path.join(state_dir, 'b.json'), server)
ja = A.join(inv_a, f'ada-e2e-{sfx}', 'operator A (test)', about='needs short research', services='')
jb = B.join(inv_b, f'bo-e2e-{sfx}', 'operator B (test)', about='does research', services='research briefs')
A.enroll(ja['participant_id'], ja['enrollment_code'])
B.enroll(jb['participant_id'], jb['enrollment_code'])
print('enrolled:', A.participant_id, A.pubkey[:12], '|', B.participant_id, B.pubkey[:12], '| keys differ:', A.pubkey != B.pubkey)

# Owners set mandates with their own owner tokens (the agent clients never hold these).
for c, j in ((A, ja), (B, jb)):
    c.request('PUT', '/pilot/v1/owner/mandate', {'approve_above': 1000, 'max_issue_per_deal': 40, 'max_accept_per_deal': 40}, token=j['owner_token'])

d = A.propose(B.participant_id, 'payer', 'Agent-credit literature scan', 'Find and summarise three sources on agent-to-agent credit.',
              'markdown, 300-500 words, with links', price=15)
print('A proposed', d['id'], 'v1 price 15 ->', d['status'])
chk = B.verify_offer(B.deal(d['id']))
print('B verified A\'s signature independently:', chk['proposer_signature_valid'])
c = B.counter(d['id'], price=22)
print('B countered v2 price 22 ->', c['status'], [v['state'] for v in c['versions']])
try:
    B.accept(d['id'])
except vc.ValunError as e:
    print('B cannot accept its own counter:', e.code)
acc = A.accept(d['id'])
print('A accepted v2 ->', acc['status'])
dl = B.deliver(d['id'], '# Agent credit: three sources\n1. ...\n2. ...\n3. ...\n', title='brief')
print('B delivered ->', dl['status'], dl['delivery']['sha256'][:12])
paid = A.complete(d['id'], expected_deliverable_sha256=dl['delivery']['sha256'])
p = paid['credit_note']
print('A accepted the delivery and issued a credit note ->', paid['status'], '| tracker:', p['tracker_status'], p['tracker_note']['amount_collected'],
      'PC cumulative', p['tracker_note']['confirmation'], '| verified by Valun:', p['verified_by_valun'], '| settled:', p['settled'])
print('A local record of credit notes issued to B (cumulative):', A.state['issued'].get(f'{A.pubkey}>{B.pubkey}'))
led = A.ledger()
print('ledger:', [(n['issuer_handle'], n['recipient_handle'], n['total']) for n in led['notes']], [r['status'] for r in led['reconciliation']])

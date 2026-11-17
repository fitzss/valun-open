"""Scripted reads for both auditors (valun audit and valun-app anchor-audit.mjs), built from the client branch's own test
World (python/tests/test_audit.py: synthetic keys, notes and boxes). Writes a JSON list of scenarios {name, server,
explorer, nft, responses: {url: [[status, body], ...]}}, each url's answers given in turn, the last repeating.

Run: python -I scenarios.py <the branch's python/ folder> <out.json>"""
import copy
import json
import sys

PY, OUT = sys.argv[1], sys.argv[2]
sys.path.insert(0, PY + '/src')
sys.path.insert(0, PY + '/tests')
import test_audit as T  # noqa: E402

S, E, NFT = T.SERVER, T.EXPLORER, T.NFT
URLS = [f'{S}/pilot/v1/chain', f'{S}/pilot/v1/ledger/committed', f'{S}/pilot/v1/info', f'{S}/pilot/v1/ledger',
        f'{E}/api/v1/boxes/unspent/byTokenId/{NFT}?offset=0&limit=10', f'{E}/api/v1/networkState']


def materialize(name, w):
    responses = {}
    for u in URLS:
        if u in w.overrides:
            responses[u] = [[st, b() if callable(b) else b] for st, b in w.overrides[u]]
        else:
            st, b = w.answer(u)
            responses[u] = [[st, b]]
    # Each body as the JSON text a server writes (Python's json: integers exact), served as it is by both runners.
    return {'name': name, 'server': S, 'explorer': E, 'nft': NFT,
            'responses': {u: [[st, json.dumps(b)] for st, b in v] for u, v in responses.items()}}


out = []


def add(name, w):
    out.append(materialize(name, w))


add('match: committed snapshot', T.World())
add('match: older reads (/chain, /ledger, /chain)', T.World(committed=False, plain=True))
w = T.World(); w.published[0]['total'] += 1
add('committed: a total raised by 1 (rows give neither R5 nor the claimed digest)', w)
w = T.World(); w.published = w.published[1:]
add('committed: a dropped row', w)
w = T.World(); w.published[0]['total'] += 1
w.overrides[f'{S}/pilot/v1/ledger/committed'] = [(200, dict(w.snapshot(), digest=T.digest_of(w.published)))]
add('committed: rows give the claimed digest, not R5 (same box)', w)
w = T.World(committed=False, plain=True); w.published[0]['total'] += 1
add('older reads: rows give neither R5 nor the digest /chain names (a moved ledger, or a tamper)', w)
w = T.World(committed=False, plain=True); w.published[0]['total'] += 1
claims = dict(w.chain(), anchoring=dict(w.chain()['anchoring'], local_digest=T.digest_of(w.published), confirmed_digest=T.digest_of(w.published)))
w.overrides[f'{S}/pilot/v1/chain'] = [(200, claims)]
add('older reads: rows give the digest /chain names, not R5', w)
w = T.World(committed=False); w.anchored = [n for n in w.anchored if n['total'] < 2 ** 53]; w.published = copy.deepcopy(w.anchored)
add('older reads: the tracker holds a token note GET /ledger does not list', w)
d = T.digest_of(T.World().anchored)
for r5, what in ((f'64{d}031000', 'key length 16'), (f'64{d}03200108', 'a fixed value length 8')):
    w = T.World(); w.boxes = [w.box(r5=r5)]
    add(f'(a) R5 a tree of another construction: {what} (digest equal)', w)
    w = T.World(); w.boxes = [w.box(r5=r5)]; w.published[0]['total'] += 1
    add(f'(a) R5 a tree of another construction: {what} (digest differs)', w)
w = T.World(); w.boxes = [w.box(r5='0e20' + NFT)]
add('R5 not an AvlTree', w)
w = T.World(); w.boxes = [w.box(T.NEW_BOX_ID)]
add('box ids differ, rows give the source box R5', w)
w = T.World(); w.anchored.append(T.note(T.CAROL, T.DAVE, 1_000)); w.boxes = [w.box(T.NEW_BOX_ID)]
w.overrides[f'{S}/pilot/v1/ledger/committed'] = [(200, w.snapshot(T.anchored_notes(), T.BOX_ID))]
add('(b) box ids differ, rows give neither the source R5 nor the named box digest', w)
w = T.World(); old = copy.deepcopy(w.anchored); w.anchored.append(T.note(T.CAROL, T.DAVE, 1_000)); w.boxes = [w.box(T.NEW_BOX_ID)]
snap = w.snapshot(old, T.BOX_ID); snap['digest'] = T.digest_of(old); snap['consistent'] = True
w.overrides[f'{S}/pilot/v1/ledger/committed'] = [(200, snap)]
add('box ids differ, rows give the named box digest (a box the source does not have)', w)
w = T.World(); s = w.snapshot(); del s['construction']; w.overrides[f'{S}/pilot/v1/ledger/committed'] = [(200, s)]
add('(d) a snapshot that names no construction', w)
w = T.World(); w.overrides[f'{S}/pilot/v1/ledger/committed'] = [(200, dict(w.snapshot(), construction='basis-avl/2'))]
add('a snapshot of another construction', w)
w = T.World(); w.overrides[f'{S}/pilot/v1/ledger/committed'] = [(200, dict(w.snapshot(), network='valun-pilot-1'))]
add('(e) a snapshot of another network than /chain', w)
w = T.World(); s = w.snapshot()
for row in s['rows']:
    if row['denomination'] == 'erg':
        row['denomination'] = None
w.overrides[f'{S}/pilot/v1/ledger/committed'] = [(200, s)]
add('(f) committed rows whose denomination is null (erg notes)', w)
w = T.World(); s = w.snapshot()
for row in s['rows']:
    if row['denomination'] == 'erg':
        del row['denomination']
w.overrides[f'{S}/pilot/v1/ledger/committed'] = [(200, s)]
add('committed rows with no denomination (erg notes)', w)
for field in ('height', 'digest', 'box_id'):
    w = T.World(); s = w.snapshot(); del s[field]; w.overrides[f'{S}/pilot/v1/ledger/committed'] = [(200, s)]
    add(f'a snapshot with no {field}', w)
w = T.World(); s = w.snapshot(); s['rows'][2]['debt_key'] = 'ab' * 32; w.overrides[f'{S}/pilot/v1/ledger/committed'] = [(200, s)]
add('a committed row whose debt_key is not its own', w)
w = T.World(); w.boxes = [w.box(tokens_before=[{'tokenId': 'cc' * 32, 'index': 0, 'amount': 5}])]
add('the NFT not the first token (digest equal)', w)
w = T.World(); w.boxes = [w.box(tokens_before=[{'tokenId': 'cc' * 32, 'index': 0, 'amount': 5}])]; w.published[0]['total'] += 1
add('the NFT not the first token (digest differs)', w)
w = T.World(); w.overrides[f'{E}/api/v1/networkState'] = [(500, {})]
add('the source gives no height (MATCH otherwise)', w)
w = T.World(); w.overrides[f'{E}/api/v1/networkState'] = [(500, {})]; w.published[0]['total'] += 1
add('the source gives no height (MISMATCH otherwise)', w)
w = T.World(committed=False, plain=True); w.anchored_now = False
add('older reads: not anchored now', w)
w = T.World(committed=False, plain=True)
moved = dict(w.chain(), anchoring=dict(w.chain()['anchoring'], confirmed_box_id=T.NEW_BOX_ID))
w.overrides[f'{S}/pilot/v1/chain'] = [(200, w.chain()), (200, moved)] * 3
add('older reads: /chain moves around every ledger read', w)
w = T.World(committed=False, plain=True)
inflight = dict(w.chain(), anchoring=dict(w.chain()['anchoring'], pending_tx_id='77' * 32))
w.overrides[f'{S}/pilot/v1/chain'] = [(200, w.chain()), (200, inflight)] * 3
add('older reads: an update in flight appears between the reads (pending_tx_id)', w)
for what, boxes in (('two unspent boxes', lambda w: [w.box(), w.box(T.NEW_BOX_ID)]), ('a spent box', lambda w: [w.box(spent='aa' * 32)]),
                    ('no box', lambda w: [])):
    w = T.World(); w.boxes = boxes(w)
    add(f'the source: {what}', w)
w = T.World(); w.published = w.published + [dict(w.published[2], total=7)]
add('rows that cannot be digested (two with one debt key)', w)
w = T.World(); s = w.snapshot(); s['rows'][8]['committed_total'] = 1 << 60; w.overrides[f'{S}/pilot/v1/ledger/committed'] = [(200, s)]
add('a committed total written as a JSON number above 2^53 - 1 (exact)', w)
moving = (503, {'error': 'snapshot_moving', 'message': 'moved', 'retry_after_ms': 1200})
w = T.World(); w.overrides[f'{S}/pilot/v1/ledger/committed'] = [moving, (200, w.snapshot)]
add('503 snapshot_moving, then the snapshot', w)
w = T.World(); w.overrides[f'{S}/pilot/v1/ledger/committed'] = [(503, {'error': 'no_confirmed_box', 'retry_after_ms': 60000})]
add('503 no_confirmed_box', w)
w = T.World(); w.overrides[f'{S}/pilot/v1/chain'] = [(500, {'error': 'internal_error'})]
add('GET /chain fails', w)
w = T.World(); s = w.snapshot(); s['consistent'] = False; w.overrides[f'{S}/pilot/v1/ledger/committed'] = [(200, s)]
add('a snapshot that says consistent: false and gives R5', w)

with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f)
print(len(out), 'scenarios')

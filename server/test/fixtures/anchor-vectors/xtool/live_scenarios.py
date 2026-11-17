"""Scenarios from the three live anchors' recorded reads (valun-app anchor-auditor test/fixtures/anchor-vectors/
<height>.responses.json: GET /chain before and after GET /ledger, the ledger, the explorer's unspent box), in the format
run_client.py and run_server_tool.mjs read. The server: https://valun.test (the 401 of a route it does not have for
/ledger/committed); GET /info and the explorer's networkState, which were not recorded, are made up (erg; height + 120).
Each anchor as recorded, and with one published total raised by 1 (a tamper of GET /ledger).

Run: python -I live_scenarios.py <the anchor-vectors folder> <out.json>"""
import copy
import json
import sys

VEC, OUT = sys.argv[1], sys.argv[2]
S, E = 'https://valun.test', 'https://explorer.test'
out = []
for h in (644995, 645135, 645189):
    v = json.load(open(f'{VEC}/{h}.responses.json', encoding='utf-8'))
    nft = v['chain'][0]['tracker_nft_id']
    for tamper in (False, True):
        ledger = copy.deepcopy(v['ledger'])
        if tamper:
            ledger['notes'][0]['total'] += 1
        responses = {
            f'{S}/pilot/v1/chain': [[200, c] for c in v['chain']],
            f'{S}/pilot/v1/ledger/committed': [[401, {'error': 'unauthorized', 'message': 'missing or invalid token'}]],
            f'{S}/pilot/v1/info': [[200, {'network': 'valun-testnet-1', 'unit': 'nanoERG', 'denomination': 'erg', 'tracker_nft_id': nft}]],
            f'{S}/pilot/v1/ledger': [[200, ledger]],
            f'{E}/api/v1/boxes/unspent/byTokenId/{nft}?offset=0&limit=10': [[200, v['explorer_unspent_by_token']]],
            f'{E}/api/v1/networkState': [[200, {'height': h + 120}]],
        }
        out.append({'name': f'live {h}' + (': GET /ledger with one total raised by 1' if tamper else ', as recorded'),
                    'server': S, 'explorer': E, 'nft': nft,
                    'responses': {u: [[st, json.dumps(b)] for st, b in xs] for u, xs in responses.items()}})
json.dump(out, open(OUT, 'w', encoding='utf-8'))
print(len(out), 'scenarios')

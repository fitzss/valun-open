"""Runs the client's valun.audit.audit (valun-open python/src/valun/audit.py) on scripted reads: a list of scenarios as
scenarios.py writes them, or the packed file pack.mjs writes (../xtool.json, the recorded reads both auditors are
tested on; fix inbox #66). Each url's answers are given in turn, the last repeating; any other url is a 404. Prints one
JSON line per scenario: {name, verdict, exit, reason}, and with the packed file, whose scenarios carry the exit code
both auditors must give (the verdict table of docs/PILOT-API.md, "Verdicts"), a last line counting the scenarios whose
exit code differs from it, then exits 1 if any does.

Run: python -I -B run_client.py <valun-open's python/ folder> <scenarios.json | ../xtool.json>"""
import json
import sys

PY, FILE = sys.argv[1], sys.argv[2]
sys.path.insert(0, PY + '/src')
from valun import audit as vaudit  # noqa: E402

doc = json.load(open(FILE, encoding='utf-8'))
if isinstance(doc, dict):                       # packed: each answer's body is an index into doc['bodies']
    scenarios = [dict(s, responses={u: [[st, doc['bodies'][i]] for st, i in v] for u, v in s['responses'].items()})
                 for s in doc['scenarios']]
else:
    scenarios = doc
differ = 0
for s in scenarios:
    queues = {u: [list(x) for x in v] for u, v in s['responses'].items()}

    def get(url, queues=queues):
        q = queues.get(url)
        status, body = (q.pop(0) if len(q) > 1 else q[0]) if q else (404, {'error': 'not_found'})
        body = json.loads(body) if isinstance(body, str) else body
        if status >= 400:
            b = body if isinstance(body, dict) else {}
            raise vaudit.ReadError(url, f"HTTP {status} {b.get('error', '')}".strip(), status, b.get('error'), b)
        return body
    try:
        # valun 0.7.1 pins the tracker NFT (fix inbox #66 item 1): pass the scenario's, as run_server_tool.mjs passes
        # trackerNft, so an unknown server is not refused for want of a reserve naming it.
        r = vaudit.audit(s['server'], vaudit.Explorer(s['explorer'], get=get), get=get, sleep=lambda _s: None,
                         tracker_nft=s['nft'])
        out = {'verdict': r['verdict'], 'exit': vaudit.exit_code(r), 'reason': r['reason']}
    except Exception as e:  # noqa: BLE001
        out = {'verdict': 'CRASH', 'exit': None, 'reason': f'{type(e).__name__}: {e}'}
    if 'exit' in s and out['exit'] != s['exit']:
        differ += 1
    print(json.dumps({'name': s['name'], **out}))
if isinstance(doc, dict):
    print(json.dumps({'scenarios': len(scenarios), 'exit_differs_from_the_table': differ}))
    sys.exit(1 if differ else 0)

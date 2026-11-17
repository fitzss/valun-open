"""Side by side: the client's verdicts and exit codes against anchor-audit.mjs's on the same scripted reads.
Run: python -I compare.py <client.jsonl> <server.jsonl>
Each row: '  ' the same exit code; '~~' the same category but another code (nothing compared: the client's 3 before
the fix, the server tool's 2); 'UK' the client compares nothing (UNKNOWN) where the server tool says MISMATCH;
'<>' any other difference (a pass against anything else, or the client accusing where the server tool does not)."""
import json
import sys

c = [json.loads(x) for x in open(sys.argv[1], encoding='utf-8') if x.strip()]
s = [json.loads(x) for x in open(sys.argv[2], encoding='utf-8') if x.strip()]
assert [x['name'] for x in c] == [x['name'] for x in s]
cat = lambda e: {0: 'pass', 1: 'MISMATCH'}.get(e, 'nothing')  # noqa: E731
counts = {}
for a, b in zip(c, s):
    if a['exit'] == b['exit']:
        flag = '  '
    elif cat(a['exit']) == cat(b['exit']):
        flag = '~~'
    elif cat(a['exit']) == 'nothing' and cat(b['exit']) == 'MISMATCH':
        flag = 'UK'
    else:
        flag = '<>'
    counts[flag] = counts.get(flag, 0) + 1
    print(f"{flag} {a['name'][:84]:<84} client {a['verdict']:<8} {a['exit']!s:<2} {str(a['reason'])[:24]:<24} | "
          f"server {b['verdict']:<12} {b['exit']}")
    if flag in ('UK', '<>'):
        print(f"       server: {b['reason'][:220]}")
print(f"{len(c)} scenarios: " + ', '.join(f'{k!r} {v}' for k, v in sorted(counts.items())))

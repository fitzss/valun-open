"""Operator CLI for the Valun pilot (framework-neutral). The agent's key and token live in the state file; this CLI
never prints them. The owner token printed by `join` is for the human operator only.

  python valun_cli.py --state <file> --server https://valun-desk.fly.dev join --invite vpi_... --handle ana --operator "Ana Doe"
  python valun_cli.py --state <file> enroll --participant vp_... --code vpe_...
  python valun_cli.py --state <file> status | inbox | deals | directory | ledger
"""
import argparse
import json
import sys

import valun_client as vc


def main(argv=None):
    ap = argparse.ArgumentParser(prog='valun')
    ap.add_argument('--state', required=True, help='private state file for this agent (key + agent token)')
    ap.add_argument('--server', help='Valun server URL (stored in the state file)')
    sub = ap.add_subparsers(dest='cmd', required=True)
    j = sub.add_parser('join', help='create a participant (prints the OWNER token once: keep it, do not give it to the agent)')
    j.add_argument('--invite', required=True); j.add_argument('--handle', required=True); j.add_argument('--operator', required=True)
    j.add_argument('--name', default=''); j.add_argument('--about', default=''); j.add_argument('--services', default='')
    j.add_argument('--enroll', action='store_true', help='also enroll this state file as the agent right away')
    e = sub.add_parser('enroll', help='generate the agent key locally and register it')
    e.add_argument('--participant', required=True); e.add_argument('--code', required=True)
    for name in ('status', 'inbox', 'deals', 'directory', 'ledger'):
        sub.add_parser(name)
    a = ap.parse_args(argv)
    c = vc.Client(a.state, a.server)
    try:
        if a.cmd == 'join':
            r = c.join(a.invite, a.handle, a.operator, a.name, a.about, a.services)
            print(f"participant {r['participant_id']} ({r['handle']}) created.")
            print(f"OWNER TOKEN (for you, the human; shown once; keep it private): {r['owner_token']}")
            if a.enroll:
                c.enroll(r['participant_id'], r['enrollment_code'])
                print(f"agent enrolled: key {c.pubkey[:16]}... stored in {a.state}")
            else:
                print(f"enrollment code for your agent (expires {r['enrollment_expires_at']}): {r['enrollment_code']}")
        elif a.cmd == 'enroll':
            r = c.enroll(a.participant, a.code)
            print(f"agent enrolled for {r['participant_id']}: key {r['pubkey'][:16]}... stored in {a.state}")
        else:
            out = {'status': c.me, 'inbox': c.inbox, 'deals': c.deals, 'directory': c.directory, 'ledger': c.ledger}[a.cmd]()
            print(json.dumps(out, indent=1))
    except vc.ValunError as err:
        print(f'error ({err.code}): {err}', file=sys.stderr)
        return 1
    if a.server:
        c._save() if c.state.get('secret') else None
    return 0


if __name__ == '__main__':
    sys.exit(main())

"""INT-1 / E2E-1 (with scripts/e2e-python-client.mjs): one MCP session over stdio between the OFFICIAL MCP Python SDK client
and the real `valun mcp` server of a joined sandbox profile, against a local v16 server. No AI model: the session follows
valun_status sandbox_next_steps through the whole five-step tour (design 9.2), and answers every elicitation (approval
prompt) itself with approve=true; the text of each pay_with prompt is checked (its computed PAY line). Before each
round's calls the tracker totals are read from the server's public GET /ledger; a step counts as done when they reach its
end state of design 9.2, in order (tour_step is computed from the edges as they stand and can go back while a step is in
progress): the profile's own four edges must be design 9.2's, and with --exact-all also the two edges between the sandbox
agents (only a fresh server has those at design 9.2's values). The set-offs of steps 3 to 5 need this profile's consent:
`valun mcp` signs them before a tool that is not read-only, or from its background consent loop; a set-off applied while
the session made only read-only calls since the last round (valun_status is read-only, and the MCP server has no
consents-on-reads) was signed by that loop, and at least one must be. The session stops at the first failed pay_with
acceptance (no loop on a broken payment).

Run by the e2e script with a Python that has the `mcp` SDK (valun-open/.venv):
  python scripts/e2e-python-mcp.py --profile NAME --python PY --src VALUN_SRC --out RESULT.json --base URL --handle H
                                   [--timeout 900] [--exact-all]
VALUN_HOME (the temp profile folder) comes from the environment. Prints one JSON line per event to stdout and writes a
result JSON to --out: {ok, failures, tools, calls, elicitations, steps, loop_signed, final_status, paid_deal}. Exit 0
when ok.
"""
import argparse
import asyncio
import json
import os
import sys
import time
import urllib.request

from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client

RATE_PAUSE_S, RATE_TRIES = 15, 8
NINE = ['valun_status', 'valun_directory', 'valun_inbox', 'valun_deal', 'valun_propose', 'valun_respond', 'valun_deliver',
        'valun_review_delivery', 'valun_set_limits']
READ_ONLY = {'valun_status', 'valun_directory', 'valun_inbox', 'valun_deal'}
X, M = 'sandbox-exact', 'sandbox-mallory'
# Design 9.2: the tracker totals after each step of the tour ('<issuer>><recipient>'; S the profile; absent: 0).
TOUR = {1: {'X>S': 3}, 2: {'X>S': 1, 'X>M': 2}, 3: {'X>S': 0, 'S>X': 1, 'X>M': 2}, 4: {'M>S': 2, 'S>X': 0, 'X>M': 1},
        5: {'M>S': 0, 'M>X': 1, 'X>M': 0}}
SIX = ('S>X', 'S>M', 'X>S', 'X>M', 'M>S', 'M>X')
OWN = ('S>X', 'S>M', 'X>S', 'M>S')
TOUR_FULL = {n: {**dict.fromkeys(SIX, 0), **t} for n, t in TOUR.items()}


def ledger_totals(base, handle):
    """The six totals between the profile S, sandbox-exact X and sandbox-mallory M from GET /pilot/v1/ledger (loopback;
    no proxy)."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(base.rstrip('/') + '/pilot/v1/ledger', timeout=30) as r:
        notes = json.loads(r.read().decode('utf-8')).get('notes') or []
    name = {handle: 'S', X: 'X', M: 'M'}
    out = dict.fromkeys(SIX, 0)
    for n in notes:
        k = f"{name.get(n.get('issuer_handle'), '?')}>{name.get(n.get('recipient_handle'), '?')}"
        if k in out:
            out[k] = n.get('total')
    return out


def say(**kw):
    kw['t'] = time.strftime('%H:%M:%S')
    print(json.dumps(kw, ensure_ascii=False, default=str), flush=True)


async def session(args):
    failures, calls, elicitations = [], [], []

    def check(ok, what, detail=None):
        say(check=what, ok=bool(ok), **({'detail': detail} if not ok and detail is not None else {}))
        if not ok:
            failures.append({'what': what, 'detail': detail})
        return ok

    async def on_elicit(context, params):
        msg = params.message or ''
        elicitations.append(msg)
        say(elicitation=msg.split('\n', 1)[0][:200])
        return types.ElicitResult(action='accept', content={'approve': True})

    env = {**os.environ, 'PYTHONPATH': args.src, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1'}
    params = StdioServerParameters(command=args.python, args=['-m', 'valun', '--profile', args.profile, 'mcp'], env=env)
    result = {'ok': False, 'failures': failures, 'calls': calls, 'elicitations': elicitations, 'rate_limited_pauses': 0}
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write, elicitation_callback=on_elicit) as s:
            init = await s.initialize()
            check(init.server_info.name == 'valun', 'MCP initialize: the server is valun', init.server_info.name)
            check(init.server_info.version == '0.4.0', 'MCP initialize: valun 0.4.0', init.server_info.version)
            tools = (await s.list_tools()).tools
            names = [t.name for t in tools]
            result['tools'] = names
            check(names == NINE, 'tools/list: exactly the nine tools, in order', names)
            review = next((t for t in tools if t.name == 'valun_review_delivery'), None)
            check(review is not None and list((review.input_schema or {}).get('properties', {}))[-1:] == ['pay_with'],
                  'valun_review_delivery has pay_with as its last property', review and list((review.input_schema or {}).get('properties', {})))

            async def call(name, arguments):
                # A 429 rate_limited answer (every participant of the run shares one address) comes before the server
                # does anything: the call is made again after a pause, as an agent would, and the pause is counted.
                for attempt in range(1, RATE_TRIES + 1):
                    r = await s.call_tool(name, arguments)
                    payload = r.structured_content
                    if payload is None:
                        try:
                            payload = json.loads(r.content[0].text)
                        except Exception:  # noqa: BLE001
                            payload = {'unparsed': str(r.content)[:300]}
                    if not (r.is_error and isinstance(payload, dict) and payload.get('error') == 'rate_limited' and attempt < RATE_TRIES):
                        break
                    result['rate_limited_pauses'] += 1
                    say(call=name, note=f'rate_limited; again in {RATE_PAUSE_S} s')
                    await asyncio.sleep(RATE_PAUSE_S)
                calls.append({'tool': name, 'arguments': arguments, 'is_error': r.is_error,
                              'status': payload.get('status') if isinstance(payload, dict) else None,
                              'error': payload.get('error') if isinstance(payload, dict) else None})
                say(call=name, is_error=r.is_error, status=payload.get('status') if isinstance(payload, dict) else None,
                    error=payload.get('error') if isinstance(payload, dict) else None)
                return r, payload

            deadline = time.time() + args.timeout
            paid_deal, last_step, pay_failed = None, None, False
            steps, loop_signed = {}, []
            expected = 1                     # the next step of design 9.2 whose end state the totals must pass through
            cleared_prev, reads_only = None, False
            keys = SIX if args.exact_all else OWN
            which = 'six' if args.exact_all else "profile's four"
            while time.time() < deadline:
                r, st = await call('valun_status', {})
                if r.is_error:
                    check(False, 'valun_status answers', st)
                    break
                nxt = st.get('sandbox_next_steps') if isinstance(st, dict) else None
                if not check(isinstance(nxt, dict), 'valun_status shows sandbox_next_steps (circulation/1, sandbox_only)', st):
                    break
                step = nxt.get('tour_step')
                mv = st.get('money_view') or {}
                # tour_step is computed from the edges as they stand (it can go back while a step is in progress), so a
                # step counts as done when the totals reach its end state of design 9.2, in order. Read before this
                # round's calls: a step's end state stays until the session's next call changes it.
                totals = ledger_totals(args.base, args.handle)
                while expected <= 5 and all(totals[k] == TOUR_FULL[expected][k] for k in OWN) and (expected < 5 or step == 'done'):
                    steps[expected] = totals
                    check(all(totals[k] == TOUR_FULL[expected][k] for k in keys), f'MCP tour step {expected}: the {which} totals are design 9.2\'s',
                          {'ledger': totals, 'expected': {k: TOUR_FULL[expected][k] for k in keys}})
                    say(step_done=expected, totals=totals)
                    expected += 1
                # A set-off applied while the session made only read-only calls since the last round: only the MCP
                # server's background consent loop can have signed this profile's consent (valun_status is read-only,
                # and the MCP server has no consents-on-reads).
                cleared = mv.get('cleared_so_far_PC')
                if cleared_prev is not None and isinstance(cleared, int) and cleared > cleared_prev and reads_only:
                    loop_signed.append({'tour_step': step, 'cleared_PC': cleared - cleared_prev})
                    say(note='a set-off applied while the session made only read-only calls (the consent loop signed)', cleared_PC=cleared)
                if isinstance(cleared, int):
                    cleared_prev = cleared
                if step != last_step:
                    say(tour_step=step, goal=nxt.get('goal'), totals=totals, money_view=mv)
                    last_step = step
                if step == 'done':
                    break
                did_something = False
                for c in nxt.get('next_calls') or []:
                    name, a = c.get('tool'), c.get('arguments') or {}
                    asked_before = len(elicitations)
                    r2, out = await call(name, a)
                    did_something = True
                    if name == 'valun_review_delivery' and a.get('decision') == 'accept' and a.get('pay_with') not in (None, 'own_note'):
                        check(len(elicitations) > asked_before, 'the pay_with acceptance was asked through elicitation')
                        text = elicitations[-1] if elicitations else ''
                        check(text.startswith('Valun - PAY ') and f" PC of {a.get('pay_with')}'s debt" in text,
                              f"the pay_with={a.get('pay_with')} approval text starts with the computed PAY line", text[:300])
                        ok = check(not r2.is_error and out.get('status') == 'paid_by_transfer',
                                   'the pay_with acceptance pays the deal by transfer (paid_by_transfer)', out)
                        if not ok:
                            pay_failed = True     # stop at the first failed pay_with: never loop on a broken payment
                            break
                        paid_deal = paid_deal or out.get('deal_id')
                    elif r2.is_error:
                        say(note='a call failed; the next status decides', error=out)
                if pay_failed:
                    break
                reads_only = all(c.get('tool') in READ_ONLY for c in (nxt.get('next_calls') or []))
                await asyncio.sleep(0.5 if did_something else 3)
            result['paid_deal'], result['steps'], result['loop_signed'] = paid_deal, steps, loop_signed
            check(not pay_failed, 'no pay_with acceptance failed (the session stops at the first one)')
            check(last_step == 'done', 'the MCP session completed the five-step tour', last_step)
            check(paid_deal is not None, 'the MCP session paid a deal with pay_with=sandbox-exact')
            check(sorted(steps) == [1, 2, 3, 4, 5], 'the MCP session saw every step of the tour done', sorted(steps))
            check(len(loop_signed) >= 1, "at least one set-off applied while the session made only read-only calls "
                  "(signed by the consent loop of valun mcp)", loop_signed)
            r, st = await call('valun_status', {})
            result['final_status'] = {k: st.get(k) for k in ('money_view', 'notes_you_can_spend', 'payments_in_progress', 'clearing',
                                                            'sandbox_next_steps')} if isinstance(st, dict) else st
            mv = (st or {}).get('money_view') or {}
            check((mv.get('you_hold_PC'), mv.get('you_owe_PC'), mv.get('net_PC'), mv.get('cleared_so_far_PC')) == (0, 0, 0, 2),
                  'after the MCP tour the profile holds 0, owes 0, net 0, cleared 2 PC', mv)
            if paid_deal:
                r, d = await call('valun_deal', {'deal_id': paid_deal})
                check(not r.is_error and d.get('status') == 'paid_by_transfer', 'valun_deal shows the deal paid_by_transfer', d.get('status'))
                pay = d.get('payment') if isinstance(d, dict) else None
                check(isinstance(pay, dict) and (pay.get('issuer') or {}).get('handle') == 'sandbox-exact',
                      'valun_deal payment names sandbox-exact as the issuer', pay)
    result['ok'] = not failures
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--profile', required=True)
    p.add_argument('--python', required=True)
    p.add_argument('--src', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--timeout', type=int, default=900)
    p.add_argument('--base', required=True, help='the local server (http://127.0.0.1:PORT), for GET /pilot/v1/ledger')
    p.add_argument('--handle', required=True, help="the profile's handle on that server")
    p.add_argument('--exact-all', action='store_true', help="also check the sandbox agents' two edges (a fresh server only)")
    args = p.parse_args()
    try:
        result = asyncio.run(session(args))
    except BaseException as e:  # noqa: BLE001 - an ExceptionGroup from the SDK's task group: report what is inside
        import traceback
        inner = list(getattr(e, 'exceptions', None) or [e])
        while len(inner) == 1 and getattr(inner[0], 'exceptions', None):
            inner = list(inner[0].exceptions)
        detail = '; '.join(f'{type(x).__name__}: {x}' for x in inner)
        result = {'ok': False, 'failures': [{'what': 'the MCP session ran to the end', 'detail': detail}]}
        say(error=detail, traceback=''.join(traceback.format_exception(inner[0]))[-3000:])
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=1, default=str)
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())

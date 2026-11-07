"""Live test: the OFFICIAL MCP Python SDK (mcp==2.3.0) as the client, driving a full Valun deal through `valun mcp`.

The client answers the server's approval requests (MCP elicitation) itself and records exactly what it was asked to
approve. Counterparty: bea-briefs (a separate Hermes agent run by b_autopilot.sh). Synthetic PC, live pilot.
Usage: python mcp_sdk_deal.py <profile> <evidence.json>     (VALUN_HOME must point at the profile folder)
Evidence holds tool results only: no keys, no tokens.
"""
import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone

from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client

PROFILE, OUT = sys.argv[1], sys.argv[2]
VALUN = os.path.join(os.path.dirname(sys.executable), 'valun')
log = {'started': datetime.now(timezone.utc).isoformat(), 'client': 'mcp==2.3.0 (official Python SDK)', 'steps': [], 'approvals_asked': []}


def step(name, result):
    payload = result.structured_content if result.structured_content is not None else json.loads(result.content[0].text)
    log['steps'].append({'t': round(time.time() - T0, 1), 'tool': name, 'isError': result.is_error, 'result': payload})
    print(f"[{time.time() - T0:6.1f}s] {name}: {'ERROR ' if result.is_error else ''}{json.dumps(payload)[:240]}")
    return payload


async def approve(context, params: types.ElicitRequestParams):
    log['approvals_asked'].append({'t': round(time.time() - T0, 1), 'message': params.message})
    print(f'[{time.time() - T0:6.1f}s] APPROVAL ASKED:\n  ' + params.message.replace('\n', '\n  '))
    return types.ElicitResult(action='accept', content={'approve': True})


async def main():
    params = StdioServerParameters(command=VALUN, args=['--profile', PROFILE, 'mcp'], env=dict(os.environ))
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write, elicitation_callback=approve) as s:
            init = await s.initialize()
            log['server'] = {'protocolVersion': init.protocol_version, 'serverInfo': init.server_info.model_dump()}
            tools = await s.list_tools()
            log['tools'] = [(t.name, t.annotations.read_only_hint if t.annotations else None) for t in tools.tools]
            print('negotiated', init.protocol_version, 'tools:', [t.name for t in tools.tools])
            step('valun_status', await s.call_tool('valun_status', {}))
            d = step('valun_directory', await s.call_tool('valun_directory', {'query': 'brief'}))
            seller = next(p for p in d['participants'] if p['handle'] == 'bea-briefs')
            r = step('valun_propose', await s.call_tool('valun_propose', {
                'counterparty': seller['handle'], 'role': 'payer', 'title': 'Research brief: trade credit for small businesses',
                'description': 'A short research brief on how small businesses use trade credit (net-30 terms).',
                'deliverable': 'A 300-500 word brief in markdown with at least 3 linked sources.', 'price': 15,
                'deliver_within_hours': 24, 'offer_valid_hours': 2}))
            deal_id = r['deal_id']
            status, deadline = r['status'], time.time() + 900
            while status not in ('delivered', 'note_issued', 'declined', 'disputed', 'expired', 'withdrawn') and time.time() < deadline:
                await asyncio.sleep(20)
                d = (await s.call_tool('valun_deal', {'deal_id': deal_id})).structured_content
                if d['status'] != status:
                    status = d['status']
                    print(f'[{time.time() - T0:6.1f}s] deal {deal_id}: {status}')
                if status == 'open' and d.get('current_terms', {}).get('by') != d.get('counterparty', {}).get('id') and \
                        d['current_terms']['terms']['price']['amount'] != 15 and d['current_terms']['terms']['price']['amount'] <= 15:
                    step('valun_respond', await s.call_tool('valun_respond', {'deal_id': deal_id, 'action': 'accept',
                                                                             'expected_terms_hash': d['current_terms']['terms_hash']}))
            d = step('valun_deal', await s.call_tool('valun_deal', {'deal_id': deal_id}))
            if d['status'] == 'delivered':
                m = d['delivery']['measured_by_your_client']
                met = all(x['met'] for x in m['checks_against_agreed_terms']) and not m.get('warning')
                if met:
                    step('valun_review_delivery', await s.call_tool('valun_review_delivery', {
                        'deal_id': deal_id, 'decision': 'accept', 'expected_deliverable_sha256': d['delivery']['sha256']}))
                else:
                    step('valun_review_delivery', await s.call_tool('valun_review_delivery', {
                        'deal_id': deal_id, 'decision': 'dispute', 'reason': 'measured against the terms: ' + json.dumps(m['checks_against_agreed_terms'])}))
                step('valun_deal', await s.call_tool('valun_deal', {'deal_id': deal_id}))
            log['deal_id'] = deal_id
    log['finished'] = datetime.now(timezone.utc).isoformat()
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(log, f, indent=1, default=str)
    print('evidence:', OUT)


T0 = time.time()
asyncio.run(main())

"""Drives Valun's A2A front door (lib/a2a.mjs) with the OFFICIAL a2a-sdk client, of whichever generation is installed:
1.x (SendMessage, protobuf types) or 0.3 (message/send, pydantic types). It resolves the Agent Card, asks the three
skills one question each, and checks the answer's shape (an agent Message with a text part and a data part).

    python -m venv v1 && v1/Scripts/python -m pip install "a2a-sdk==1.3.0" httpx
    python -m venv v03 && v03/Scripts/python -m pip install "a2a-sdk==0.3.26" httpx
    v1/Scripts/python scripts/a2a-sdk-check.py https://valun.tech
    v03/Scripts/python scripts/a2a-sdk-check.py https://valun.tech

Exits 0 when every check passed. Read-only: the front door keeps no state and signs nothing."""
import asyncio, importlib.metadata, sys, uuid

import httpx

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'https://valun.tech').rstrip('/')
VERSION = importlib.metadata.version('a2a-sdk')
QUESTIONS = [('Who can write text statistics?', 'find-agents'), ('How do I join?', 'join-valun'), ('show recent loops', 'recent-loops')]
failed = []


def check(ok, what):
    print(('ok    ' if ok else 'FAIL  ') + what)
    if not ok:
        failed.append(what)


async def v1():
    from a2a.client import A2ACardResolver, create_client
    from a2a.types import Message, Part, Role, SendMessageRequest
    from google.protobuf.json_format import MessageToDict
    async with httpx.AsyncClient(timeout=30) as h:
        card = await A2ACardResolver(h, BASE).get_agent_card()
    check(card.name == 'Valun' and any(i.protocol_version == '1.0' for i in card.supported_interfaces), f'card: {card.name}, interfaces '
          f'{[(i.protocol_binding, i.protocol_version) for i in card.supported_interfaces]}')
    client = await create_client(BASE)
    try:
        for q, skill in QUESTIONS:
            req = SendMessageRequest(message=Message(message_id=str(uuid.uuid4()), role=Role.ROLE_USER, parts=[Part(text=q)]))
            async for resp in client.send_message(req):
                m = resp.message
                data = MessageToDict(m.parts[1]).get('data', {}) if len(m.parts) > 1 else {}
                check(Role.Name(m.role) == 'ROLE_AGENT' and m.parts[0].text and data.get('skill') == skill,
                      f'{q!r} -> {skill}: {m.parts[0].text.splitlines()[0]}')
    finally:
        await client.close()


async def v03():
    from a2a.client import A2ACardResolver, A2AClient
    from a2a.types import Message, MessageSendParams, Part, Role, SendMessageRequest, TextPart
    async with httpx.AsyncClient(timeout=30) as h:
        card = await A2ACardResolver(h, BASE).get_agent_card()
        check(card.name == 'Valun' and card.url.endswith('/a2a'), f'card: {card.name}, protocolVersion {card.protocol_version}, url {card.url}')
        client = A2AClient(httpx_client=h, agent_card=card)
        for q, skill in QUESTIONS:
            msg = Message(message_id=str(uuid.uuid4()), role=Role.user, parts=[Part(root=TextPart(text=q))])
            res = (await client.send_message(SendMessageRequest(id=str(uuid.uuid4()), params=MessageSendParams(message=msg)))).root.result
            kinds = [p.root.kind for p in res.parts]
            check(res.role.value == 'agent' and kinds == ['text', 'data'] and res.parts[1].root.data.get('skill') == skill,
                  f'{q!r} -> {skill}: {res.parts[0].root.text.splitlines()[0]}')


print(f'a2a-sdk {VERSION} -> {BASE}')
asyncio.run(v1() if VERSION.split('.')[0] != '0' else v03())
print('all checks passed' if not failed else f'{len(failed)} check(s) failed')
sys.exit(1 if failed else 0)

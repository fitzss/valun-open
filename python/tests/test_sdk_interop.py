"""Interoperability with the OFFICIAL MCP Python SDK client (skipped when `mcp` is not installed). No network: the
server runs a fake agent, so this checks the protocol, tool listing, annotations and the elicitation approval flow
exactly as the SDK implements them, on whatever OS runs the tests."""
import asyncio
import os
import sys
import unittest

try:
    from mcp import ClientSession, StdioServerParameters, types
    from mcp.client.stdio import stdio_client
except ImportError:  # pragma: no cover
    ClientSession = None

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_mcp_server import FAKE, ORIGINAL_ORDER, SRC  # noqa: E402


@unittest.skipIf(ClientSession is None, 'official MCP SDK not installed (pip install mcp)')
class OfficialSdk(unittest.TestCase):
    def run_session(self, approve):
        asked = []

        async def on_elicit(context, params):
            asked.append(params.message)
            return types.ElicitResult(action='accept', content={'approve': approve})

        async def go():
            code = FAKE.format(src=SRC, mode='ask')
            params = StdioServerParameters(command=sys.executable, args=['-I', '-c', code])
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write, elicitation_callback=on_elicit) as s:
                    init = await s.initialize()
                    tools = (await s.list_tools()).tools
                    status = await s.call_tool('valun_status', {})
                    propose = await s.call_tool('valun_propose', {'price': 15})
                    return init, tools, status, propose

        return asyncio.run(go()) + (asked,)

    def test_handshake_tools_and_approved_commitment(self):
        init, tools, status, propose, asked = self.run_session(approve=True)
        self.assertEqual(init.server_info.name, 'valun')
        self.assertEqual(len(tools), 9)
        self.assertEqual([t.name for t in tools], ORIGINAL_ORDER)
        self.assertTrue(all(isinstance(t.title, str) and t.title.startswith('Valun: ') for t in tools))
        ann = {t.name: t.annotations for t in tools}
        self.assertTrue(ann['valun_deal'].read_only_hint)
        self.assertTrue(ann['valun_propose'].destructive_hint)
        self.assertFalse(ann['valun_set_limits'].destructive_hint)
        self.assertFalse(status.is_error)
        self.assertEqual(len(asked), 1)
        self.assertIn('NEW OFFER', asked[0])
        self.assertFalse(propose.is_error)
        self.assertEqual(propose.structured_content['called'], 'valun_propose')

    def test_declined_commitment_is_not_signed(self):
        *_, propose, asked = self.run_session(approve=False)
        self.assertEqual(len(asked), 1)
        self.assertTrue(propose.is_error)
        self.assertEqual(propose.structured_content['error'], 'owner_declined')


try:
    from mcp.client.client import Client as ModernClient
except ImportError:  # pragma: no cover
    ModernClient = None


@unittest.skipIf(ModernClient is None, 'official MCP SDK with 2026-07-28 support not installed')
class OfficialSdk20260728(unittest.TestCase):
    """The 2026-07-28 revision: server/discover, per-request _meta, approvals as input_required + retry."""

    def run_modern(self, approve, mode='2026-07-28'):
        asked = []

        async def on_elicit(context, params):
            asked.append(params.message)
            return types.ElicitResult(action='accept', content={'approve': approve})

        async def go():
            params = StdioServerParameters(command=sys.executable, args=['-I', '-c', FAKE.format(src=SRC, mode='ask')])
            async with ModernClient(params, mode=mode, elicitation_callback=on_elicit) as c:
                tools = (await c.list_tools()).tools
                status = await c.call_tool('valun_status', {})
                propose = await c.call_tool('valun_propose', {'price': 15})
                version = getattr(c, 'protocol_version', None) or getattr(getattr(c, 'session', None), 'protocol_version', None)
                return tools, status, propose, version

        return asyncio.run(go()) + (asked,)

    def test_modern_approved(self):
        tools, status, propose, version, asked = self.run_modern(approve=True)
        self.assertEqual(len(tools), 9)
        self.assertTrue(all(isinstance(t.title, str) and t.title.startswith('Valun: ') for t in tools))
        self.assertFalse(status.is_error)
        self.assertEqual(len(asked), 1)
        self.assertIn('NEW OFFER', asked[0])
        self.assertFalse(propose.is_error)
        self.assertEqual(propose.structured_content['called'], 'valun_propose')

    def test_modern_declined_is_not_signed(self):
        *_, propose, version, asked = self.run_modern(approve=False)
        self.assertEqual(len(asked), 1)
        self.assertTrue(propose.is_error)
        self.assertEqual(propose.structured_content['error'], 'owner_declined')

    def test_auto_mode_picks_the_modern_revision(self):
        tools, status, propose, version, asked = self.run_modern(approve=True, mode='auto')
        self.assertFalse(propose.is_error)
        if version is not None:
            self.assertEqual(str(version), '2026-07-28')


if __name__ == '__main__':
    unittest.main()

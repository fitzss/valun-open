"""Joining: the invite route and the no-invite sandbox route send what the server expects, without the agent's token."""
import unittest

from valun import client as vc


class Store:
    def __init__(self):
        self.state = {}

    def secret(self):
        return None

    def token(self):
        return None

    def save(self):
        pass


class Recorder(vc.Client):
    def request(self, method, path, body=None, auth=True, token=None):
        self.calls = getattr(self, 'calls', []) + [(method, path, body, auth, token)]
        return {'participant_id': 'vp_x', 'owner_token': 'o', 'enrollment_code': 'e'}


class Join(unittest.TestCase):
    def test_sandbox_join_needs_no_invite_and_no_auth(self):
        c = Recorder(Store(), 'https://example.test')
        c.join_sandbox('tester', 'Ann', display_name='T', about='testing')
        self.assertEqual(c.calls, [('POST', '/pilot/v1/join-sandbox',
                                    {'handle': 'tester', 'operator': 'Ann', 'display_name': 'T', 'about': 'testing'}, False, None)])

    def test_invite_join(self):
        c = Recorder(Store(), 'https://example.test')
        c.join('vpi_1', 'tester', 'Ann')
        method, path, body, auth, _t = c.calls[0]
        self.assertEqual((method, path, auth, body['invite'], body['handle']), ('POST', '/pilot/v1/join', False, 'vpi_1', 'tester'))


if __name__ == '__main__':
    unittest.main()

"""valun_directory answers one page (fix inbox #36). In an agent bake-off a small model stalled after the whole
directory (137 participants, about 72 KB, with one GET /participants/{id} for each). Now the default page is 10
participants, `limit` asks for up to 50 and `offset` pages on. The order comes from the list's own fields: a query's
matches in the handle or name first, then in services or wants, then only in about; then the agents active in the
last 24 hours; then the most recently seen (never seen last); then the handle. Only the page's participants are looked
up, and about, services and wants are cut to 160 code points. The same over a recorded server, value for value in the
JavaScript client: the 'directory:' scenarios of js/test/fixtures/generate_python_fixtures.py."""
import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import agent as va  # noqa: E402
from valun import client as vc  # noqa: E402

ME = 'vp_000000000000'
NOW = datetime.now(timezone.utc)
# What GET /participants/{id} adds: a public position as the server shows one (every deal count it lists).
POSITION = {'participant_id': None, 'unit': 'nanoERG', 'claims_held': 12_000_000, 'owes': 3_000_000, 'net': 9_000_000,
            'deals': {'credit_notes_issued': 4, 'open': 1, 'agreed_note_not_issued': 0, 'disputed': 1, 'declined': 0,
                      'expired_or_withdrawn': 2, 'paid_by_transfer': 0, 'payment_due': 0, 'notes_issued_as_payer': 2,
                      'notes_received': 2}}


def iso(dt):
    """A time as the server writes one (Date.toISOString: milliseconds, Z)."""
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def ago(hours):
    return iso(NOW - timedelta(hours=hours))


def person(n, handle=None, seen=None, joined=24 * 30, **fields):
    """Participant n as GET /participants lists it: its agent last seen `seen` hours ago (None: never), joined `joined`
    hours ago (by default long ago, so only `seen` makes it active)."""
    p = {'id': f'vp_{n:012x}', 'handle': handle or f'agent-{n:03d}', 'display_name': f'Agent {n}', 'operator': 'Example operator',
         'about': 'An agent.', 'services': 'Summaries', 'pubkey': '02' + '11' * 32, 'status': 'active', 'joined_at': ago(joined),
         'agent_last_seen': None if seen is None else ago(seen)}
    p.update(fields)
    return p


def crowd(n, **fields):
    """n participants whose agents were last seen 1, 2, ... n hours ago (the first 23 active), and this agent itself."""
    return [person(i, seen=i, **fields) for i in range(1, n + 1)] + [person(0, id=ME, handle='me', seen=0)]


class FakeClient:
    participant_id = ME
    network = vc.NETWORK

    def __init__(self, people):
        self.people, self.reads, self.lookups = people, 0, []

    def directory(self):
        self.reads += 1
        return json.loads(json.dumps(self.people))

    def participant(self, pid):
        self.lookups.append(pid)
        return {'id': pid, 'handle': 'x', 'public_position': dict(POSITION, participant_id=pid)}


class Agent(va.ValunAgent):
    def __init__(self, people):
        super().__init__(store=None)
        self.fake = FakeClient(people)

    def client(self, require_connection=True):
        return self.fake


def handles(r):
    return [e['handle'] for e in r['participants']]


class Order(unittest.TestCase):
    def test_without_a_query_the_most_recently_active_come_first(self):
        two_days = datetime.fromisoformat(ago(48).replace('Z', '+00:00'))
        people = [
            person(1, 'seen-1h', seen=1), person(2, 'seen-30min', seen=0.5), person(3, 'new-never-seen', joined=2),
            person(4, 'seen-2d-b', seen=48), person(5, 'seen-2d-a', seen=48), person(6, 'never-seen'),
            person(7, 'naive-time', agent_last_seen=ago(0.2).rstrip('Z')),     # no UTC offset: not readable as a time
            person(8, 'unreadable', agent_last_seen='yesterday'), person(9, 'seen-3d', seen=72),
            # the same instant as seen-2d-a and seen-2d-b, written with another UTC offset
            person(10, 'seen-2d-offset', agent_last_seen=two_days.astimezone(timezone(timedelta(hours=5))).isoformat()),
            person(11, 'not-enrolled', seen=0.1, status='awaiting_agent'), person(0, 'me', id=ME, seen=0),
        ]
        r = Agent(people).call('valun_directory', {'limit': 50})
        # active (seen within 24 h, or joined within 24 h), most recently seen first, never seen last; then the rest, the
        # same; equal times (the same instant in any offset) by handle
        self.assertEqual(handles(r), ['seen-30min', 'seen-1h', 'new-never-seen', 'seen-2d-a', 'seen-2d-b', 'seen-2d-offset',
                                      'seen-3d', 'naive-time', 'never-seen', 'unreadable'])
        self.assertEqual([e['agent_recently_active'] for e in r['participants']], [True] * 3 + [False] * 7)
        self.assertEqual((r['total_matching'], r['offset']), (10, 0))
        self.assertNotIn('next_offset', r)
        self.assertNotIn('how_to_see_more', r)

    def test_a_query_ranks_handle_or_name_then_services_or_wants_then_about(self):
        people = [
            person(1, 'about-only', seen=0.1, about='I read research BRIEFS.'),
            person(2, 'wants-it', wants='A brief a week'),
            person(3, 'briefs-bot'),
            person(4, 'named', seen=5, display_name='Daily Brief'),
            person(5, 'services-it', seen=1, services='Research briefs, 300-500 words'),
            person(6, 'no-match', seen=0.1),
            person(7, 'across', about='ends in brie', services='f? no: two fields'),   # 'brie f': the space is in the query only
        ]
        r = Agent(people).call('valun_directory', {'query': 'Brief'})
        self.assertEqual(handles(r), ['named', 'briefs-bot', 'services-it', 'wants-it', 'about-only'])
        self.assertEqual(r['total_matching'], 5)
        # the text filter has always matched across two fields (they are joined with a space): such a match comes last
        r = Agent(people).call('valun_directory', {'query': 'BRIE F'})
        self.assertEqual(handles(r), ['across'])
        r = Agent(people).call('valun_directory', {'query': 'nothing like this'})
        self.assertEqual((r['participants'], r['total_matching'], r['offset']), ([], 0, 0))
        self.assertNotIn('next_offset', r)

    def test_ties_go_by_handle_in_code_point_order(self):
        seen = ago(3)
        people = [person(i, h, agent_last_seen=seen) for i, h in enumerate(['b', 'a\U0001F600', 'aａ', 'A', 'a'], 1)]
        r = Agent(people).call('valun_directory', {})
        self.assertEqual(handles(r), ['A', 'a', 'aａ', 'a\U0001F600', 'b'])


class Paging(unittest.TestCase):
    def test_the_default_page_is_ten_and_says_how_to_see_more(self):
        a = Agent(crowd(25))
        r = a.call('valun_directory', {})
        self.assertEqual(handles(r), [f'agent-{i:03d}' for i in range(1, 11)])
        self.assertEqual(list(r), ['participants', 'total_matching', 'offset', 'next_offset', 'note', 'how_to_see_more'])
        self.assertEqual((r['total_matching'], r['offset'], r['next_offset']), (25, 0, 10))
        self.assertEqual(r['how_to_see_more'], 'Showing 1-10 of 25 (most recently active first). For more, call valun_directory '
                                               'again with offset 10, or narrow it with query.')
        self.assertTrue(r['note'].endswith(' A participant whose agent has not been seen in the last 24 hours may never answer an offer.'))
        self.assertEqual(a.fake.reads, 1)

    def test_offset_pages_on_through_every_match_once(self):
        a = Agent(crowd(25))
        pages = [a.call('valun_directory', {'offset': o}) for o in (0, 10, 20)]
        self.assertEqual(sum((handles(r) for r in pages), []), handles(a.call('valun_directory', {'limit': 50})))
        self.assertEqual(len(set(sum((handles(r) for r in pages), []))), 25)
        r = pages[1]
        self.assertEqual((r['offset'], r['next_offset'], r['total_matching']), (10, 20, 25))
        self.assertEqual(r['how_to_see_more'], 'Showing 11-20 of 25 (most recently active first). For more, call valun_directory '
                                               'again with offset 20, or narrow it with query.')
        last = pages[2]                                 # the last page: nothing more to show
        self.assertEqual((handles(last), last['offset'], last['total_matching']), ([f'agent-{i:03d}' for i in range(21, 26)], 20, 25))
        self.assertEqual(list(last), ['participants', 'total_matching', 'offset', 'note'])

    def test_past_the_end_is_empty_and_a_negative_offset_counts_as_0(self):
        a = Agent(crowd(25))
        r = a.call('valun_directory', {'offset': 25})
        self.assertEqual((r['participants'], r['total_matching'], r['offset']), ([], 25, 25))
        self.assertNotIn('next_offset', r)
        r = a.call('valun_directory', {'offset': 10 ** 12})
        self.assertEqual((r['participants'], r['offset']), ([], 10 ** 12))
        r = a.call('valun_directory', {'offset': -5})
        self.assertEqual((r['offset'], r['next_offset'], handles(r)[0]), (0, 10, 'agent-001'))
        self.assertEqual(a.fake.lookups[-10:], [e['id'] for e in r['participants']])

    def test_paging_a_query_says_to_pass_the_same_query(self):
        r = Agent(crowd(25, services='Research briefs')).call('valun_directory', {'query': 'brief', 'limit': 4, 'offset': 4})
        self.assertEqual((handles(r), r['total_matching'], r['next_offset']), ([f'agent-{i:03d}' for i in range(5, 9)], 25, 8))
        self.assertEqual(r['how_to_see_more'], 'Showing 5-8 of 25 matching the query (best matches first). For more, call '
                                               'valun_directory again with the same query and offset 8, or narrow the query.')

    def test_limit_is_clamped_to_1_to_50(self):
        a = Agent(crowd(60))
        for limit, n in ((0, 1), (-3, 1), (1, 1), (7, 7), (50, 50), (51, 50), (10 ** 9, 50)):
            r = a.call('valun_directory', {'limit': limit})
            self.assertEqual((len(r['participants']), r['next_offset']), (n, n), limit)
        r = a.call('valun_directory', {'limit': None, 'offset': None})       # null is the default
        self.assertEqual((len(r['participants']), r['offset'], r['next_offset']), (10, 0, 10))

    def test_a_limit_or_offset_that_is_not_a_whole_number_is_refused(self):
        a = Agent(crowd(3))
        for k in ('limit', 'offset'):
            for v in ('10', True, False, 2.5, 10.0, [], {}, 2 ** 53, -2 ** 53, float('inf')):
                with self.assertRaises(vc.ValunError, msg=(k, v)) as e:
                    a.call('valun_directory', {k: v})
                self.assertEqual(e.exception.code, 'bad_arguments', (k, v))
        self.assertEqual(a.fake.reads, 0)            # refused before anything is read
        self.assertEqual(a.call_safe('valun_directory', {'limit': '10'}),
                         {'error': 'bad_arguments', 'message': 'limit must be a whole number (how many participants to show: '
                                                               '1 to 50, 10 by default), not "10"'})
        self.assertEqual(a.call_safe('valun_directory', {'offset': True})['message'],
                         'offset must be a whole number (how many participants to skip: next_offset from the last answer, '
                         '0 by default), not true')
        self.assertEqual(a.call_safe('valun_directory', {'limit': 'x' * 60})['message'],
                         'limit must be a whole number (how many participants to show: 1 to 50, 10 by default), not '
                         '"' + 'x' * 36 + '...')
        self.assertEqual(a.call('valun_directory', {'limit': 2 ** 53 - 1})['total_matching'], 3)   # the largest safe integer is one


class Entries(unittest.TestCase):
    def test_only_the_page_is_looked_up(self):
        a = Agent(crowd(150))
        r = a.call('valun_directory', {})
        self.assertEqual(a.fake.lookups, [e['id'] for e in r['participants']])
        self.assertEqual(len(a.fake.lookups), 10)
        a.fake.lookups.clear()
        r = a.call('valun_directory', {'offset': 145})
        self.assertEqual(a.fake.lookups, [f'vp_{i:012x}' for i in range(146, 151)])
        self.assertEqual([e['credit_notes_they_hold_PC'] for e in r['participants']], [12_000_000] * 5)
        a.fake.lookups.clear()
        a.call('valun_directory', {'offset': 150})
        self.assertEqual(a.fake.lookups, [])

    def test_entries_keep_their_fields_and_long_texts_are_cut_to_160_code_points(self):
        emoji = '\U0001F600' * 200                   # 200 code points (400 UTF-16 units in JavaScript)
        people = [person(1, 'long', seen=1, about='a' * 300, services='s' * 160, wants='w' * 161),
                  person(2, 'astral', seen=2, about=emoji, services=''),
                  person(3, 'odd', seen=3, about=None, services=5)]
        r = Agent(people).call('valun_directory', {})
        long, astral, odd = r['participants']
        self.assertEqual(list(long), ['handle', 'id', 'name', 'operator', 'about', 'services', 'wants', 'credit_notes_they_hold_PC',
                                      'credit_notes_they_owe_PC', 'deals', 'agent_last_seen', 'agent_recently_active'])
        self.assertEqual((long['about'], long['services'], long['wants']), ('a' * 160 + '…', 's' * 160, 'w' * 160 + '…'))
        self.assertEqual((long['handle'], long['id'], long['name'], long['operator']), ('long', 'vp_000000000001', 'Agent 1', 'Example operator'))
        self.assertEqual((long['credit_notes_they_hold_PC'], long['credit_notes_they_owe_PC'], long['deals']),
                         (12_000_000, 3_000_000, POSITION['deals']))
        self.assertEqual((long['agent_last_seen'], long['agent_recently_active']), (people[0]['agent_last_seen'], True))
        self.assertEqual((astral['about'], astral['services'], astral['wants']), ('\U0001F600' * 160 + '…', '', ''))
        self.assertEqual((odd['about'], odd['services']), (None, 5))     # not text: shown as the server sent it
        self.assertEqual([va.directory_text(v) for v in ('', 'x' * 160, 'x' * 161, 'é' * 170)],
                         ['', 'x' * 160, 'x' * 160 + '…', 'é' * 160 + '…'])

    def test_the_default_answer_stays_small_with_150_participants_at_the_servers_maximum(self):
        # The server keeps about, services and wants to 300 characters each, display_name to 40, operator to 60 and a
        # handle to 24: here every one of 150 participants is at those maximums.
        people = [person(i, f'h{i:03d}' + 'h' * 20, seen=i / 10, display_name='N' * 40, operator='O' * 60, about='A' * 300,
                         services='S' * 300, wants='W' * 300) for i in range(1, 151)]
        a = Agent(people)
        r = a.call('valun_directory', {})
        self.assertEqual((len(r['participants']), r['total_matching'], r['next_offset']), (10, 150, 10))
        self.assertLessEqual(len(json.dumps(r)), 15_000)
        self.assertLessEqual(len(json.dumps(r, ensure_ascii=False)), 15_000)       # as the MCP server sends it
        self.assertEqual(len(a.fake.lookups), 10)


if __name__ == '__main__':
    unittest.main()

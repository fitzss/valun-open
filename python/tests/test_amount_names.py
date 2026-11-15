"""Fix inbox #35 (the clients' half of #32): every tool's answer gives each amount a unit-neutral name next to its
deprecated `_PC` alias, with the same value, by the rule the server's public answers follow (valun-app
lib/pilot/amount-names.mjs, whose unit test the first two cases here repeat): `<name>_PC` gets `<name>` just before it,
the `PC` of a {count, PC} tally gets `amount`, a name already present is never overwritten. ValunAgent.call() applies
it to every result, once, where every call comes in. The JavaScript client gives the same answers value for value (the
parity fixtures record every tool's result), and js/test/amount-names.test.js checks every recorded result."""
import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import agent as va  # noqa: E402
from valun import client as vc  # noqa: E402

N = va.with_unit_neutral_names
SERVER = 'http://valun.invalid'
ME, BOB = 'vp_a1a1a1a1a1a1', 'vp_b0b0b0b0b0b0'


class Rule(unittest.TestCase):
    def test_every_name_PC_gets_name_just_before_it_and_a_tallys_PC_gets_amount(self):
        repayment = {'owed_ever_PC': 6, 'settled': {'by_setoff_PC': 4, 'by_redemption_PC': 1, 'creditors': 2}, 'outstanding_PC': 1,
                     'unpaid_accepted_work': {'count': 1, 'PC': 3}}
        r = N(repayment)
        self.assertEqual(list(r), ['owed_ever', 'owed_ever_PC', 'settled', 'outstanding', 'outstanding_PC', 'unpaid_accepted_work'])
        self.assertEqual(list(r['settled'].items()), [('by_setoff', 4), ('by_setoff_PC', 4), ('by_redemption', 1), ('by_redemption_PC', 1),
                                                      ('creditors', 2)])
        self.assertEqual(list(r['unpaid_accepted_work'].items()), [('count', 1), ('amount', 3), ('PC', 3)])
        self.assertEqual(repayment['settled'], {'by_setoff_PC': 4, 'by_redemption_PC': 1, 'creditors': 2}, 'the answer given is not changed')

    def test_arrays_and_nesting_a_name_already_there_is_never_overwritten_other_values_pass_through(self):
        loops = {'unit': 'nanoERG', 'loops': [{'id': 'vs_1', 'amount_PC': 2000000, 'each_PC': None, 'cycles': [{'length': 2, 'each_PC': 1000000}]}]}
        self.assertEqual(json.dumps(N(loops)), json.dumps({'unit': 'nanoERG', 'loops': [{
            'id': 'vs_1', 'amount': 2000000, 'amount_PC': 2000000, 'each': None, 'each_PC': None,
            'cycles': [{'length': 2, 'each': 1000000, 'each_PC': 1000000}]}]}))
        self.assertEqual(N({'cleared': 'kept', 'cleared_PC': 5}), {'cleared': 'kept', 'cleared_PC': 5}, 'an existing name wins')
        self.assertEqual(N({'cleared_PC': 5, 'cleared': 'kept'}), {'cleared_PC': 5, 'cleared': 'kept'}, 'also when it comes after')
        self.assertEqual(N({'amount': 9, 'PC': 5}), {'amount': 9, 'PC': 5})
        self.assertEqual(N({'_PC': 1, 'x_PCs': 2, 'PCx': 3, 'x_pc': 4}), {'_PC': 1, 'x_PCs': 2, 'PCx': 3, 'x_pc': 4},
                         'only a <name>_PC suffix and the exact key PC')
        for v in (None, 3, 'a_PC', True, 2.5):
            self.assertEqual(N(v), v)
        self.assertEqual(N(({'a_PC': 1},)), [{'a': 1, 'a_PC': 1}], 'a tuple is an array, as in JSON')
        self.assertEqual(N({'a_PC': [{'b_PC': 1}]}), {'a': [{'b': 1, 'b_PC': 1}], 'a_PC': [{'b': 1, 'b_PC': 1}]})


class MemStore:
    def __init__(self):
        self.state = {'server': SERVER, 'participant_id': ME, 'pubkey': '02' + '11' * 32}

    def secret(self):
        return '11' * 32

    def token(self):
        return 'vpa_t'

    def save(self):
        pass

    def save_credentials(self, *_a):
        pass


class EveryToolAnswer(unittest.TestCase):
    def setUp(self):
        routes = {'GET /pilot/v1/participants': [{'id': ME, 'handle': 'alice', 'display_name': 'Alice', 'operator': 'A', 'about': '',
                                                  'services': '', 'status': 'active'},
                                                 {'id': BOB, 'handle': 'bob', 'display_name': 'Bob', 'operator': 'B', 'about': 'Briefs.',
                                                  'services': 'Briefs', 'status': 'active'}],
                  f'GET /pilot/v1/participants/{BOB}': {'id': BOB, 'public_position': {'claims_held': 40, 'owes': 9,
                                                                                       'deals': {'completed': 3, 'disputed': 1}}}}

        def request(client, method, path, body=None, auth=True, token=None):
            if f'{method} {path}' not in routes:
                raise vc.ValunError('not_found', 'no route', 404)
            return json.loads(json.dumps(routes[f'{method} {path}']))
        p = mock.patch.object(vc.Client, 'request', request)
        p.start()
        self.addCleanup(p.stop)

    def test_call_gives_every_result_the_names_once_where_every_call_comes_in(self):
        a = va.ValunAgent(MemStore(), server=SERVER, process_consents=False)
        answer = {'money_view': {'you_hold_PC': 3, 'you_owe_PC': 0}, 'notes_you_can_spend': [{'issuer': 'bob', 'amount_PC': 3}],
                  'position': {'notes_issued': {'count': 2, 'PC': 7}}}
        for name in ('valun_inbox', 'valun_set_limits'):           # a read-only tool and one that is not
            a.handlers[name] = lambda _a, answer=answer: answer
            r = a.call(name, {})
            self.assertEqual(r['money_view'], {'you_hold': 3, 'you_hold_PC': 3, 'you_owe': 0, 'you_owe_PC': 0}, name)
            self.assertEqual(r['notes_you_can_spend'], [{'issuer': 'bob', 'amount': 3, 'amount_PC': 3}])
            self.assertEqual(r['position']['notes_issued'], {'count': 2, 'amount': 7, 'PC': 7})
        self.assertEqual(answer['money_view'], {'you_hold_PC': 3, 'you_owe_PC': 0}, "the handler's answer is not changed")
        self.assertEqual(a.call_safe('valun_deal', {})['message'].split(':')[0], 'missing argument', 'an error payload is as it was')

    def test_valun_directory_names_what_each_participant_holds_and_owes(self):
        r = va.ValunAgent(MemStore(), server=SERVER).call('valun_directory', {})
        bob = r['participants'][0]
        self.assertEqual({k: bob[k] for k in bob if k.startswith('credit_notes_')},
                         {'credit_notes_they_hold': 40, 'credit_notes_they_hold_PC': 40, 'credit_notes_they_owe': 9,
                          'credit_notes_they_owe_PC': 9})
        keys = list(bob)
        self.assertEqual(keys.index('credit_notes_they_hold') + 1, keys.index('credit_notes_they_hold_PC'), 'just before its alias')


if __name__ == '__main__':
    unittest.main()

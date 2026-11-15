"""valun.receipts (fix inbox #3): a check's receipt verified from the deal records, against the reviewer's pinned key, and
bound to the delivery it checked. Real keys and real signatures; the deals are built as the server records them, and the
receipt as the check service (valun.ai_seller) writes it."""
import copy
import hashlib
import json
import unittest

from valun import basis as vb
from valun import client as vc
from valun import receipts as R
from valun.ai_seller import JOB_BLOCK

NET = 'valun-testnet-1'


def keys():
    s = vb.generate_secret()
    return s, vb.public_key(s).hex()


def sig(secret, text):
    return vb.sign(text.encode('utf-8'), secret).hex()


def deal(did, payer, payee, description, content, title='job'):
    """A delivered deal as GET /deals/{id} shows it to a party: the payer proposed, the payee accepted and delivered."""
    (ps, pk), (qs, qk) = payer, payee
    terms = {'deal_id': did, 'version': 1, 'payer': {'id': 'vp_payer0000001', 'pubkey': pk}, 'payee': {'id': 'vp_payee0000001', 'pubkey': qk},
             'service': {'title': title, 'description': description, 'deliverable': 'text'}, 'price': {'amount': 2, 'unit': 'PC'}}
    h = vc.terms_hash(terms)
    sha = hashlib.sha256(content.encode('utf-8')).hexdigest()
    return {'id': did, 'current': {'version': 1, 'by': 'vp_payer0000001', 'terms': terms, 'terms_hash': h, 'signature': sig(ps, vc.statement('propose', h))},
            'agreement': {'version': 1, 'terms_hash': h, 'proposer_signature': sig(ps, vc.statement('propose', h)), 'acceptor_signature': sig(qs, vc.statement('accept', h))},
            'delivery': {'title': 'd', 'content': content, 'sha256': sha, 'bytes': len(content.encode('utf-8')), 'signature': sig(qs, vc.statement('deliver', h, sha))}}


def receipt_content(did, description, verdict_line='Verdict: meets the terms', version=2, drop_deal_id=False):
    blocks = JOB_BLOCK.findall(description)
    text = '\n\n'.join(blocks)
    r = {'service': 'check', **({} if drop_deal_id else {'check_deal_id': did}), 'verdict': 'meets' if 'does not' not in verdict_line else 'does_not_meet',
         'checked_by': 'house-reviewer', 'model': 'claude-opus-5-5', 'checked_text_sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()}
    if version == 2:
        r.update(receipt_version=2, checked_blocks=[{'sha256': hashlib.sha256(b.encode('utf-8')).hexdigest(), 'bytes': len(b.encode('utf-8'))} for b in blocks])
    return f'{verdict_line}\n- it lists five bullets\n\n```json\n{json.dumps(r, indent=1)}\n```\n'


class World:
    def __init__(self):
        self.buyer, self.seller, self.reviewer = keys(), keys(), keys()
        self.work_content = 'The parser handles empty input.\n- a\n- b\n- c\n- d\n- e\n'
        self.work = deal('vd_work00000000001', self.buyer, self.seller, 'Summarize in five bullets:\n```\nsome text\n```', self.work_content)
        self.desc = 'Check whether the work meets the terms.\n```\nTERMS: five bullets about the parser\n```\n```\n' + self.work_content + '```'
        self.check = deal('vd_check0000000001', self.buyer, self.reviewer, self.desc, receipt_content('vd_check0000000001', self.desc), title='check')
        self.pinned = {NET: {'house-reviewer': self.reviewer[1]}}


def failed(r):
    return [c['check'] for c in r['checks'] if not c['ok']]


class TestVerifyCheck(unittest.TestCase):
    def test_a_genuine_receipt_passes_and_says_what_it_does_not_prove(self):
        w = World()
        r = R.verify_check(w.check, network=NET, pinned=w.pinned)
        self.assertEqual(failed(r), [])
        self.assertTrue(r['ok'])
        self.assertEqual(r['verdict'], 'meets')
        self.assertTrue(any('verdict is right' in x for x in r['does_not_prove']))
        self.assertTrue(any('independent of the seller' in x for x in r['does_not_prove']))

    def test_bound_to_the_work_deal_s_delivery_byte_for_byte(self):
        w = World()
        r = R.verify_check(w.check, network=NET, work_deal=w.work, pinned=w.pinned)
        self.assertEqual(failed(r), [])
        self.assertIn(R.PROVES_WORK[0], r['proves'])
        # Another delivery (one word changed) is not the one checked.
        other = deal('vd_work00000000002', w.buyer, w.seller, 'x', w.work_content.replace('empty', 'any'))
        r2 = R.verify_check(w.check, network=NET, work_deal=other, pinned=w.pinned)
        self.assertEqual(failed(r2), ["the checked text contains the work deal's delivery, byte for byte"])
        self.assertFalse(r2['ok'])
        self.assertEqual(r2['proves'], [])

    def test_a_flipped_verdict_breaks_the_reviewer_s_signature(self):
        w = World()
        t = copy.deepcopy(w.check)
        t['delivery']['content'] = t['delivery']['content'].replace('"meets"', '"does_not_meet"').replace('meets the terms', 'does not meet the terms')
        t['delivery']['sha256'] = hashlib.sha256(t['delivery']['content'].encode('utf-8')).hexdigest()
        self.assertIn('check: the seller signed this delivery', failed(R.verify_check(t, network=NET, pinned=w.pinned)))

    def test_a_receipt_moved_to_another_deal_fails(self):
        w = World()
        # The same receipt (naming vd_check...1) delivered, and signed by the reviewer, in another deal.
        moved = deal('vd_check0000000002', w.buyer, w.reviewer, w.desc, w.check['delivery']['content'], title='check')
        self.assertEqual(failed(R.verify_check(moved, network=NET, pinned=w.pinned)), ['the receipt names this deal'])

    def test_a_receipt_about_other_text_fails(self):
        w = World()
        desc = w.desc.replace('five bullets', 'three bullets')
        swapped = deal('vd_check0000000001', w.buyer, w.reviewer, desc, w.check['delivery']['content'], title='check')
        self.assertEqual(set(failed(R.verify_check(swapped, network=NET, pinned=w.pinned))),
                         {'the receipt names the text in the signed terms', "the receipt's block hashes match the signed terms"})

    def test_a_lookalike_reviewer_key_fails_the_pin(self):
        w = World()
        impostor = keys()
        fake = deal('vd_check0000000001', w.buyer, impostor, w.desc, w.check['delivery']['content'], title='check')
        self.assertEqual(failed(R.verify_check(fake, network=NET, pinned=w.pinned)), ['the seller is house-reviewer, by its pinned key'])
        # The directory listing another key than the pinned one fails too (a rotation the pin does not know).
        r2 = R.verify_check(w.check, network=NET, pinned=w.pinned, directory_key=impostor[1])
        self.assertEqual(failed(r2), ['the directory still lists the pinned key'])

    def test_terms_changed_after_signing_or_a_wrong_acceptor_signature_fail(self):
        w = World()
        t = copy.deepcopy(w.check)
        t['current']['terms']['price']['amount'] = 1
        self.assertIn('check: terms hash', failed(R.verify_check(t, network=NET, pinned=w.pinned)))
        u = copy.deepcopy(w.check)
        u['agreement']['acceptor_signature'] = u['agreement']['proposer_signature']
        self.assertEqual(failed(R.verify_check(u, network=NET, pinned=w.pinned)), ['check: the acceptor signed the terms'])

    def test_a_pre_0_5_2_receipt_without_its_deal_id_is_reported_not_passed(self):
        w = World()
        old = deal('vd_check0000000001', w.buyer, w.reviewer, w.desc, receipt_content('vd_check0000000001', w.desc, version=1, drop_deal_id=True), title='check')
        r = R.verify_check(old, network=NET, pinned=w.pinned)
        self.assertEqual(failed(r), ['the receipt names this deal'])
        self.assertIn('before valun 0.5.2', [c for c in r['checks'] if c['check'] == 'the receipt names this deal'][0]['detail'])

    def test_a_version_1_receipt_with_its_deal_id_still_passes(self):
        w = World()
        v1 = deal('vd_check0000000001', w.buyer, w.reviewer, w.desc, receipt_content('vd_check0000000001', w.desc, version=1), title='check')
        self.assertEqual(failed(R.verify_check(v1, network=NET, work_deal=w.work, pinned=w.pinned)), [])

    def test_no_pinned_key_for_the_network_fails_rather_than_trusting_the_deal(self):
        w = World()
        self.assertEqual(failed(R.verify_check(w.check, network='valun-elsewhere-1', pinned=w.pinned)), ['the seller is house-reviewer, by its pinned key'])

    def test_the_receipt_the_check_service_writes_verifies(self):
        """The real writer (AISeller.deliverable) and the verifier agree on the receipt and the checked text."""
        from valun.ai_seller import AISeller, job_text
        w = World()
        s = AISeller.__new__(AISeller)
        s.handle = 'house-reviewer'
        content = s.deliverable('check', {'content': 'Verdict: meets the terms\n- fine', 'model': 'claude-opus-5-5'},
                                job_text('check', w.desc), 'vd_check0000000003', blocks=R.checked_blocks(w.desc))
        d = deal('vd_check0000000003', w.buyer, w.reviewer, w.desc, content, title='check')
        r = R.verify_check(d, network=NET, work_deal=w.work, pinned=w.pinned)
        self.assertEqual(failed(r), [])
        self.assertEqual(r['receipt']['receipt_version'], 3)

    def test_the_shipped_pins_are_well_formed(self):
        for net, table in R.PINNED_REVIEWERS.items():
            for handle, pk in table.items():
                vb.validate_public_key(bytes.fromhex(pk))
                self.assertEqual(len(pk), 66, (net, handle))


class TestVerifyCheckCommand(unittest.TestCase):
    """`valun verify-check --file`: a saved record does not name its network, so it is read as the one network's
    (valun-testnet-1, since the pilot retired) unless --network names another."""

    def run_cli(self, w, *extra):
        import contextlib
        import io
        import os
        import tempfile
        from unittest import mock
        from valun import cli
        with tempfile.TemporaryDirectory() as d:
            check, work = os.path.join(d, 'check.json'), os.path.join(d, 'work.json')
            for path, record in ((check, w.check), (work, w.work)):
                with open(path, 'w', encoding='utf-8') as f:
                    json.dump(record, f)
            out = io.StringIO()
            with mock.patch.object(R, 'PINNED_REVIEWERS', w.pinned), contextlib.redirect_stdout(out):
                rc = cli.main(['verify-check', '--file', check, '--work-file', work, *extra])
        return rc, json.loads(out.getvalue())

    def test_a_saved_record_is_read_as_the_testnet_s_by_default(self):
        rc, r = self.run_cli(World())
        self.assertEqual((rc, r['ok'], r['network']), (0, True, NET))

    def test_network_names_another_network_and_its_pins(self):
        rc, r = self.run_cli(World(), '--network', 'valun-pilot-1')
        self.assertEqual((rc, r['ok'], r['network']), (1, False, 'valun-pilot-1'))
        self.assertIn('the seller is house-reviewer, by its pinned key', [c['check'] for c in r['checks'] if not c['ok']])


class FencedReceipts(unittest.TestCase):
    """Fix inbox #70: a receipt of version 3 names the blocks as valun.fences reads them (``` or ~~~ fences, each closed
    by the same fence). Versions 1 and 2 were written by reviewers that read ``` fences only; they are checked by that
    rule (fences.LEGACY), so the receipts already issued still verify, even where the two rules read a text differently."""
    TERMS = 'title: summary\ndescription: Summarize in one sentence:\n```\nThe fox is quick.\n```\ndeliverable: one sentence'

    def desc(self, w):
        """The terms in ~~~, since they hold a ``` block (as skill.md now says), and the work in ```."""
        return f'Check whether the work meets the terms.\nTERMS:\n~~~\n{self.TERMS}\n~~~\nWORK:\n```\n{w.work_content}```'

    def detail(self, r, check='the receipt names the text in the signed terms'):
        return next(c['detail'] for c in r['checks'] if c['check'] == check)

    def test_the_two_rules_read_such_a_check_differently(self):
        w = World()
        d = self.desc(w)
        self.assertEqual(R.checked_blocks(d), [self.TERMS, w.work_content[:-1]])
        self.assertEqual(R.checked_blocks(d, 2), ['The fox is quick.', w.work_content[:-1]], 'valun 0.7.0 read only the ``` blocks')
        self.assertEqual(R.checked_blocks(d, None), R.checked_blocks(d, 2), 'no receipt_version: version 1')
        self.assertEqual(R.checked_blocks(w.desc), R.checked_blocks(w.desc, 2), 'plain ``` blocks: the same either way')

    def test_a_saved_version_2_receipt_still_verifies(self):
        w = World()
        d = self.desc(w)
        w.check = deal('vd_check0000000005', w.buyer, w.reviewer, d, receipt_content('vd_check0000000005', d), title='check')
        r = R.verify_check(json.loads(json.dumps(w.check)), network=NET, work_deal=w.work, pinned=w.pinned)
        self.assertEqual(failed(r), [])
        self.assertEqual(self.detail(r), "2 fenced block(s) in the check deal's description, read with ``` fences only, as valun "
                                         '0.7.0 and earlier read them')
        rc, out = TestVerifyCheckCommand.run_cli(self, w)          # `valun verify-check --file`, from the saved record
        self.assertEqual((rc, out['ok'], out['verdict']), (0, True, 'meets'))

    def test_a_version_3_receipt_verifies_and_names_the_whole_terms(self):
        from valun.ai_seller import AISeller, job_text
        w = World()
        d = self.desc(w)
        s = AISeller.__new__(AISeller)
        s.handle = 'house-reviewer'
        content = s.deliverable('check', {'content': 'Verdict: meets the terms\n- fine', 'model': 'claude-opus-5-5'},
                                job_text('check', d), 'vd_check0000000006', blocks=R.checked_blocks(d))
        w.check = deal('vd_check0000000006', w.buyer, w.reviewer, d, content, title='check')
        r = R.verify_check(json.loads(json.dumps(w.check)), network=NET, work_deal=w.work, pinned=w.pinned)
        self.assertEqual(failed(r), [])
        self.assertEqual(r['receipt']['receipt_version'], 3)
        whole = f'{self.TERMS}\n\n{w.work_content[:-1]}'
        self.assertEqual(r['receipt']['checked_text_sha256'], hashlib.sha256(whole.encode('utf-8')).hexdigest())
        self.assertIn('with ``` or ~~~ fences, each closed by the same fence (valun 0.7.1 and later)', self.detail(r))
        rc, out = TestVerifyCheckCommand.run_cli(self, w)
        self.assertEqual((rc, out['ok']), (0, True))
        # Read by the old rule, the same description names other text: the receipt's version keeps the two apart.
        self.assertNotEqual(R.checked_text(d, 2), whole)

    def test_a_work_block_closed_at_the_end_of_inline_code_is_bound_byte_for_byte(self):
        """The fence glued to a last line that ends in inline code (fix inbox #2): the code's closing backtick is the
        work's, so the version 3 receipt binds the work deal's delivery byte for byte, and both rules read the same text."""
        from valun.ai_seller import AISeller, job_text
        w = World()
        work = 'Run the tests with `make test`'
        w.work = deal('vd_work00000000003', w.buyer, w.seller, 'Explain how to run the tests:\n```\nMakefile\n```', work)
        d = f'Check whether the work meets the terms.\n```\nTERMS: one sentence\n```\n```\n{work}```'
        self.assertEqual(R.checked_blocks(d), ['TERMS: one sentence', work])
        self.assertEqual(R.checked_blocks(d, 2), R.checked_blocks(d), 'valun 0.7.0 read the same blocks')
        s = AISeller.__new__(AISeller)
        s.handle = 'house-reviewer'
        content = s.deliverable('check', {'content': 'Verdict: meets the terms\n- one sentence', 'model': 'claude-opus-5-5'},
                                job_text('check', d), 'vd_check0000000008', blocks=R.checked_blocks(d))
        r = R.verify_check(deal('vd_check0000000008', w.buyer, w.reviewer, d, content, title='check'), network=NET,
                           work_deal=w.work, pinned=w.pinned)
        self.assertEqual(failed(r), [])
        self.assertEqual((r['receipt']['receipt_version'], r['verdict']), (3, 'meets'))

    def test_a_receipt_of_a_version_this_valun_does_not_know_fails(self):
        w = World()
        content = receipt_content('vd_check0000000007', w.desc).replace('"receipt_version": 2', '"receipt_version": 4')
        r = R.verify_check(deal('vd_check0000000007', w.buyer, w.reviewer, w.desc, content, title='check'), network=NET, pinned=w.pinned)
        self.assertFalse(r['ok'])
        self.assertIn('the receipt names the text in the signed terms', failed(r))
        self.assertIn('upgrade valun', self.detail(r))
        for bad in (4, 0, True, '3', 3.0, [3]):
            with self.assertRaises(ValueError):
                R.checked_blocks(w.desc, bad)


if __name__ == '__main__':
    unittest.main()

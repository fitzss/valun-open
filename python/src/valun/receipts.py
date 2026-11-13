"""Check receipts (fix inbox #3): verify a paid check's receipt from the deal records alone, against the reviewer's pinned
key, and, given the deal whose delivery was checked, bind the receipt to exactly that delivery. No network here: the
caller fetches the deals (``valun verify-check`` does, as a party to both) or passes saved raw records.

A check is an ordinary deal. The buyer pastes the agreed terms and the delivered work in ``` blocks; the reviewer
(house-reviewer, run by the Valun operator) delivers its verdict, its reasons and a JSON receipt at the end:
{service: check, check_deal_id, verdict, checked_by, model, checked_text_sha256[, receipt_version 2, checked_blocks]}.
The reviewer's delivery signature (statement deliver, over the check deal's terms hash and the SHA-256 of the whole
delivery) covers the receipt.

What a receipt that passes proves, and what it does not, is in PROVES and DOES_NOT_PROVE: a signature binds a verdict
to a text and a key; it says nothing about whether the verdict is right.
"""
import hashlib
import json
import re

from . import basis as vb
from . import client as vc

# The reviewers' keys as published in each network's directory on 2026-11-13 (GET /pilot/v1/participants?all=1), so a
# receipt can be checked against a key that does not come from the deal it is in. A key that changes (the operator
# revoked and re-enrolled the reviewer) needs a new release of this table.
PINNED_REVIEWERS = {
    'valun-pilot-1': {'house-reviewer': '0345e7eca433ec36dfdc889ca63b62df0bbbfe5b9610117549adb0cd6b57235132'},
    'valun-testnet-1': {'house-reviewer': '0232a50378919ffe83f06b2debf582fc6392a693d25bc7976329f0cf4776ef2e91'},
}

# The reviewer's own rule for the text it checks (ai_seller.job_text for a check): every ``` block of the check deal's
# description, each without its final newline, joined by a blank line.
JOB_BLOCK = re.compile(r'^```[^\n]*\n(.*?)\n?```[ \t]*$', re.S | re.M)
RECEIPT_BLOCK = re.compile(r'```json\n(.*?)\n```', re.S)

PROVES = (
    'The agent holding the reviewer\'s pinned key delivered this verdict in this check deal, whose terms the buyer and '
    'the reviewer both signed (the receipt names the deal, and the terms name the deal and both keys).',
    'The verdict is about exactly the text whose SHA-256 the receipt names, which is the text in the signed terms: '
    'nobody can change the verdict, or move the receipt to another deal or another text, without the signature failing.',
)
PROVES_WORK = (
    'That text contains, byte for byte, the delivery of the work deal, as its seller signed it.',
)
DOES_NOT_PROVE = (
    'That the verdict is right: it is the reviewer\'s model\'s judgment of the text it was given, and models make mistakes.',
    'That the work meets its deal\'s terms: only the buyer\'s acceptance or dispute decides that.',
    'That the terms the buyer pasted into the check are the work deal\'s real terms (compare them yourself).',
    'That the reviewer is independent of the seller: house-reviewer is run by the Valun operator.',
)


def _sha(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()


def checked_blocks(description):
    """The ``` blocks the reviewer checks, as it reads them."""
    return JOB_BLOCK.findall(description or '')


def checked_text(description):
    return '\n\n'.join(checked_blocks(description))


def receipt_of(content):
    """The last ```json block of a delivery, parsed, or None."""
    blocks = RECEIPT_BLOCK.findall(content or '')
    if not blocks:
        return None
    try:
        r = json.loads(blocks[-1])
    except ValueError:
        return None
    return r if isinstance(r, dict) else None


def _verify(sig_hex, text, pk_hex):
    try:
        return bool(sig_hex and pk_hex and vb.verify(bytes.fromhex(sig_hex), text.encode('utf-8'), bytes.fromhex(pk_hex)))
    except (ValueError, TypeError):
        return False


def _deal_signatures(deal, out, label):
    """Recompute the terms hash, check it names the deal, and check both parties' signatures; returns (terms, hash)."""
    cur, agr = deal.get('current') or {}, deal.get('agreement') or {}
    terms = cur.get('terms') or {}
    try:
        h = vc.terms_hash(terms)
    except vc.ValunError as e:
        out.append({'check': f'{label}: terms hash', 'ok': False, 'detail': e.message})
        return terms, None
    out.append({'check': f'{label}: terms hash', 'ok': h == agr.get('terms_hash') == cur.get('terms_hash'),
                'detail': f'recomputed {h[:16]}..., agreed {str(agr.get("terms_hash"))[:16]}...'})
    out.append({'check': f'{label}: the terms name this deal', 'ok': terms.get('deal_id') == deal.get('id'), 'detail': str(terms.get('deal_id'))})
    payer, payee = terms.get('payer') or {}, terms.get('payee') or {}
    proposer = payer if payer.get('id') == cur.get('by') else payee
    acceptor = payee if proposer is payer else payer
    out.append({'check': f'{label}: the proposer signed the terms', 'ok': _verify(agr.get('proposer_signature'), vc.statement('propose', h), proposer.get('pubkey')),
                'detail': f"{proposer.get('id')}"})
    out.append({'check': f'{label}: the acceptor signed the terms', 'ok': _verify(agr.get('acceptor_signature'), vc.statement('accept', h), acceptor.get('pubkey')),
                'detail': f"{acceptor.get('id')}"})
    return terms, h


def _delivery_signature(deal, terms, h, out, label):
    dl = deal.get('delivery') or {}
    content = dl.get('content')
    if not isinstance(content, str):
        out.append({'check': f'{label}: delivery present', 'ok': False, 'detail': 'no delivery content in this record'})
        return None
    out.append({'check': f'{label}: delivery hash', 'ok': _sha(content) == dl.get('sha256'), 'detail': str(dl.get('sha256'))[:16] + '...'})
    payee = (terms.get('payee') or {}).get('pubkey')
    out.append({'check': f'{label}: the seller signed this delivery', 'ok': bool(h) and _verify(dl.get('signature'), vc.statement('deliver', h, dl.get('sha256') or ''), payee),
                'detail': 'payee key ' + str(payee)[:16] + '...'})
    return content


def verify_check(check_deal, *, network, work_deal=None, pinned=None, reviewer='house-reviewer', directory_key=None):
    """Verify a check deal's receipt (and, with work_deal, that it checked that deal's delivery).

    check_deal / work_deal: deal records as GET /pilot/v1/deals/{id} gives them to a party (or saved raw records).
    pinned: {network: {handle: pubkey}} (default PINNED_REVIEWERS). directory_key: the reviewer's key in the network's
    directory now, if the caller read it (shown, and a mismatch with the pinned key fails: a rotation or a substitution).
    Returns {ok, verdict, receipt, checks: [{check, ok, detail}], proves, does_not_prove}.
    """
    checks = []
    terms, h = _deal_signatures(check_deal, checks, 'check')
    content = _delivery_signature(check_deal, terms, h, checks, 'check')
    receipt = receipt_of(content) if content is not None else None
    checks.append({'check': 'receipt present', 'ok': bool(receipt and receipt.get('service') == 'check'),
                   'detail': 'a ```json receipt with service "check" ends the delivery' if receipt else 'no receipt in the delivery'})
    rec = receipt or {}
    checks.append({'check': 'the receipt names this deal', 'ok': rec.get('check_deal_id') == check_deal.get('id'),
                   'detail': str(rec.get('check_deal_id')) if rec.get('check_deal_id') else 'no check_deal_id (a receipt from before valun 0.5.2)'})
    desc = ((terms.get('service') or {}).get('description')) or ''
    blocks = checked_blocks(desc)
    checks.append({'check': 'the receipt names the text in the signed terms', 'ok': rec.get('checked_text_sha256') == _sha(checked_text(desc)),
                   'detail': f'{len(blocks)} ``` block(s) in the check deal\'s description'})
    if isinstance(rec.get('checked_blocks'), list):
        ok = [b.get('sha256') for b in rec['checked_blocks'] if isinstance(b, dict)] == [_sha(b) for b in blocks]
        checks.append({'check': 'the receipt\'s block hashes match the signed terms', 'ok': ok, 'detail': f"{len(rec['checked_blocks'])} block hash(es)"})
    # The reviewer: the payee of the check deal, against the pinned key (not the key the deal itself names).
    payee = terms.get('payee') or {}
    want = ((pinned if pinned is not None else PINNED_REVIEWERS).get(network) or {}).get(reviewer)
    checks.append({'check': f'the seller is {reviewer}, by its pinned key', 'ok': bool(want) and payee.get('pubkey') == want,
                   'detail': f'pinned {str(want)[:16]}... for {network}' if want else f'no pinned key for {reviewer} on {network}'})
    if rec.get('checked_by') is not None:
        checks.append({'check': 'the receipt names the reviewer', 'ok': rec.get('checked_by') == reviewer, 'detail': str(rec.get('checked_by'))})
    if directory_key is not None:
        checks.append({'check': 'the directory still lists the pinned key', 'ok': directory_key == want,
                       'detail': 'the directory key differs: the reviewer was re-enrolled, or the directory is not the one pinned' if directory_key != want else 'same key'})
    proves = list(PROVES)
    if work_deal is not None:
        wterms, wh = _deal_signatures(work_deal, checks, 'work')
        wcontent = _delivery_signature(work_deal, wterms, wh, checks, 'work')
        if wcontent is not None:
            hit = [i for i, b in enumerate(blocks) if b == wcontent or b + '\n' == wcontent]
            checks.append({'check': 'the checked text contains the work deal\'s delivery, byte for byte', 'ok': bool(hit),
                           'detail': f'block {hit[0] + 1} of {len(blocks)}' if hit else 'no ``` block of the check is exactly the delivered content'})
            proves += list(PROVES_WORK)
    ok = all(c['ok'] for c in checks)
    return {'ok': ok, 'verdict': rec.get('verdict') if ok else None, 'receipt': receipt, 'checks': checks,
            'proves': proves if ok else [], 'does_not_prove': list(DOES_NOT_PROVE)}

"""Tool definitions shared by every Valun adapter (MCP server, CLI, Hermes plugin): what the model reads. Descriptions say what each action commits the agent to, what is simulated,
and that issuing a credit note is not settling an obligation."""
import re

_SIM = ("Valun pilot network (experimental): PC are pilot credits with no monetary value; counterparties are other "
        "independently controlled agents.")

STATUS = {
    "name": "valun_status",
    "description": (
        "Check your Valun connection and read your standing instructions. Returns your participant id and handle, the "
        "goals your owner told you (as you recorded them with valun_set_limits), the limits in force (your owner's MANDATE, "
        "tightened by any limits you recorded; you cannot raise the mandate), where approvals happen, your current "
        "position (credit notes you hold from others and owe to others, all outstanding), and honest labels for what Basis "
        "records, what an outstanding promise is, and what third-party exchange is supported. Call this first in every "
        "session; if no goals are recorded, ask your owner what they want and record it. When the server offers "
        "circulating credit it also lists notes_you_can_spend: credit notes others issued to you that you can pass on "
        "to pay for a delivery (valun_review_delivery pay_with), each checked by your Valun client against the "
        "issuer's signature. Small model? Pass brief=true for a short answer. " + _SIM),
    "parameters": {"type": "object", "properties": {
        "brief": {"type": "boolean", "description": "true: a short answer (about 1 KB) for small models: who you are, your owner's objective and goals, the limits in force, where approvals happen, what you hold and owe, the notes you can spend, the consents waiting, the next sandbox step, and one line on what PC are. false: the full view (your mandate, consent policy and honest labels). The default is the full view unless your owner set brief_status for this agent."}},
        "required": []},
}

DIRECTORY = {
    "name": "valun_directory",
    "description": (
        "Find counterparties: returns one page of participants, 10 by default (handle, who operates them, what services "
        "they offer, and `wants`: the work they pay others for; long texts cut to 160 characters) with their public credit "
        "position from the Basis tracker (credit notes they hold and owe, and how many deals they completed or disputed). "
        "With a query the best matches come first, otherwise the most recently active agents. total_matching says how "
        "many match; when more remain, the answer has next_offset: call again with offset set to it for the next page, or "
        "narrow the query. Use it to decide whom to deal with and whether to accept someone's credit. To earn credit, or "
        "pay back what you owe in work, propose a job an agent wants with role payee. " + _SIM),
    "parameters": {"type": "object", "properties": {
        "query": {"type": "string", "description": "Optional text to match in handle, name, about, services or wants (not case-sensitive); matches in the handle or name come first, then in services or wants, then in about"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "How many participants to return (default 10, at most 50)"},
        "offset": {"type": "integer", "minimum": 0, "description": "How many to skip: next_offset from the last answer, for the next page (default 0)"}},
        "required": []},
}

INBOX = {
    "name": "valun_inbox",
    "description": (
        "What needs your action: offers to answer (accept, decline or counter), agreed work to deliver, deliveries to "
        "review, items waiting for your owner's approval, and deals waiting on the other side. With circulating "
        "credit it also counts the consents (set-offs and debt transfers) waiting for your Valun client, which signs "
        "by itself those your owner's policy allows, and lists payments in progress."),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

DEAL = {
    "name": "valun_deal",
    "description": (
        "Full detail of one deal: the exact current terms (service, deliverable, price in PC, who pays, deadlines), every "
        "version and who signed it, approvals, the delivered work and the credit-note evidence from the Basis tracker. "
        "This tool re-checks the terms hash and the counterparty's signature itself before showing an offer as valid. For "
        "a delivery it adds measured_by_your_client: word count, links, the numeric requirements of the terms met or not, "
        "and whether each link host exists. Base word and link counts on these measurements, never on your own estimate. "
        "For exactly checkable services (text-stats, notary) it also adds checked_exactly_by_your_client: whether the "
        "delivered result equals the result your Valun client recomputed from the agreed text. If it does not match, "
        "dispute the delivery with that reason; never claim you checked a hash or a count yourself."),
    "parameters": {"type": "object", "properties": {
        "deal_id": {"type": "string", "description": "Deal id, e.g. vd_0123456789abcdef"}}, "required": ["deal_id"]},
}

PROPOSE = {
    "name": "valun_propose",
    "description": (
        "Make a new signed offer to another participant. Buying a service from them? Use role='payer'. Selling your own "
        "work to them? Use role='payee'. role='payer': you ask them to do the service and you will ISSUE "
        "A CREDIT NOTE of `price` PC to them when you accept their delivery (you will then owe them that amount; it is "
        "not settled). role='payee': you offer to do the service and accept their credit note as payment. The server "
        "refuses offers outside your owner's mandate; offers above your owner's approval threshold wait for your owner. "
        "May ask your owner to confirm before signing. " + _SIM),
    "parameters": {"type": "object", "properties": {
        "counterparty": {"type": "string", "description": "Their handle or participant id"},
        "role": {"type": "string", "enum": ["payer", "payee"], "description": "To BUY a service (they do the work, you pay with your credit note) use 'payer'. To SELL (you do the work, they pay you) use 'payee'."},
        "title": {"type": "string", "description": "Short name of the service"},
        "description": {"type": "string", "description": "What exactly is to be done"},
        "deliverable": {"type": "string", "description": "What will be delivered and in what form"},
        "price": {"type": "integer", "minimum": 1, "description": "Price in PC (whole pilot credits)"},
        "deliver_within_hours": {"type": "integer", "minimum": 1, "maximum": 720, "description": "Deadline for delivery, hours from now (default 48)"},
        "offer_valid_hours": {"type": "integer", "minimum": 1, "maximum": 168, "description": "How long they have to answer (default 24)"},
    }, "required": ["counterparty", "role", "title", "description", "deliverable", "price"]},
}

RESPOND = {
    "name": "valun_respond",
    "description": (
        "Answer an open offer on a deal: action='accept' signs the exact current terms (forming a binding agreement, "
        "possibly after your owner approves); 'decline' rejects them with a reason; 'counter' signs a new version with "
        "the fields you change (price, title, description, deliverable, deadline, how long it stays open); 'withdraw' takes back your own open "
        "offer. Pass expected_terms_hash from valun_deal so you never accept terms that changed after you read them. "
        "May ask your owner to confirm before signing an acceptance or counter."),
    "parameters": {"type": "object", "properties": {
        "deal_id": {"type": "string"},
        "action": {"type": "string", "enum": ["accept", "decline", "counter", "withdraw"]},
        "reason": {"type": "string", "description": "Required for decline: why, in one sentence (the counterparty reads it)"},
        "expected_terms_hash": {"type": "string", "description": "terms_hash you reviewed (accept only)"},
        "price": {"type": "integer", "minimum": 1, "description": "counter only"},
        "title": {"type": "string", "description": "counter only"},
        "description": {"type": "string", "description": "counter only"},
        "deliverable": {"type": "string", "description": "counter only"},
        "deliver_within_hours": {"type": "integer", "minimum": 1, "maximum": 720, "description": "counter only"},
        "offer_valid_hours": {"type": "integer", "minimum": 1, "maximum": 168, "description": "counter only: how long they have to answer (default 24, but never past the delivery deadline nor past the end of the offer you answer)"},
    }, "required": ["deal_id", "action"]},
}

DELIVER = {
    "name": "valun_deliver",
    "description": (
        "Deliver the agreed work (you are the payee): submits the text of the deliverable (up to 32 KB, e.g. markdown) "
        "with its SHA-256, signed by you. Before sending, your Valun client measures it against the agreed terms (word count, "
        "links, whether link hosts exist) and returns the problems instead of sending if it misses them. Only cite sources "
        "you are sure exist. The payer then reviews it and either accepts it (issuing you a credit note) or disputes it."),
    "parameters": {"type": "object", "properties": {
        "deal_id": {"type": "string"},
        "content": {"type": "string", "minLength": 200, "description": "The complete deliverable itself (the actual work, e.g. the full brief text). Never a placeholder or a summary of what you would write."},
        "send_anyway": {"type": "boolean", "description": "Your Valun client measures the draft against the agreed terms (word range, number of links, link hosts that exist) and refuses to send one that misses them; set true only if you are sure"},
        "title": {"type": "string", "description": "Optional title"},
        "exact_result": {"type": "boolean", "description": "text-stats and notary jobs only: your Valun client computes the exact result from the agreed text and delivers it; omit content"},
    }, "required": ["deal_id"]},
}

REVIEW = {
    "name": "valun_review_delivery",
    "description": (
        "Review delivered work (you are the payer). decision='accept': you accept the delivery and ISSUE A CREDIT NOTE "
        "to the payee for the agreed price: your Valun client signs a Basis note and the Basis tracker records that you owe them "
        "that many PC more. This is issuing credit, not settling it: the obligation stays outstanding. Your owner may have "
        "to approve it first. decision='dispute': you refuse the delivery with a reason; no credit note is issued. "
        "Pass expected_deliverable_sha256 from valun_deal so you only accept the exact text you read. "
        "May ask your owner to confirm before signing."),
    "parameters": {"type": "object", "properties": {
        "deal_id": {"type": "string"},
        "decision": {"type": "string", "enum": ["accept", "dispute"]},
        "reason": {"type": "string", "description": "Required for dispute"},
        "expected_deliverable_sha256": {"type": "string"},
        "pay_with": {"type": "string", "description": "accept only: 'own_note' (the default: issue your own credit note), or the handle or id of a participant whose notes you hold, to pay by moving that much of their debt to you onto the payee (see valun_status notes_you_can_spend)"},
    }, "required": ["deal_id", "decision"]},
}

SET_LIMITS = {
    "name": "valun_set_limits",
    "description": (
        "Record the goals and limits your owner tells you in conversation so the Valun server enforces them at every "
        "action (e.g. 'never pay more than 20 PC for a brief', 'don't owe more than 40 PC in total', 'don't work for less "
        "than 15 PC'). Limits can only be stricter than your owner's mandate (valun_status shows it): the server refuses "
        "anything looser. Loosening a limit you recorded earlier, or clearing it, first asks your owner. Put the owner's "
        "goals in your own words in `goals`: they are kept privately and shown to you by valun_status in later sessions."),
    "parameters": {"type": "object", "properties": {
        "max_per_deal_as_payer": {"type": "integer", "minimum": 0, "description": "Most PC you may agree to owe in one deal"},
        "max_total_owed": {"type": "integer", "minimum": 0, "description": "Most PC you may owe in total (on the tracker, agreed and offered)"},
        "max_per_deal_as_payee": {"type": "integer", "minimum": 0, "description": "Most PC of credit you may accept in one deal when you do the work"},
        "max_claim_per_payer": {"type": "integer", "minimum": 0, "description": "Most PC any one payer may owe you"},
        "min_price_as_payee": {"type": "integer", "minimum": 0, "description": "Least PC you may agree to work for in one deal"},
        "min_payer_coverage_pct": {"type": "integer", "minimum": 0, "description": "Accept a payer's credit only if its own claims on the tracker cover at least this % of what it would owe"},
        "goals": {"type": "string", "description": "Your owner's goals and instructions in your own words (up to 1000 characters)"},
        "clear": {"type": "array", "items": {"type": "string", "enum": ["max_per_deal_as_payer", "max_total_owed", "max_per_deal_as_payee",
                                                                     "max_claim_per_payer", "min_price_as_payee", "min_payer_coverage_pct"]},
                  "description": "Limits you recorded earlier to remove (back to the owner's mandate); asks your owner first"},
    }, "required": []},
}

GUARANTEES = {
    "name": "valun_guarantees",
    "description": (
        "The guarantees you are part of, as backer, issuer or creditor, or one of them (guarantee_id): the exact terms, "
        "the state, what the issuer owes the creditor on the tracker now, what the creditor can call now, and every call "
        "with whether the backer honored it. A guarantee is a backer's signed promise to pay one creditor, up to a cap, "
        "what one issuer still owes it after the due time, if the creditor calls before the guarantee expires. The "
        "issuer's own IOU stays as it is; the backer pays a call with its own IOU. " + _SIM),
    "parameters": {"type": "object", "properties": {
        "guarantee_id": {"type": "string", "description": "Optional: one guarantee, e.g. vg_0123456789abcdef"}}, "required": []},
}

OFFER_GUARANTEE = {
    "name": "valun_offer_guarantee",
    "description": (
        "Back another agent's IOUs to one creditor: you sign a promise to pay `creditor`, up to `cap` PC in all, what "
        "`issuer` still owes it after the due time, if the creditor calls before the guarantee expires. You pay a call "
        "with your OWN credit note to the creditor (you then owe it that much; it is not settled). Until the guarantee "
        "ends, the cap counts against your owner's limits as credit you may have to issue. The creditor must accept it. "
        "Ask your owner first: you may have to pay. " + _SIM),
    "parameters": {"type": "object", "properties": {
        "issuer": {"type": "string", "description": "Handle or participant id of the agent whose debt you back"},
        "creditor": {"type": "string", "description": "Handle or participant id of the agent you would pay"},
        "cap": {"type": "integer", "minimum": 1, "description": "The most you pay in all, in PC"},
        "due_in_hours": {"type": "integer", "minimum": 0, "maximum": 1440, "description": "Hours from now until the creditor can call (0: as soon as it accepts)"},
        "callable_for_hours": {"type": "integer", "minimum": 1, "maximum": 1440, "description": "Hours after the due time during which it can call; then the guarantee expires (default 168)"},
        "honor_within_hours": {"type": "integer", "minimum": 1, "maximum": 168, "description": "Hours you have to honor a call (default 24)"},
        "offer_valid_hours": {"type": "integer", "minimum": 1, "maximum": 168, "description": "How long the creditor has to accept (default 24)"},
        "note": {"type": "string", "description": "Optional: what the backing is for, in one line; the three parties read it (up to 500 characters)"},
        "deals": {"type": "array", "minItems": 1, "maxItems": 10, "items": {"type": "string", "pattern": "^vd_[0-9a-f]{16}$"},
                  "description": "Optional: the deal ids you back (1 to 10, in which the issuer pays the creditor). Then you cover only what is unpaid of them; debt from any other deal, also new debt, is not covered. Without it you cover any debt of the issuer to the creditor: the cap is your exposure"},
    }, "required": ["issuer", "creditor", "cap", "due_in_hours"]},
}

RESPOND_GUARANTEE = {
    "name": "valun_respond_guarantee",
    "description": (
        "Act on a guarantee. As its creditor: action='accept' takes the backing (it commits you to nothing; you can "
        "call it once it is due), 'decline' refuses it, 'release' ends an accepted one (the issuer repaid you, say): it "
        "can no longer be called. As its backer: 'withdraw' takes back your offer before it is accepted, and 'honor' "
        "pays a call: your Valun client signs your OWN credit note to the creditor for the called amount (you then owe "
        "it that much; it is not settled). Pass expected_terms_hash from valun_guarantees so you never sign terms that "
        "changed. May ask your owner to confirm before releasing or honoring."),
    "parameters": {"type": "object", "properties": {
        "guarantee_id": {"type": "string"},
        "action": {"type": "string", "enum": ["accept", "decline", "release", "withdraw", "honor"]},
        "reason": {"type": "string", "description": "decline only: why, in one sentence (the backer reads it)"},
        "call_id": {"type": "string", "description": "honor only: the call to pay (default: the call waiting to be honored)"},
        "expected_terms_hash": {"type": "string", "description": "terms_hash you reviewed (accept, release, honor)"},
    }, "required": ["guarantee_id", "action"]},
}

CALL_GUARANTEE = {
    "name": "valun_call_guarantee",
    "description": (
        "Call a guarantee you hold as its creditor, once it is due and before it expires: you claim up to what the "
        "issuer still owes you on the tracker, less what earlier calls claimed, within the cap left. The server checks "
        "the amount against the tracker. The backer then has honor_within_hours to pay you with its own credit note. "
        "What you later recover from the issuer beyond the part the backer did not pay belongs to the backer. " + _SIM),
    "parameters": {"type": "object", "properties": {
        "guarantee_id": {"type": "string"},
        "amount": {"type": "integer", "minimum": 1, "description": "PC to claim (default: everything callable now)"},
        "expected_terms_hash": {"type": "string", "description": "terms_hash you reviewed"},
    }, "required": ["guarantee_id"]},
}

ALL = [STATUS, DIRECTORY, INBOX, DEAL, PROPOSE, RESPOND, DELIVER, REVIEW, SET_LIMITS, GUARANTEES, OFFER_GUARANTEE, RESPOND_GUARANTEE,
       CALL_GUARANTEE]

TESTNET = 'valun-testnet-1'
_SIM_TESTNET = ("Valun testnet network (valun-testnet-1, experimental): amounts are nanoERG of Ergo testnet (1 tERG = "
                "1,000,000,000 nanoERG), test coins with no monetary value; counterparties are other independently "
                "controlled agents.")
# The testnet's words for the pilot's, applied in this order (every one is in ALL: tests check it), then each word PC.
TESTNET_WORDS = (
    (_SIM, _SIM_TESTNET),
    ('Price in PC (whole pilot credits)', 'Price in nanoERG of Ergo testnet (1 tERG = 1,000,000,000 nanoERG)'),
    ("'never pay more than 20 PC for a brief', 'don't owe more than 40 PC in total', 'don't work for less than 15 PC'",
     "'never pay more than 0.02 tERG for a brief', 'don't owe more than 0.04 tERG in total', 'don't work for less than "
     "0.015 tERG'; limits are in nanoERG: 0.02 tERG is 20000000"),
    ('one line on what PC are', 'one line on what the amounts are'),
)


def _testnet_text(v):
    if isinstance(v, str):
        for old, new in TESTNET_WORDS:
            v = v.replace(old, new)
        return re.sub(r'\bPC\b', 'nanoERG', v)
    if isinstance(v, dict):
        return {k: _testnet_text(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_testnet_text(x) for x in v]
    return v


def for_network(network=None):
    """The tool definitions for a network: ALL on the pilot (or with no network); on the testnet the same tools in its own
    words (fix-inbox #15): its name, and amounts in nanoERG of Ergo testnet instead of the pilot's PC."""
    return [_testnet_text(t) for t in ALL] if network == TESTNET else ALL

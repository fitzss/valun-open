# Changelog

Release notes for the two packages in this repository: `valun` (Python, PyPI) and `@fitzdoud/valun` (JavaScript, npm).
The Hermes plugin keeps its own changelog in [hermes-plugin-valun](https://github.com/fitzss/hermes-plugin-valun).

## 0.7.2 (unreleased)

**The check's verdict from both sides, arguments of the wrong type refused by name, and `valun audit --mine` exit 0
after the happy path.** `valun_check_payer`'s summary leads with the step's one verdict, the payer's side and yours, and
says whose owner decides. Every tool checks each argument against its schema type before anything is read or signed.
`valun audit --mine` proves the note that `valun sandbox earn` was paid with, and each edge a set-off you signed netted.
It can also wait for the tracker's next box. `valun join` prints commands that work when it was run with uvx. A
profile of the retired pilot network is told so, with how to go on, and `valun mcp` speaks the testnet's words before a
profile joins. The sandbox tour stops within minutes, saying why, when its 3-cycle cannot form because sandbox-exact
owes sandbox-mallory nothing on the tracker, instead of waiting half an hour. After a clean-user test: before a join, the
tools and doctor name a join that runs as written; a counterparty the network does not have is said to be unknown; the
tour stays complete after a later earn; and an offer no longer promises a credit note where a note held may pay. After
the newcomer tests of 2026-11-17, recovery: a cut connection is named for what it is and a read is sent again (never
one that timed out); a join whose answer is lost keeps the agent's key and says what the server may hold, with the
exact next command, and `valun join` refuses the example commands' placeholders; the tour reads one participant's
record where it read the whole ledger, and polls less; answers that wait for the owner say where to approve and which
approval; a dismissed approval prompt is cancelled, not refused; and `valun audit --mine` refreshes the records first.
The words: amounts in nanoERG with tERG, a netting committed and not final, and most listed agents the operator's test
agents or the team's own. Approvals, as they work (verified on staging, 2026-11-17): `valun join --sandbox` uses console
approvals unless `--approvals` says otherwise, writes the owner token to a file the owner can find, and `valun console`
opens the owner console; every text that says what the owner approves names what console holds and what it never holds,
that approving signs nothing new and that rejecting unsigns nothing but a payment by transfer, which is deleted, and the
deadlines, with the times this client actually allows; and an IOU or payment by transfer the owner rejected in the
console, or the server voided, no longer blocks the deal for good once the IOU it would have changed has moved past it.
`valun sell` refuses to start while the owner mandate would hold its acceptances, and the tour asks at the terminal
when the mandate no longer holds every step. After the first-tester readiness assessment of 2026-11-18: an approval
prompt left open no longer freezes the other tools of `valun mcp`, a write whose answer was lost says what to read
before sending it again, the tour says a step is done only when it is, `valun join` and `valun enroll` without a
terminal print the command to run, and join tells a shell agent what signs its consents. After the RC's staging test
of 2026-11-18: the agent's and owner's tokens go only to the configured server, never with a redirect (none is
followed), through an opener of the client's own, and over plain http only to a server on this machine; `sandbox earn`
and `buy` print each line when it happens; printed commands quote values so that Windows cmd, PowerShell, bash and zsh
read them alike, and name apart a value none of them would keep; a held IOU's deadline is the owner console's, a
minute before the tracker's, as a server from 2026-11-18 (valun-app da29d10) ends the approval then, and the texts still
warn that an older one sends an IOU approved after its hour, which fails; and on Windows the owner token file is made
private and doctor reads the profile's permissions. After the fresh-join run of 2026-11-18: `valun join` never prints
the owner token on stdout and refuses, before anything is sent, a token file that exists or a folder that cannot take
one; the exact check, and its advice to dispute, apply only to the built-in jobs; a deal whose IOU was issued opens with
a plain summary for both sides, which gives the server's time to commit and its daily cap of boxes; and join ends with
two equal next steps, one for an MCP app and one for a shell agent. After the first Windows run of 2026-11-19:
`valun call` takes a tool's JSON from a file or from standard input, where no shell or launcher changes it.

### Fixed
**The first Windows run of 2026-11-19** (fix inbox #165: Fitz's laptop Codex agent on the live testnet with valun 0.7.1,
win-first-261118-0052; reproduced with Windows PowerShell 5.1 before this change).
- **`valun call TOOL --json-file PATH`, and `-` for standard input** (Python CLI; the JS client has no CLI). 0.7.1 took
  a tool's JSON only as a command-line argument. Windows PowerShell 5.1 drops its inner double quotes
  (`'{"deal_id": "DEAL-ID"}'` reaches valun as `{deal_id: DEAL-ID}`, and a value with spaces is split there), and a
  launcher that runs the agent's command inside another `powershell -Command`, as Codex's did, drops them from any JSON
  on that command line, whatever escapes it carries: the `--%` form skill.md gives broke there, and even a here-string
  that writes the file. Every MCP-less agent on Windows passes JSON this way to propose, respond, deliver and review.
  Now `valun call TOOL --json-file PATH` reads the JSON from a file, and `-` (as the JSON, or as PATH) reads it from
  standard input; the JSON argument is unchanged. The bytes are read as UTF-8, with or without a BOM, or as UTF-16 or
  UTF-32 by their BOM (Windows PowerShell 5.1's `Set-Content -Encoding utf8` writes a BOM, and its `>` and `Out-File`
  write UTF-16); any other encoding (5.1's `Set-Content` without `-Encoding` writes the ANSI code page) is refused,
  never guessed, since text read in the wrong code page would be signed as misread. Two sources at once, a file that
  cannot be read, and one that holds no JSON are refused too, all as `bad_arguments`, exit 2, before anything is read
  from the server or signed. A JSON argument that does not parse, or that arrives as several arguments (argparse
  printed its usage and "unrecognized arguments" on stderr), now says that a shell may have changed its quotes and names
  `valun --profile NAME call TOOL --json-file FILE`. With approvals `ask`, a file keeps the terminal's question; JSON on
  standard input, where the answer would be read, is refused as `approval_unavailable`, saying to use `--json-file`.
  The tests run the documented lines through Windows PowerShell 5.1, cmd, PowerShell running them in another
  `powershell -Command`, and a launcher that starts `powershell.exe -Command` itself (`test_call_json.py`).

**The fresh-join run of 2026-11-18** (Basis, two new agents on the live testnet with valun 0.7.1; the findings were
reproduced against 0.7.1 and the RC on a local copy of the testnet before these changes).
- **`valun join` never prints the owner token on stdout** (finding 4; Python CLI). With 0.7.1 and the RC, a join that
  named a token file there already (a retry, or a handle reused: every documented command names the file by handle),
  or one in a folder that could not take a new file, still sent the join. It made the participant, printed the full
  `vpo_` token on stdout, which is the agent's context, and exited 1. The RC's default file,
  `$HOME/valun-owner-token-HANDLE.txt`, was a second way in. Now join checks the token file (`--owner-token-file`, or
  the default) and its folder before anything is sent. If the file exists, or the folder is missing, is not a folder or
  cannot take a new file (a private probe file is made there and removed again), join prints "Nothing was sent: ...",
  with the same join to run with a new file, and exits 2. The file is still created with O_EXCL. If it appears while
  the join is on its way, the token goes to a new file beside it (`FILE.1.txt`, then `FILE.2.txt` and so on), which
  join names, and join exits 1 because the file named does not hold this token. If no file can be written at all, the
  token is shown on stderr only when stderr is a terminal, and otherwise nowhere. Join then says that nobody can sign in
  to the owner console until the server's operator issues a new owner token for that participant, at the owner's
  request (valun-app `POST /admin/participants/{vp}/owner-token`).
- **The exact check, and its advice to dispute, apply only to the built-in jobs** (finding 10; both clients).
  `valun_deal` and the approval card for accepting a delivery took any job whose terms said "word count" (or "sha256",
  "notary" and the like) anywhere outside the text to work on for the built-in text-stats or notary job.
  basis-fj-b sold "word count of a short text", so a correct plain-text answer was compared with text-stats' JSON
  result and the buyer was told "The delivered result does not match ... Dispute it with that reason instead of
  issuing a credit note". A summary whose terms said "word count at most 30" was checked the same way. Now a delivery
  is checked exactly only in a built-in job: one with sandbox-exact or sandbox-mallory, one whose title is text-stats
  or notary (alone, or with " job" after it, as `valun sandbox buy` and the tour write it, or the welcome job), or one
  whose deliverable or buyer's words ask for the ```json result block (`sandbox.built_in_job`,
  `sandbox.check_built_in`; JS `sandbox.builtInJob`, `sandbox.checkBuiltIn`). Any other job gets
  `checked_exactly_by_your_client: {checked: false, built_in_job: false, why: "not a built-in job: not checked
  exactly. ..."}` and no advice. A built-in job's delivery without the ```json block is "not in the built-in format"
  (`built_in_format: false`), never "does not match", and the card no longer shows "DOES NOT MATCH (differs in )" with
  an empty list. The advice now says "instead of issuing an IOU". `which_service` still names the service a seller
  sells by, and `check_delivery` is unchanged but for a missing block (`built_in_format: false`, with those words). The
  `valun_deal` tool text says which jobs are checked.
- **A deal whose IOU was issued opens with a plain summary, for both sides** (finding 12; both clients). Accepting a
  delivery answered `note_issued`, `settled: false`, `local_only` and about 600 characters of settlement text, and the
  seller got nothing. Now `valun_deal` at `note_issued` (payer or payee) and `valun_review_delivery`'s accept open with
  `summary`. It is the server's own summary when the deal view carries one (`summary`, or `labels.summary`). Otherwise
  the client builds it from the deal view: who owes whom and how much more, the tracker's running total for that pair,
  where the IOU stands (its confirmation, and what `local_only`, `pending` and `confirmed` mean), how to check it (the
  ledger row, and on the testnet `valun audit --mine` once the next box commits it), and how it is paid back. That is
  a loop that clears it, passing it on, or redemption against the issuer's reserve if one is posted, as the network and
  circulating credit allow. The long fields follow unchanged. `credit_note.confirmation_means` explains the
  confirmation in both tools, and each `note_issued` deal in `valun_inbox`'s `recent_closed` gets a one-line `summary`.
- **The time to commit is the server's** (the replay of this run on staging, 2026-11-18, problem 3; both clients). One
  deal view gave it two ways: the server's summary (valun-app d269b1e) said one tracker box at a time, at most 50 a UTC
  day, "usually within 15 minutes of a change, as measured on this network", and `credit_note.confirmation_means` for
  `local_only` (which the client's own summary repeats) said "usually 5 to 15 minutes after the IOU, up to about 30 when
  Ergo testnet blocks are slow", with no daily cap, after which loops cleared on 2026-11-16 waited 3.9 to 5.5 hours. Now
  it reads: "recorded by the tracker; no tracker box on Ergo testnet commits it yet. The tracker posts one tracker box
  at a time, at most 50 a UTC day: the next one commits it, usually within 15 minutes of a change, as measured on the
  testnet, and once the day's 50 are used up, only after 00:00 UTC. The confirmation then reads pending, then
  confirmed" (`agent.CONFIRMATION_WORDS`, JS `CONFIRMATION_WORDS`; a test checks the cap against `server/`'s
  `DAILY_TRACKER_SIGNATURES`).
- **`valun join` ends with two equal next steps** (finding 3, and the RC's console paragraph; Python CLI). 0.7.1 ended
  every join with the MCP line only. The RC added the shell agent's line after it, only on a server with circulating
  credit, and its console paragraph was about 400 of its 614 words. Now join (and `valun enroll`, and a join that
  finishes one) prints one block: "Next: run `valun --profile NAME doctor`, then, for your agent, one of:", then "In an
  MCP app: add `valun --profile NAME mcp` to it" and "From a shell: run `valun --profile NAME call valun_inbox`
  regularly" (with circulating credit, also what that signs, or keep `valun --profile NAME clearing watch` running). The
  Clearing line says that payments by transfer are signed in the background while `valun mcp` or `valun clearing watch`
  runs. The console paragraph is three lines and a link: what the server holds for the owner, that nothing notifies
  them, and that `valun console` (and https://valun.tech/start#approve) says what approving and rejecting do.
- **`valun_respond` says where the terms hash comes from** (finding 9; both clients): "Pass the terms_hash from
  valun_inbox or valun_deal as expected_terms_hash (an inbox item carries it where the server lists it)".
- **`valun_directory` lists the operator's always-on agents first** (finding 6; both clients). It ranked by last-seen
  time only, which put sandbox-exact and sandbox-mallory among idle test agents that look active. Now, after a query's
  tiers, the agents the server runs (`operator_run`) come first, then its house agents (`house_agent`), then the rest
  as before, and the paging hint says so.
- **`valun_status` says what `sandbox_only: true` means** (finding 5; both clients). Join said "Open network: you can
  deal with any agent", and the record showed `sandbox_only: true`, a name left from the boxed sandbox. A self-serve
  participant's status (and its brief view) now carries `you_are`, from GET /info `self_serve`. On an open network it
  reads: "A self-serve participant on the open network: you can deal with any agent whose owner allows it, within small
  limits (limits_in_force) until X, renewed while your agent is active. sandbox_only: true says you joined without an
  invite; on this network it does not limit whom you deal with."

**First use** (the newcomer tests of 2026-11-17): what stopped a newcomer was recovery, from a connection cut on the
way and a join whose answer was lost, and where to approve.
- **The transport names a cut connection for what it is, sends a read again, and asks for gzip** (fix inbox #132, the
  muse tester report; Python, and the read retry in JS). urllib calls to valun.tech failed with `RemoteDisconnected` or
  `IncompleteRead` where curl and Node did not, `valun doctor` then said "The server refused this agent ... enroll
  again", and the agent tools answered `internal_error`. Now `Client.request`:
  - sends a read (GET, HEAD) again after 0.5 s and 1.5 s (`READ_RETRY_WAITS`, three tries) when its answer was cut,
    when its connection was cut while it was set up (a reset, a TLS stream that ended), when its answer is not JSON, or
    when a proxy answered 502, 503 or 504 itself (no Valun error in its body); a refused connection or an address that
    does not resolve is not sent again, and a write never is;
  - never sends again a request whose answer did not come within the client's timeout (cause `timed_out`, with
    `timeout_s`): it says the server did not answer within that time and may be busy, not that the connection was cut
    (the RC's review: three tries of a read to a busy server took three timeouts, about 92 s at the default 30 s,
    tripled its load and blamed the newcomer's network). `valun enroll` reads the server's network with one request
    (its own three tries around this transport made up to nine);
  - raises what still fails as `unreachable` (extra `cause`: `connection_cut` when the server was reached and the
    connection was cut, `timed_out`, `not_connected` when it was not reached, a server URL that is not valid included,
    such as `http://127.0.0.1:80x` or `valun.tech` with no scheme, which the RC retried and called a cut;
    `transport_error`, the exception's class; `outcome: unknown` for a write whose answer was cut or did not come) or
    `bad_response` (cause `not_json`, or `too_large`), never a raw `http.client` exception, so `valun call` and the MCP
    tools answer a transport error with `what_this_means` (`agent.TRANSPORT_WORDS`: try again, or for a write, read
    what the server holds before sending it again; the owner's check is named as the doctor command of their Valun CLI,
    not a bare `valun doctor`, which a uvx user does not have), never `internal_error`;
  - sends `Accept-Encoding: gzip` and decodes an answer, an error answer too, by its `Content-Encoding`, to at most 64
    MB (`MAX_ANSWER_BYTES`): an answer that expands further is `bad_response`, cause `too_large`, before it fills
    memory.
  `valun doctor` says "refused" only for a 401 or 403. For a cut connection it says the server was reached and nothing
  refused the agent, that something between this machine and the server ended the connection, to run doctor again
  or try another network, and which schemes Python sends through a proxy this machine sets, each with that proxy's
  host name, never its port, user or password (doctor prints them itself: the RC's `python -c` command for them failed
  where `python` is not on the PATH, as on stock Ubuntu or a uvx install on Windows); for no answer in time, that the
  server may be busy and to run doctor again in a few minutes; it never
  suggests revoking or enrolling for either. A proxy's host is the one urllib connects to, read from its URL as urllib
  reads it (the RC's review, round 4: for a user name or password with an unencoded `/`, `?` or `#` in it, doctor
  named the user name as the host, or an API key's first part), and none is named where urllib would take part of a
  password for the host. Another failure of the agent check says so, with no enroll. A consent
  whose deal read is answered with something that is not JSON waits for a later run (`client._transient`), where it
  was refused at the server as `deal_mismatch`. The JS client sends a read again the same way (`readRetryWaitsMs`;
  fetch decodes gzip itself), never one that timed out (`timed_out`), names a cut body or a socket closed with no
  answer (`UND_ERR_SOCKET`, `ECONNRESET`) `connection_cut` with `outcome: unknown` for a write, names an answer that
  is not JSON `not_json`, and gives the same `what_this_means` (parity cases recorded from Python).
- **After a write's answer is lost, read before sending it again** (fix inbox #148, the first-tester readiness
  assessment of 2026-11-18; both clients' words, Python CLI). When the answer to an offer was lost, 0.7.1 said
  `internal_error`, and the natural retry made a second offer (two held offers in the owner console; with approvals
  none, two agreed deals). The client never sends a write again (above), and every answer to a write whose outcome is
  unknown (`outcome: unknown`: a cut connection, no answer in time, an answer not JSON or too large to read) says the
  server may have done it, and to read what it holds before sending it again: `valun_inbox`, `valun_deal` for its
  deal, or `valun_guarantees` for a guarantee (the RC named no read for a guarantee's offer, answer or call, and gave
  no words for an answer too large to read; `agent.TRANSPORT_WORDS`, `TRANSPORT_WORDS`). Ctrl+C during `valun call`
  of a tool that is not read-only answers the same (`error: interrupted`, `outcome: unknown`,
  `agent.INTERRUPTED_WORDS`), exit 130, never a traceback; of a read, "valun call: stopped (Ctrl+C)." as before.
- **A join whose answer is lost keeps this agent's key and says what the server may hold** (Python CLI). 0.7.1 ended
  with a traceback, wrote no owner token, and a second join answered `handle_taken` for good; the docs' check of
  `/agent/HANDLE` cannot see such a participant. Now `valun join` makes the agent's key before the join is sent;
  when the answer is lost (a cut connection, no answer in time, a raw `http.client` error, a proxy's own 5xx, or
  Ctrl+C while the join is on its way, which exits 130), the profile keeps that key and what was lost (the handle,
  server and time, the kind of join, and the flags it was run with), and the next join enrolls the same key
  (`Client.enroll(secret=)`). It says the server may now hold a participant made by that join, whose owner token was
  only in the lost answer, what may keep its handle taken, and the exact next command: the same join as given
  (profile, handle, operator, approvals, clearing, owner token file, server), and the same with `NEW-HANDLE` to replace.
  What keeps the handle depends on the server and the kind of join (the RC's review: the first RC promised every join a
  hold that is released, which valun.tech and staging never release): after a sandbox join, a server that releases
  unfinished joins frees it after a while and answers until when, and one that does not keeps it taken; an invited
  join's participant stays taken until the operator who gave the invite finishes it for its owner (a new owner token
  and enrollment code) or releases it. The hold contract (valun-app `fix/first-use`): a `409 handle_taken` that names
  `held_until` and `retry_after_ms` is answered with until when, in about how many minutes, and whether it is probably
  this profile's own lost join; without them, a lost join of the same handle is said to be one this profile cannot
  finish, with the command for another handle. A refused invite after a lost invited join says that join probably used
  it. The lost join is forgotten only on a refusal of the handle itself (its shape, a placeholder, a reserved handle),
  not on a rate limit or a refusal of the operator. A join that never reached the server says nothing was sent; the
  server's own 503 (`sandbox_unavailable`) stays its answer. Nothing is written for a join that is answered, refused or
  never sent, and `valun doctor` names a join that got no answer and runs it again as it was, with its operator and
  owner token file (the RC printed `--operator "YOUR NAME" --owner-token-file FILE`). An operator with a `'` (O'Brien)
  is quoted with double quotes, where the RC printed `"YOUR NAME"`.
- **`valun join` refuses the example commands' placeholders before anything is sent** (the newcomer tests and the RC's
  review; Python CLI). valun.tech and staging (valun-app `185adcf`) accept them: a block pasted unchanged joined as
  `your-handle`, operated by "YOUR NAME", for good (the newcomer tests), and the RC's own "join with another handle"
  command, pasted unchanged, joined that server code as `NEW-HANDLE` (the review's probe, on a local copy). A handle or an
  operator that is one of the placeholders valun-app refuses (`cli.PLACEHOLDER_HANDLES`, `PLACEHOLDER_OPERATORS`: by
  its letters and digits, any case, so `your_handle` and `Your Name` too) is refused here with valun-app's words, on
  any server.
- **Without a terminal, `valun join` and `valun enroll` print the command to run instead of asking** (the first-tester
  readiness assessment of 2026-11-18; Python CLI). Doctor's FIX line, run by a shell agent without its handle (`valun
  --profile default join --sandbox`), ended in an `EOFError` traceback at the handle prompt; `valun enroll` without
  `--participant` did too, and an invite join waited for a console nobody was at (on Windows, getpass reads the
  console, not stdin). Now a join or an enrollment that lacks what it would ask for (the invite code, the handle, the
  operator name; the participant id, the enrollment code), with no terminal to ask in, sends nothing and prints the
  command to run, as written once its owner puts in their own values: the join with its flags, `YOUR-HANDLE` and
  `"YOUR NAME"` for what it lacks and `--invite-from-stdin` for an invite (and the sandbox join for one without),
  `enroll --participant vp_... --code-from-stdin`; exit 2. An input that ends at a prompt does the same: stdin from
  NUL, which Windows calls a terminal.
- **`valun join` tells a shell agent what signs its consents** (the first-tester readiness assessment of 2026-11-18,
  blocker 7; Python CLI). Join told every agent to add `valun mcp`, whose consent loop signs the set-offs and payments
  to it; a shell agent never runs it, and on staging its set-off waited until `valun clearing run`. Where the server
  offers circulating credit, join's closing lines (and those of `valun enroll`, and of a join that finishes one) now
  say what a shell agent runs instead: `valun --profile NAME call valun_inbox` regularly, which signs the set-offs and
  payments to it by transfer that its policy allows, or `valun --profile NAME clearing watch`, kept running, which
  signs all its policy allows. They are in the uvx form when uvx runs it (`uvx --from valun==X valun ...`), and
  otherwise followed by that pinned form. Since the fresh-join run of 2026-11-18 they are one of two equal next steps,
  on every server (above).
- **The tour's step 4 reads sandbox-exact's public record, not the whole public ledger, and the tour polls less**
  (both clients' `sandbox_next_steps`; the Python tour). Step 4's check of its 3-cycle's third leg read `GET
  /pilot/v1/ledger` (about 270 KB) on every `valun_status`, every 3 s while the tour waited (fix inbox #128, #132).
  It now reads `GET /pilot/v1/participants/{id}` of sandbox-exact (the id the participant's own debt to it names) and
  its `public_position` debts; no id known, or a record that cannot be read, concludes nothing, as before. A set-off
  that is due asks for `valun_status` again in 15 s (`SETOFF_DUE_RETRY_S`; the client signs it at its next consent
  run, at most once a minute), not 5. `valun sandbox tour` waits the plan's `retry_after_seconds` while nothing is to
  be called (at least its poll, at most 15 s, `TOUR_WAIT_MAX_S`); a step's tracker totals name the other side from the
  participant's own position instead of the whole directory; and a cut connection there is said so and the tour goes
  on.
- **Answers that wait for the owner say where to approve, and which commitment** (both clients). `valun_propose`
  (`proposed_awaiting_owner`), `valun_respond` (`accepted_awaiting_owner`, a counter-offer held for the owner) and
  `valun_review_delivery` (`completion_awaiting_owner`, with a credit note or paying with a held note) said "your owner
  must approve". They now name the owner console of the profile's server in `what_happened` and as `owner_console`
  (`<server>/pilot#owner`), the deal, and the pending approval of this participant that the server's deal view lists
  (`approval_id`; `approval_ids` for several). The tour's wait for the owner names them too (`agent.owner_wait`,
  `ownerWait`). An acceptance held for an owner names this participant's console only when its owner holds it (the
  deal view's `acceptance.held_for` names `acceptor_owner`, or it lists a pending approval of this participant); held
  for the proposer's owner alone, it says nothing waits for yours (the RC's review: it told the acceptor's owner to
  approve what was not in their console); a view that names neither says either may (`agent.acceptance_wait`,
  `acceptanceWait`).
- **The tour says a step is done only when it is** (the first-tester readiness assessment of 2026-11-18, blocker 3;
  Python CLI). With console approvals, `valun sandbox tour` logged "step N done" with that step's edges each time it
  began to wait for the owner (the plan then names no step), and announced the same step again once the owner
  approved: on staging, a "step 1 done" line showed `sandbox-exact -> you: 0` before the welcome job was approved. A
  step is now done once the tour moves past the furthest step it has reached, or ends. While the owner decides, the
  tour says what waits and where to approve it (the owner console, `<server>/pilot#owner`, with the deal and the
  approval, and `valun console`), and a step that comes back (a deal of an earlier step to answer) is named again,
  not counted as done.
- **A cancelled or dismissed approval prompt is not the owner's refusal** (the Claude Code host test and #130; Python
  MCP server and CLI). With `ask`, any answer but approve was `owner_declined`, "your owner did not approve", also the
  `cancel` that headless Claude Code answers by itself. Now a prompt answered `cancel`, with an error or with another
  action, and an app that closed before an answer, is `approval_cancelled`: nothing was signed, nobody refused it,
  with console approvals (the command for this profile and the console's address) for an app that cannot show the
  prompt (`mcp_server.approval_cancelled`). `decline`, and accept without approve, stay `owner_declined`. `valun call`'s
  terminal prompt closed before an answer (end of input, Ctrl+C) is `approval_cancelled` too, and so is the tour's,
  which stops on it. The JS approve hook is a boolean and keeps its answer.
- **An approval prompt left open no longer freezes the other tools** (fix inbox #149, the first-tester readiness
  assessment of 2026-11-18; Python MCP server). With `ask`, on an app with the 2025-11-25 (or an earlier) handshake,
  `ask_owner` queued every other message until the prompt's answer came, so one prompt left open or abandoned froze
  every Valun tool until the app restarted, and the app's `notifications/cancelled` was ignored (observed with the
  official MCP SDK: `valun_status` and `valun_inbox` timed out; at the end of input the call said `owner_declined`).
  While a prompt waits, ping, the lists and the read-only tools are now answered at once; another call still waits its
  turn, and is dropped if the app cancels it meanwhile. The app's cancel of the call that asks ends the wait:
  `approval_cancelled`, nothing signed. A prompt nobody answers within 10 minutes (`APPROVAL_WAIT_S`, as long as a
  2026-07-28 approval stays valid) is given up: the call answers `approval_cancelled`, nothing signed. In both cases
  the prompt is withdrawn (`notifications/cancelled` for its request), and an approval that still comes signs
  nothing. The 2026-07-28 path never waited: its approval is a result (`input_required`).
- **Where `ask` cannot work, the agent and the owner are told** (the newcomer tests; Python). In an app that declares no
  approval forms (MCP elicitation) at initialize, `valun_status` said "your owner is asked through this app" while
  every commitment failed `approval_unavailable`. Its approvals text now says the app declared no approval forms, that
  nothing is signed, and the console command to tell the owner (`mcp_server.ASK_WITHOUT_FORMS`). `valun join
  --approvals ask` (the default) says no interactive app has been verified with the form yet, and names the console
  command for this profile.
- **`valun config approvals` to or from console asks for the owner token** (fix inbox #136 item 1; Python CLI). It
  refused without `--owner-token-file`, while the site tells owners to move that file out of their agent's reach once
  console is set. It now asks for the token at a terminal (not shown), reads it once and never stores it; without a
  terminal it says how.
- **Ctrl+C ends with a short message, never a traceback** (fix inbox #136 item 3; Python CLI). `valun sandbox tour`:
  "The tour stopped (Ctrl+C). Run `... sandbox tour` again to go on: it reads where your tour stands from the server
  and goes on from that step", exit 130; earn and buy say where the deal stands; any other command
  "valun CMD: stopped (Ctrl+C)." on stderr, exit 130.
- **`valun mcp --help` names the pinned uvx form only** (the newcomer tests; Python CLI). It showed
  `claude mcp add valun -- valun mcp` (a bare `valun`, which an app started without this shell's PATH cannot find) and
  an unpinned `uvx --from valun`, which runs the newest valun on PyPI. Its Claude Code, JSON config and Hermes lines,
  and its usage line, now pin this valun (`uvx --from valun==X valun mcp`, or the source it runs from), with where
  `claude mcp add` adds it and the join to run first.
- **`valun audit --mine` refreshes the client's records first** (fix inbox #86, the newcomer tests; Python CLI). An IOU
  approved in the owner console was issued after the agent's MCP session had ended, its record stayed pending, and
  `--mine` said `differs` (exit 3) until a `valun_status` read the edges. `--mine` now first reads `GET
  /pilot/v1/edges` from the profile's own server with the agent's token, as `valun_status` does (`Client.sync_edges`:
  every state checked against its issuer's signature before it is recorded; nothing signed), says so on stderr, and
  compares the records as they are when it cannot (another server, no agent token, the edges not readable now).
  `--no-refresh` keeps the read-only audit: no GET /edges, no token sent, nothing written.
- **Amounts in the network's unit, never PC** (the newcomer tests, fix inbox #77; Python CLI). `valun clearing run`
  printed "3000000 PC (your net change 0 PC)" and `valun status` "max_PC 50000000" on the testnet. The clearing lines,
  clearing status, `valun status` and `policy show` (the consent cap as an amount: "at most 50000000 nanoERG (0.05 tERG)
  each (consents.max_PC)"), join's approvals-none limits, the `join --help` and `sell --help` examples, and the tour's
  lines name nanoERG with tERG beside. `join --help` describes `--server` (default https://valun.tech, the public
  testnet; also `VALUN_SERVER`).

**Approvals, as they work** (Fitz's decision of 2026-11-17, fix inbox #138; the approval semantics verified against the
server's code and three staging probes the same day; both clients unless named):
- **What console holds, and what it never holds.** Console is not a server mode: it sets the owner mandate to
  approve_above 0 and review_deliveries on, and the client then signs at once and asks nobody. The server holds the
  agent's offers and counter-offers, its acceptances (taking a job included) and guarantee offers, and the IOU or payment
  by transfer it signs when it accepts a delivery. It never holds honoring a guarantee call (the agent's IOU, recorded at
  once), accepting, calling or releasing a guarantee, deliveries, declines, withdrawals, disputes, the agent loosening
  or clearing a limit it recorded with `valun_set_limits` (its agent token alone does that, never past the owner's
  mandate), or the consents the client signs by itself. 0.7.1 said "every commitment waits for your owner" in
  `APPROVAL_TEXT['console']`, join's and `valun config approvals console`'s lines, `approval_unavailable`,
  `approval_cancelled` and the MCP app's no-forms line (`ASK_WITHOUT_FORMS`). Each now says what is held and what is
  not, that the agent has already signed what waits, that approving signs nothing new (the server releases exactly what
  was signed), and that rejecting does not unsign it: the server keeps a rejected offer, acceptance or IOU on record (a
  rejected bound IOU could still be recorded by the tracker for an hour, so paying that deal by transfer waits until 1
  hour and 2 minutes after it was signed, the client's own window), while a rejected payment by transfer is deleted, its
  signatures included (the server keeps only their hashes: `purgeTransfer`), and may be paid again through the same
  IOU at once. The first RC stated the general rule with no exception, which `valun_deal` then contradicted.
  `APPROVAL_TEXT['ask']` names everything ask asks for (guarantee offers, honors and releases, payments by transfer and a
  loosened limit too), and `client-prompt`'s says that whatever the app lets run is signed. The JS `NO_APPROVAL_STEP`
  names the same commitments. Join's ask line offers console as holding the agent's offers, acceptances and guarantee
  offers, and the IOU or payment at each delivery (never an honor or a consent), no longer "what it signs".
- **valun_status says what the server holds by the owner mandate in force** (`agent.held_for_owner`, JS
  `heldForOwner`): after the mode's sentence, the console's address, and, unless the mandate is console's, what
  approve_above holds (guarantee offers by their cap) and, while review_deliveries is on (leaving console keeps it on),
  the IOU or payment at each delivery; never an honor. 0.7.1 named approve_above only, so an agent was never told its
  delivery IOU would wait.
- **Answers that wait for the owner say until when, and what each decision leaves.** A held IOU names the owner
  console's deadline for it (`decide_by`: a bound note's timestamp + 1 h - 60 s, when a server with valun-app's
  `HELD_NOTE_SEND_MARGIN_MS` ends its approval; the RC named the hour itself, a minute after the console's "Decide by")
  and the tracker's limit apart (`note_expires_at`, + 1 h): an IOU still held then is never recorded and pays nothing,
  and after that hour, on a server that ended nothing, it says to reject it, since an approval would fail and leave the
  delivery accepted and no longer disputable (approval probe D3); a held payment by transfer names when its
  hold ends (`hold_expires_at`, 20 minutes after it was posted) and that nobody else has signed it; a held offer, counter
  or acceptance names its offer's expiry, what the other side sees, and that it may still be withdrawn; a held guarantee
  offer says its cap counts while it waits and that every call is then paid with an IOU that is never held. Each names
  the command that opens the console (`console_command`, JS `consoleCommand`: `valun --profile NAME console` from the CLI
  and the MCP server), and the guarantee's approval (`approval_id`). An honored call says it was not held for the owner.
  The reply to an honor names the call the client honored (with no `call_id`, its first open or failed call, found in
  its own honor record), and the state the server answered for it: a note the tracker did not record leaves the call
  failed, with nothing more owed, and says so (the first RC named the last honored call, whichever it was, and called a
  failed honor honored).
- **valun_deal says whose turn it is while an owner decides** (`owner_turn`): 0.7.1 said "nobody: the deal is
  completion_awaiting_owner" while the agent's own owner held its IOU. A held IOU names the console's deadline and the
  tracker's limit (`decide_by`, `note_expires_at`, from the payer's `credit_note.note`), and once the tracker's has
  passed says to have the owner reject it, then accept the
  delivery again; a held payment by transfer names the end of its hold. The tour's plan (`sandbox_next_steps`) says the
  same of a held IOU, from the client's own record of it. A `note_failed` deal is the payer's to pay again (the
  delivery stays accepted: a dispute is refused), no longer "accept the delivery or dispute it". `owner_decisions`
  says what each rejected or void approval of the agent's leaves: an offer never shown, an acceptance not approved and
  the offer open again, an IOU never sent but still recordable for its hour, a payment by transfer deleted. Each says
  what may be paid now and from when the rest may, at the times this client allows (after a rejected IOU, a new IOU at
  once and a payment by transfer after its timestamp + 1 h + 2 min; after a rejected payment by transfer, a transfer
  through the same IOU at once and the payer's own IOU or another IOU after that time; `agent.free_after`), each time
  said to be the client's own, a minute after the server's that the owner console shows (`MARGIN_WORDS`); where the
  client holds no record of the attempt, the server's own wait, which ends once its journal shows that IOU moved past it
  (`attemptDeadByJournal`); and where its record could not be marked as not applied, that once that IOU moves past it
  the client pays the deal no more until the owner resolves it, as 0.7.1 did. The first RC said such an attempt "does
  not stop a new payment", and named T + 1 h, a time at which the client still refuses. Next
  steps are given only for the last of each kind, while the deal's status still fits them; otherwise a past-tense line
  says when it was decided and that the deal has moved on. A confirmation the acceptance voided
  (`void_acceptance_rejected`: the acceptor's owner rejected it, and the offer is open again) is no longer described as
  the offer withdrawn, and one sentence describes each way a hold ends (rejected, stale, a key revoked, expired). New
  `counterparty_owner_decisions` (JS `counterpartyOwnerDecisions`) tells the other side, from the deal's shared history:
  the payee that the payer's owner rejected its IOU or payment, the proposer that the acceptor's owner did not approve
  the acceptance, the acceptor that the proposer's owner withdrew the offer.
- **An IOU or payment by transfer the owner rejected, or the server voided, is not applied** (the approval probe's D2;
  `Client.learn_owner_decisions`, JS `learnOwnerDecisions`). 0.7.1 and the first RC kept it as a live payment attempt:
  once the pair's IOU moved past it (a set-off, or a transfer its client signed as issuer) they refused to pay the deal
  again, `attempt_outcome_unknown`, until the owner ran `valun attempts resolve`. A held payment records the id of the
  approval that holds it (`approval_id`); `complete`, `pay_by_transfer`, `valun_deal` and `valun attempts list`
  (`refresh_owner_decisions`) read the deal view, and an attempt whose approval was rejected or went void, or an IOU the
  tracker refused for its age after a late approval (`note_failed`, `novation_expired`), gets outcome `not_applied` with
  `server_ended {state, approval_id, at}`, and its pending entry is forgotten. A record from before (no approval id) is
  matched only to the one approval made within 10 minutes of its timestamp. On the server's word, the trust console
  approvals rest on: the hold itself is the operator's. In `novation.attempt_outcome` such an attempt is dead once its
  edge is past its timestamp, as well as after its window; an owner's own resolution keeps the window, unchanged. So the
  deal is no longer blocked for good once the pair's IOU has moved past it; until then, or until its window has passed,
  it still blocks the payments it excludes (above). The trust this rests on is stated in python/README.md: an operator
  that sent a held IOU on anyway and reported it rejected could have the deal paid twice once that IOU moves on.
  `valun attempts list` shows it as not applied, why (one clause per way it ended: one approved after its hour was
  sent and refused, never "never sent"), and what may be signed now by its route (after an IOU, a new IOU; after a
  payment by transfer, a transfer through the same IOU at the same prior state, never a new IOU: the first RC said one
  could be signed, and the client refused it) and from when the rest may. No signed format changed.
- **`valun join --sandbox` uses console approvals when `--approvals` is not given** (Python). Ask has been shown in no
  interactive app, and an app that cannot show its form fails every commitment; console is the setup that has run end to
  end. An invited join still asks by default (the operator's participants, whose owners choose). `join --help` says what
  each mode does. The commands join prints name `--approvals` only when it was given and is not that default. In console
  mode `valun sandbox tour` asks nothing at the terminal (the console holds each step: asking there too would ask twice)
  and says where its steps wait, its payments by transfer included, which wait 20 minutes only; it first reads the
  owner mandate (GET /me), and asks at the terminal as in the other modes when the mandate no longer holds every step
  (Ask me above raised, or Review deliveries unticked, since). While console approvals hold every step, a commitment
  outside the tour's own rules stops it with words for console (`tour_unverified`), not "run it without --yes".
  `valun sandbox earn` and `sandbox buy` say where a held offer, acceptance or payment waits, and `buy` stops on an
  offer the owner rejected. `tour --help` says
  `--yes` approves at the terminal only what the tour's rules allow, each step still held with console approvals.
  `valun console` no longer asserts what Ask me above is (it reads nothing): it says what valun set it to, and that the
  console shows it. Unattended flows: `valun sell` refuses to start, before any model call and before it changes the
  public services, while the owner mandate holds an acceptance at its prices (console sets Ask me above to 0), since it
  does each job with Claude before it accepts; its help, python/README.md and examples/ai-seller join with
  `--approvals none`. A script or harness that joins without `--approvals` and runs `sandbox tour --yes` unattended
  gets console approvals from 0.7.2, and its steps then wait for an owner: give it `--approvals none`.
- **The owner token ends up in a file the owner can find** (Python): without `--owner-token-file`, join writes it to the
  new private file `$HOME/valun-owner-token-HANDLE.txt` (0600; never one that exists) instead of the screen an agent may
  be reading, says where it went, and the profile keeps that path (never the token) for `valun console`. A file there
  already, or a folder that cannot take one, is refused before anything is sent, as for a file given (the fresh-join
  run of 2026-11-18, above). `valun config approvals` to or from console
  records the file it read. On Windows, where a file mode is ignored, the file is created with permissions that let in
  only you (your account, named by its SID), SYSTEM and Administrators, whatever its folder allows (the RC's staging
  test: it took its folder's permissions), so it still opens from a normal shell after an elevated join; join says so
  when Windows could not make it private (a drive that keeps no permissions, such as WSL's share, or one that lets
  everyone in, such as FAT32 and exFAT).
- **On Windows, profiles stay private and open from a normal shell after an elevated run** (Python). 0.7.1 wrote a
  profile file that took its folder's permissions, and on a Python with the CVE-2024-4030 fix (3.12.4 and later, and
  the 3.10 and 3.11 security releases since: 3.10.22 and 3.11.18 checked) the profiles folder 0.7.1 made lets in only
  SYSTEM, Administrators and the file's owner, which is Administrators for a file an elevated run (Run as
  administrator) saved: from a normal shell neither valun nor an MCP app could read that profile again. The profiles
  folder valun makes, and every profile file it writes, now name your account's SID. doctor reads the profile file's
  owner and permissions before it calls them private (0.7.1 said "private" without looking), names who else they let
  in by account name (whom its folder lets in, or its own permissions), says "no profile file yet" when there is none
  and then reads its folder, reads the owner token file the profile records, and says when this user may not read a
  profile an elevated run made, with how to take it back, never to join again. So does every command when this user
  may not open the profiles folder itself (0.7.1's first run was elevated): from a normal shell its profile looked
  missing, so 0.7.1's doctor called it private and said "Approvals: ask" and "Not connected" with a join, status
  "(not joined)" and "approvals: ask", and the tools `not_connected`, and the join they named made a new participant
  that could not save its key there; now nothing is sent, and the text names the folder and how to take it back. A profile whose folder this user may
  not add a file to is `profile_unwritable`, naming that folder, not `profile_busy`. A `VALUN_HOME` (or default
  folder) this user may not make the profiles folder in, a read-only or protected place, is said so in one line that
  names the folder, by every command and doctor, and nothing is sent (the RC's review, round 3: each ended in
  "PermissionError: [WinError 5] Access is denied.", which named no path; 0.7.1's traceback named the folder). A
  join into a profiles folder this user may list but not add a file to (a read-only grant, or Windows Security's
  Controlled folder access) is refused before anything is sent, naming the folder and its fix, and doctor says the
  same for a profile not there yet, never that its folder "lets in only you" (the RC's review, round 3: the join made
  its participant on the server, then could not save the agent's key; 0.7.1 enrolled the key, then lost it). The `icacls` commands it prints to
  close a file or folder run as printed in cmd and in PowerShell, and remove an entry set on that file or folder itself
  for another account too, not only what it inherits.

**After the RC's staging test of 2026-11-18:**
- **The agent's and the owner's tokens go only to the configured server, and in clear text only on this machine** (both
  clients; Python first). 0.7.1 copied the `Authorization`
  header onto a redirect, to whatever scheme, host or port it named, and returned that address's answer as the
  server's (a POST answered 301, 302 or 303 went on as a GET elsewhere, with the token, and that GET's answer was the
  write's result). No redirect is followed now: a 3xx is the error `redirected` (its HTTP status, extra `location`: the
  scheme and host it pointed to, never its path; nothing was done), and doctor, `valun join` and the tools say so,
  with the address to use if it is the server (`valun config server URL`), never "refused" or "not connected" (the
  RC's review: an `http://` URL of a host that moves every request to `https://` came back as a 401, which doctor
  called a refusal of this agent). The JS client, which refused redirects already, says `redirected` too, in the same
  words (fetch does not show where a refused redirect pointed), where 0.7.1 said "cannot reach ...: fetch failed".
  And a request that this machine's proxy handling would send elsewhere than the
  configured server's scheme, host and port is refused before anything is sent (`unreachable`, cause `not_connected`,
  `transport_error: DestinationRefused`).
  Plain http: 0.7.1 sent the tokens over plain http to whatever host an `http://` server URL named, and through this
  machine's proxy. Now a token goes over plain http only to a server on this machine (127.0.0.0/8, ::1, `localhost`),
  which is never reached through a proxy (below). Only the name `localhost` itself counts: `localhost.`, with a final
  dot, is a name glibc asks DNS for, not `/etc/hosts`, so it is another machine (the RC's review, round 3: both clients
  counted it as this one, and on Linux the token went in clear text to whatever address DNS gave). To an `http://`
  server on another machine, nothing that carries a token, or whose answer carries one (a join, an enrollment), is
  sent: the error `plain_http` says so, and names its `https://` address. Only the person running the client can opt
  in, with `VALUN_ALLOW_PLAIN_HTTP=1`; a request with no token (`GET /info`, the public directory) goes as before.
  `valun doctor` flags every `http://` server: one on this machine with an ok line, one elsewhere with a FIX line that
  names that opt-in and says that tokens then cross the network in clear text.
  A server setting that is not an `http://` or `https://` URL with a host (`http://`, `http:`, `HTTP:/`, `https:`), or
  that has a user name or password, a query or a fragment, is refused by both clients wherever it is set or used, and
  nothing is sent: `valun config server` (nothing is changed), `--server`, `VALUN_SERVER`, a join, a profile's own
  server, and the JS client's `server` option and `state.server` (`unreachable`, cause `not_connected`, in words that
  name the setting and never repeat a password; doctor and status say it too). A path is kept (a server behind a
  prefix), and a request path that does not start with `/` is `bad_arguments`. The RC's review, round 3: a server
  with no host is not a URL on its own, so the JS client's checks above never judged it, but `server + path` was one
  whose host was the path's first segment (`http:` + `/pilot/v1/me` is `http://pilot/v1/me`), so the JS client sent
  the agent's and owner's tokens, joins and enrollments in clear text to whatever the name `pilot` reached, and
  `valun config server http://` stored `http:` without a word.
  In JS, Node's own fetch sends every request through the process's global dispatcher, whose
  proxy and certificate settings apply to the client's requests, and takes no per-request proxy setting (that needs an
  undici dispatcher, which Node does not export), so the client judges from that dispatcher, not from the environment
  (the RC's review: an application's `setGlobalDispatcher(new ProxyAgent(url))`, and `HTTP_PROXY` removed after Node
  started, sent the token for a server on this machine to the proxy in clear text). That is the dispatcher each Node's
  fetch reads: undici 8 (Node 26) keeps it in another place than undici 5 to 7 (Node 18 to 25), with a
  `Dispatcher1Wrapper` of it in the old one (the RC's review, round 5: the client read only the old place, so on Node
  26 it took that wrapper for an application's dispatcher, and once the process had made a fetch it refused every
  token to a server on this machine, with `NO_PROXY` naming it too; and it missed a global dispatcher that checks no
  certificate, set as undici 8 sets one, on Node 26, and on older Nodes where npm's undici 8 set it). Where it is
  Node's environment proxy (`NODE_USE_ENV_PROXY=1` or `--use-env-proxy`, with the http proxy Node read when it
  started), a token is not sent over plain http to a server on this machine that `NO_PROXY` does not name, as undici
  reads it: name the server there as its URL does (`[::1]` with its brackets). An entry that starts with `*` names a
  host only as `*` alone or as `*.` and a domain, as undici 6, 7 and 8 all read it (found while fixing the RC's
  review, round 5: undici 7 and 8, Node 24's and 26's, read `*0.0.1`, and undici 7 `example.com,*`, as no name, so
  Node 24's fetch sent the token for 127.0.0.1 through the proxy in clear text where the client took it as named).
  Any other dispatcher than Node's own `Agent` may proxy everything,
  so there a token goes over plain http only with `VALUN_ALLOW_PLAIN_HTTP=1`; so may an `Agent` composed with
  interceptors (the RC's review, round 4: undici 7's `compose()`, Node 24's own, keeps the class name `Agent`, so the
  client judged it as Node's own, and an interceptor carried the agent token through a `ProxyAgent` in clear text; the
  TLS settings of a dispatcher an interceptor sends through are not judged). Over https, while Node checks no
  certificate (`NODE_TLS_REJECT_UNAUTHORIZED=0`, or a global dispatcher made with `connect.rejectUnauthorized` false,
  with which 0.7.1 and the RC sent the agent token to a server this machine does not trust, or with undici's `tls`
  option so, which the RC did not read on any Node), nothing that carries a
  token, nor a join or an enrollment, is sent (`tls_unverified`), as the Python client, which always checks, never
  does; a certificate authority this machine lacks goes in `NODE_EXTRA_CA_CERTS`. Through a fetch passed in
  `options.fetch`, whose proxy and TLS settings the client cannot see, it is sent as asked (Node's own fetch passed
  there is judged as Node's own). A `globalThis.fetch` that is not Node's own (an application's or a library's
  wrapper, or the fetch of Deno, Bun or a browser) is not judged by Node's dispatcher, which it need not use (the RC's
  review, round 4: an application's wrapper that passed a `ProxyAgent` of its own carried the agent and owner tokens
  through that proxy in clear text to a server on this machine): a token goes over plain http to this machine through
  it only with `VALUN_ALLOW_PLAIN_HTTP=1`, and since its own TLS settings are unknown to the client, over https only
  what holds for every fetch in the process is judged, as for Node's own. An application that routes fetch elsewhere
  should pass that fetch as `options.fetch`.
- **A joined profile's tokens go only to its own server** (Python): the server its profile file names. 0.7.1 sent them
  wherever a command's `--server` pointed: `valun doctor --server URL` sent the agent token there and reported "Agent
  accepted by the server" for it, `valun config approvals ... --server URL` sent the owner token there and changed that
  server's mandate, and `valun console --server URL` sent the owner to sign in there with this profile's owner token,
  without a word. Now a request that carries a token is refused before anything is sent when it is for another server
  (`wrong_server`, naming the profile's server and `valun config server URL`, which moves a profile); a read that
  carries none goes as before. doctor says when `--server` is not the profile's server, checks only what needs no
  token there, and does not check the agent; `valun console` names the address it opens, and the profile's own. A
  profile's own server that is not a server URL itself (one with a user name and password, which 0.7.1's `valun config
  server` and join stored) is never named in these: the refusal, doctor and console say what `valun status` says of
  it, and never repeat it (the RC's review, round 4: the `wrong_server` words, its `profile_server`, doctor and console
  printed it, its password included).
- **Each `Client` sends its requests through an opener of its own** (Python, `client.server_opener`): this machine's
  proxy settings (`urllib.request.getproxies()`), http and https with the server's certificate verified against the
  CAs this machine trusts (`tls_context`), and no redirect followed. So nothing a process sets for urllib applies to a
  request that carries a token any more (the RC's review): an opener another library installed with
  `install_opener`, whose handlers could skip certificate checks or send a request on after an answer (an embedding
  application's `ProxyBasicAuthHandler`), or `ssl._create_default_https_context = ssl._create_unverified_context`,
  with which 0.7.1 sent the agent token to a server whose certificate this machine does not trust. A server on this
  machine (127.0.0.0/8, ::1, `localhost`) is always reached directly, never through a proxy: urllib's `<local>` bypass
  of the Windows system proxy does not cover 127.0.0.1, so 0.7.1 sent a local server's token to the proxy in clear
  text.
- **A proxy setting Python cannot use is named by its scheme, never quoted** (Python): a proxy URL with one slash after
  its scheme (`HTTPS_PROXY=http:/user:pass@host:3128`, a typo) made urllib raise a `ValueError` that quotes the whole
  URL, and 0.7.1 let it out as it was: doctor printed the proxy's user and password in its FIX line, which testers paste
  into reports, `valun call` and the MCP tools returned them to the model in an `internal_error`, and `Client.me()`
  raised that `ValueError`. Now such a request is `unreachable` (cause `not_connected`, `transport_error:
  ProxyRefused`), nothing was sent, and doctor says which proxy setting to correct. Any other `ValueError` urllib raises
  before sending is `unreachable` too, naming its class only, and the tools' `internal_error` for an exception they did
  not expect never repeats a URL's user and password or a token from its words (both clients). An `https://` proxy URL
  with a user and password is refused the same way for an https server: Python reaches every proxy without TLS, so
  0.7.1 sent its CONNECT, with those credentials in `Proxy-Authorization`, in clear text to the proxy, although the URL
  says https (the agent's token stayed inside the TLS to the server; Node reaches such a proxy over TLS). One without
  a user and password is used as before, and doctor says, by scheme only, that Python reaches it without TLS.
- **`valun sandbox earn` and `valun sandbox buy` print each line when it happens** (Python CLI), as the tour does.
  Through a pipe, as an agent reads a command's output, they printed nothing until the command ended (0.7.1 too), so
  the RC's "your offer waits for you in the owner console" arrived after the owner had approved it. A reader that
  stops early (`| head -n 1`) stops nothing. Windows PowerShell's `| Select-Object -First N`, though, ends the command
  once it has N lines, and the deal with it (0.7.1, which printed nothing until the end, ran on): `sandbox buy` after
  its offer was sent, before the delivery is checked or paid; `sandbox earn` after it accepted the job. Write the
  output to a file to keep part of it (`> earn.txt`); `valun call valun_inbox` shows where a stopped deal stands.
- **Printed commands quote a value with double quotes**, which Windows cmd, PowerShell, bash and zsh read alike (Python
  CLI): `"#1"` where 0.7.1 printed `'#1'` (and `valun attempts list` says to write an attempt so: 0.7.1 said `'#n'`,
  whose single quotes cmd passes on, and which the client then refuses), and the join's next commands (`--operator
  "Two Words"`, `--owner-token-file "C:\..."`), where the RC's single quotes failed in cmd. Where the owner token file
  cannot be named so, the commands say `FILE` and what it is. A value with a `"`, `$`, `` ` ``, `!`, `%` or a curly double
  quote (`“`, `”`, `„`, which Windows PowerShell reads as `"`), a doubled or final backslash, or an empty value, is named
  apart ("with the same --operator as before"), and the join that the hints of a profile that has not joined print
  names no owner token file: join writes its own default one (a `"$HOME/..."` there reached the join as that very text
  from cmd).
- **`valun doctor` before a join names the approval mode the join it suggests will use** (console for `join --sandbox`,
  unless `--approvals` says otherwise), not "Approvals: ask", and `valun status` says `approvals: (not joined)` there
  (0.7.1 said ask); on Windows doctor reads the profile's permissions (above).
- **The CLI prints any text, whatever stdout's code page** (Python): on Windows a stdout that is not a console (an agent,
  a pipe, a file) writes the ANSI code page, with an error handler that fails on a character it lacks, and a path with
  one (a home folder named outside cp1252) made `valun join` end in `UnicodeEncodeError` at the owner token file's
  line, before the agent's key was saved, or, where the file could not be written, before the owner token was shown;
  0.7.1 failed so for `--owner-token-file` and at "Credentials are stored privately in ...", and doctor and status at
  the lines that name the profile or its folder. Such a character is now printed as a `\u` escape, and a
  printed command that would carry one names that value apart instead (`--owner-token-file FILE`, saying what FILE
  is) (the RC's review; the RC's first fix changed only a stream whose handler is `strict`, which Python on Windows
  never gives a pipe).
- `help(valun)` describes the testnet, not the retired pilot.

**Also in this release:**
- **A join or enroll whose answer is lost no longer loses the agent's key** (the tester report of
  2026-11-17; Python). With 0.7.1 the answer to `valun join`'s enrollment was lost on the way (RemoteDisconnected)
  after the server had registered the key. The key had been made in memory only and was saved with the agent token from
  that answer, so it was lost, and the server held a key no one had. The participant could act only after its owner
  revoked that key in the owner console and enrolled again. Now:
  - `Client.enroll` saves the key and the enrollment code in the profile before it sends the request
    (`pending_enrollment`; FileStore profiles only: the Hermes plugin's store and others are served as before), and
    removes them once the key and token are stored, or on a refusal that shows no key was registered.
  - While no answer is read (the connection broke or timed out, a body cut short, a 5xx: `client.answer_unread`), it
    sends the same request again, 3 times in all (`ENROLL_TRIES`, `ENROLL_RETRY_S`). When the first one never
    reached the server, the second registers the key.
  - When the server registered the key and answers no token again (today's server), the code is refused
    (`invalid_enrollment`). The client then reads the public directory, and when it names this key the answer is
    `enroll_token_lost`, with what happened and the way out: revoke this agent, then enroll with the new code. 0.7.1
    said "the key could not be stored here". A server with valun-app `fix/enroll-retry` answers a new agent token for
    the same key and code while the agent was never seen (`enrolled_again`), and the key is adopted.
  - When no answer arrives in 3 tries (`enroll_unconfirmed`), the key and the code stay in the profile. `valun join`
    again (the same command) or `valun enroll` (no code to give) sends the same enrollment again, without making a
    second participant: a retried join with the same handle answered `handle_taken`. A join again with another
    `--handle` or `--server` is refused, and `valun doctor` names the enrollment that did not finish.
  - A join whose own answer is lost says so, where 0.7.1 ended with a traceback (and keeps the agent's key, with the
    hold contract's words: see First use above). `handle_taken` says how to finish a join of your own that stopped.
- **`valun enroll` signs for the server's network, says what a 403 is, and writes a join's settings** (the Nov 17 tester
  report; Python CLI).
  - A new profile signed its enrollment for the retired pilot (`valun-pilot-1`, the client's default), and the
    testnet answered 403 `bad_signature`, which nothing explained. 0.7.2 read `GET /pilot/v1/info` once and kept the
    pilot when that read failed. Now enroll reads it with the transport's own read retry (an answer cut on the way is
    read again, up to 3 tries), and signs for the network it names, else for the profile's own, else for
    `valun-testnet-1`, the one network, never the pilot's.
  - A profile of another network than the server's is refused before anything is signed or sent.
  - A refusal says what it is and how to finish. `bad_signature`: the proof signs the network, what this profile
    signed for and what the server serves; the code is still valid. `invalid_enrollment`: the code is wrong, used or
    expired, and how to get a new one. A 403 whose explanation did not arrive: both causes.
  - Once enrolled, the profile gets the settings `valun join` writes for its kind of participant. 0.7.1 wrote none, so
    a sandbox participant enrolled that way signed no set-off, declared no consent role, and the tour stopped at step
    3 until its owner wrote the sandbox consent policy by hand. The kind is read from `GET /pilot/v1/me`, else from the
    public directory. A sandbox participant gets the sandbox consent policy and `consent_loop on`, an invited one the
    invite policy. A policy the profile already has is kept, and when the kind cannot be read the output says so.
  - An answer lost on the `GET /info` after a successful enrollment (the pin) no longer ends the command with a
    traceback.
- **A redemption whose box moved answers `reserve_busy`, with the wait** (fix inbox #123; Python). Right after a
  broadcast the node refused as a double spend (the reserve's or the tracker's box changed since the server built the
  redemption), `valun ergo redeem` read the spent box and printed the node's raw 404 (`node_error`). It now answers
  `reserve_busy` (cause `box_moved`, `retry_after_ms` 180000): nothing was spent; build it again in about 3 minutes.
  The server answers the broadcast's double spend the same way (valun-app, #123).
- **A dispute of a deal with no delivery answers `not_delivered`** (fix inbox #58, #122; Python). Disputing an agreed
  deal whose payee never delivered (`valun_review_delivery` with `decision: dispute`) raised `KeyError: 'delivery'`,
  which the agent answered as `internal_error`; Basis's daily sweep met it on a deal past its deliver_by. Now
  `not_delivered` ("nothing has been delivered on this deal"), before anything is signed or sent, as the JS client
  already answered.
- **A profile of the retired pilot network** (fix inbox #30, the onboarding review; both clients). The pilot
  (`valun-pilot-1`) was retired on 2026-11-13, and valun.tech serves the testnet. A profile made for the pilot (it
  names `valun-pilot-1`, or, enrolled before 0.5, no network) met only refusals there: `valun status` looked healthy,
  `valun doctor` sent its owner to `config server` and `enroll`, the agent's hint to `join`, and in that profile both
  join and enroll are refused. Now, where the profile's server names another network (one `GET /pilot/v1/info`):
  - `valun doctor` gives one FIX line: the profile joined the pilot, which was retired on 2026-11-13, the server now
    serves valun-testnet-1, which knows neither this participant nor its key; then how to go on. That is a join in a new
    profile (`--profile testnet` while that name is free, else `NAME`), with a new owner token file, or the profile
    `testnet` when it holds an identity on that network already. doctor no longer checks the pins or the agent against
    that server.
  - `valun status` reads `GET /info` for a profile of the pilot only, and then prints
    `network: valun-pilot-1, retired on 2026-11-13 (... now serves valun-testnet-1)` and the same line. Every
    profile's status has a `network:` line now.
  - The agent answers `network_retired` in place of the refusal such a profile meets (`unauthorized`,
    `not_connected`, `tracker_mismatch`, `wrong_network`, `wrong_tracker`, or `approval_unbound` with one of them as
    its cause), from `call()` and `prepare_or_refusal()`, so also in the MCP server and `valun call`. Its
    `what_this_means` names the command (`rejoin_hint`: `valun call` and `valun mcp` pass this profile's). A server
    that still runs the pilot, or whose `GET /info` cannot be read, leaves the refusal as it is.
  - Nothing is signed there, as `network_retired` and doctor say (the onboarding build's review; both clients). A
    profile of the pilot without pins (`config server URL` removes them, which 0.7.1's doctor advised, and a profile
    unused since before pins has none) signed and sent an offer or a guarantee offer, which the server refused, and
    got the testnet's tracker pinned. Now a server that names another network than the profile's is refused before
    anything is signed (`wrong_network`, answered as `network_retired`): `GET /info` never pins an enrolled profile to
    another network's tracker, the terms of deals and guarantees are built and checked only against a server of the
    profile's own network (the JavaScript check compared only a network the profile named, so it missed a profile
    enrolled before 0.5), and the owner is not asked to approve such a commitment.
  - Python: `valun.client.profile_network()`, `retired_pilot()`, `TESTNET`, `PILOT_RETIRED_ON`; `valun.agent`
    `RETIRED_CODES`, `DEFAULT_REJOIN_HINT`, `retired_text()`, `ValunAgent(rejoin_hint=)` and `ValunAgent.retired()`;
    `mcp_server.run(rejoin_hint=)`. JavaScript: `profileNetwork()`, `retiredPilot()`, `PILOT_RETIRED_ON`,
    `RETIRED_CODES`, `DEFAULT_REJOIN_HINT`, `retiredText()`, the agent's `rejoinHint` option and `retired()`.
- **`valun mcp` before a join speaks the testnet's words** (fix inbox #15, the onboarding review; both clients). The
  Claude Code plugin starts `valun mcp` before its user joins, and until the join the tools described the retired
  pilot, with prices "in PC (whole pilot credits)", where a price of 3 is 3 nanoERG. A profile that has not joined yet
  is now on the one network it would join (`profile_network()`: valun-testnet-1): `schemas.for_network(None)` and
  `forNetwork(null)`, the MCP server's instructions and `tools/list`, `valun tools`, `valunTools()` and the argument
  refusals use the testnet's words. A profile of the pilot keeps the pilot's. `Client.network`, what a profile signs
  for, is unchanged. No `notifications/tools/list_changed` follows a join: the server reads the profile when it starts
  (the plugin's skill asks for a Reconnect after the join), and the words before and after a join on the testnet are
  the same.
- **`valun enroll` of a profile that names no network** (the onboarding review; Python CLI). A new profile, or one whose
  join stopped before the agent's key was stored (join's own "To finish" runs this command), signed its enrollment for
  the pilot, the client's default, and a testnet server refuses that signature (`bad_signature`). `valun enroll` now
  reads the server's `GET /pilot/v1/info` first and signs for the network it names; when it cannot be read, as before.
- **`approval_unavailable`'s commands run as written** (fix inbox #88, the onboarding review). The MCP server's answer
  to a commitment where the app cannot ask (no MCP elicitation) named `config approvals console` without
  `--owner-token-file`, which `valun config` refuses, and offered `client-prompt` as if it always asked. It now names
  `... config approvals console --owner-token-file FILE`, `... config approvals client-prompt` with its condition (it
  asks only in an app that confirms each tool call itself, as Claude Code is designed to, not yet tested with Valun: an
  app that runs tools without asking asks nobody) and `... config approvals none`, and says to restart the app's Valun server, which reads the mode when
  it starts. `valun config approvals` says so too, and `join --approvals client-prompt` and doctor give client-prompt's
  condition (`cli.CLIENT_PROMPT_CAVEAT`). Before a join, when no owner token exists yet, a commitment answers
  `not_connected` with the join hint instead, as `valun_status` does (the onboarding build's review): in the MCP
  server's two paths, in `valun call` without a terminal (`mcp_server.not_joined()`), and in `valunTools()` without an
  approve hook.
- **A profile that cannot be read** (the onboarding review; Python CLI). A profile file that is not UTF-8, not JSON or
  not a JSON object ended `valun doctor`, `valun status` and every other command with a traceback. doctor now gives a
  FIX line (the file, why, "Nothing was signed", and to restore it from a backup or move it aside and join again in a
  new profile) and still checks the server; status says the same and exits 1; every other command says it on stderr
  and exits 1 (`valun audit` exits 2, as before). On Windows a profile another program has open without sharing it (a
  backup or sync tool, an editor: a sharing violation, which 0.7.1 ended in a traceback too) is said to be open there,
  to close it and run the command again, never to join again (the RC's review). Also, doctor no longer checks the
  agent against a server it cannot reach: it said "The server refused this agent (unreachable): ... enroll again".
- **Fix inbox #58: arguments of the wrong type** (both clients). 0.7.1 checked only that arguments were present and
  formed a JSON object. A string argument given a number, a list or an object still failed later with `internal_error`:
  Basis counted 33 (18 in Python, 15 in JavaScript), among them `valun_propose` `counterparty` 42, a `description`, a
  `valun_respond` or `valun_review_delivery` `reason`, a `valun_directory` `query`, and (Python) a `deal_id`
  `{"a": 1}`. Now the core's single check (`tool_arguments` / `toolArguments()`) also checks each argument given (not
  null), in the schema's order, before anything is read or signed:
  - a string is a string, an integer is a JSON integer that JavaScript can hold exactly (not `true`, `1.5` or `"7"`),
    and a boolean is `true` or `false`;
  - a value with an enum is one of its values, and `valun_set_limits` `clear` is a list of limit names;
  - `deal_id` is `vd_` + 16 hex, `guarantee_id` `vg_` + 16 hex and `call_id` `vgc_` + 16 hex, the shapes the server's
    routes take; `valun_offer_guarantee` `deals` is its list of 1 to 10 deal ids.

  The first argument that does not fit is refused, naming it and what it must be. Where a tool already refused a wrong
  type, its code and words are kept: `bad_role`, `bad_action`, `bad_decision`, the price and amount words in the
  network's unit, `valun_directory`'s `limit` and `offset`, the guarantee tools. The others answer `bad_arguments`
  `<name> must be a string (...), not <value>`, or `a whole number (a JSON integer)`, or `true or false`. Only the type,
  the values and the shape are checked: how many, how long or how large stays each tool's own check. Answers that change:
  - Basis's 33 calls answer `bad_arguments`.
  - A `deal_id` that is not a deal id is `bad_arguments`: 0.7.1 answered `not_found` (Python) or `bad_id` (JavaScript).
  - A `title` or `deliverable` of another type is `bad_arguments`, where 0.7.1 answered `missing_text`.
  - `valun_set_limits` refuses `goals` 42 and a limit `"60"`, which 0.7.1 recorded as `"42"` and `60`.
  - `clear` with a name that is not a limit is refused; 0.7.1 left it out.
  - `valun_deliver` refuses a `send_anyway` of `"false"`. 0.7.1 took it as true and sent the draft.
  - The adapters that ask the owner answer the call's own refusal instead of asking (`prepare_or_refusal`), also for a
    misspelt enum, which 0.7.1 answered `approval_unbound`. `prepare()` still refuses it, with the refusal's code as its
    cause.
  - Python: `valun.agent.tool_arguments(name, args, unit=...)`, `argument_refusal()`, `ValunAgent.tool_arguments()`
    (with the profile's unit), `PROPERTIES`, `ID_SHAPES`, `ENUM_REFUSALS`, `PAGE_WORDS`.
  - JavaScript: `toolArguments(name, args, unit)`, `argumentRefusal()`, `agent.toolArguments()`, the same constants.
    An adapter that calls the module function itself passes its network's unit, or the words say PC.

  The release's review added:
  - `valun_propose` and `valun_respond` counter refuse `deliver_within_hours` above 720 and `offer_valid_hours` above
    168 (the schemas' maximum, and the server's 30 and 7 days) with `bad_arguments`, before anything is read or signed.
    0.7.1 signed such terms for the server to refuse, put them before the owner, or answered `internal_error` on hours
    too many for a date. `HOURS_MAX` in both cores.
  - `valun_status` `{"brief": null}`, and a guarantee tool's optional hours given as null, take their defaults: null
    is not given, as the type check reads it.
  - `valun_set_limits` refuses a limit with a fraction part, which 0.7.1 recorded truncated (`40.5` as 40; a floor
    such as `min_price_as_payee` 4.5 as 4, looser than asked). The Python client also refuses `40.0`, as it has refused
    a float for every whole-number argument since fix inbox #22; `JSON.parse` gives `40.0` to the JavaScript client as
    40.
- **Fix inbox #86: `valun audit --mine` after a clean happy path.** After Basis's path (`valun sandbox earn`, a loop of
  three 2,000,000 deals, `valun clearing run` in each profile) 0.7.1 exited 3, "0 of 3 edges proven". The welcome note
  was not in the records, and they did not show the set-off's after-state. Now:
  - `valun sandbox earn` (and `valun.sandbox.sell()`), once the buyer has paid, reads this profile's edges back, as
    `valun_status` does (`Client.sync_edges`). The records then hold the note it was paid with, under its issuer's
    signature. A server that cannot show the edges, or a profile that cannot be written then (a full disk), leaves the
    records as they are, and says so: the payment stands.
  - A consent the client signs (`valun clearing run`, the MCP server's consent processing; both clients) keeps the
    signature the client made over each new state it wrote ahead, before anything is sent (`records.note_signature`
    / `records.noteSignature`). On an edge it issues that is the issuer's signature; on one it is the creditor of, its
    consent. When the server answers `applied`, the states it issues become confirmed with that signature.
  - `--mine` has a new proven status, `netted`: the anchored total is the after-state of a set-off this client signed,
    its own signature on it verifies, and the set-off reached the box on every edge this client signed in it (each
    anchored at the total it signed there, or confirmed in its records at that state or a later one). A set-off that
    the tracker refused, that expired, or that moved only some of its edges proves nothing, even where an edge's
    anchored total happens to be the one signed, and so does one of which the records know fewer than two edges. The
    line reads "netted by vs_..., signed by you". When a confirmed state came from such a set-off, `signed` adds
    `netted_by` too. `valun audit` gives the audit this profile's `signed` records: operations and totals, no
    signature. JSON: `netted_by`, and `netted_state` `{total, timestamp, signed_by, as}`.
  - A consent the server answers `409 already_signed` (another consent run of this profile sent the same slots, such
    as the MCP server's consent loop and `valun clearing run` at once) keeps its pending entries and their signatures
    (both clients): the server holds this client's signatures, so they are the states those sign. Another refusal
    removes them, as before.
  - Plain `valun audit` against a server without `GET /pilot/v1/ledger/committed`, while the ledger is ahead of the
    box: UNKNOWN (`not_anchored`) now says that this server has no committed-snapshot route yet. The older route
    compares only while the published ledger is the anchored state, so run the audit right after a tracker box, or
    pass `--wait-anchored`.
  - A note earned with 0.7.1 is not in the records until the client reads its edges back: 0.7.1's `valun sandbox earn`
    did not, so 0.7.2's `--mine` still flags such a note, with exit 3: `differs` (your records hold the edge's earlier
    total) when the client had read that edge back before, as the tour and `valun_status` do; `not_in_records` when it
    never had, as after an earn right after a join (the clean-user test and the 0.7.2 review saw both). A
    `valun_status` read (`valun call valun_status`) or a later `valun sandbox earn` with 0.7.2 brings it in. 0.7.2 fixes
    the exit 3 only for the notes it takes.
- **`valun call` and the other JSON the CLI prints escape what stdout cannot encode** (`\u...`, the same JSON). A
  redirected stdout on Windows writes the ANSI code page: a character a server or a counterparty wrote (an offer's
  title in `valun_inbox`) failed the print after the call ran, and the agent got a traceback instead of its answer
  (in 0.7.1 too).
- **The sandbox tour's step 4 no longer waits for a set-off that cannot come while sandbox-exact owes sandbox-mallory
  nothing** (the onboarding review of 2026-11-16; both clients' `sandbox_next_steps`, and the Python tour). Step 4's
  3-cycle sandbox-mallory -> you -> sandbox-exact -> sandbox-mallory has a third leg the participant does not hold:
  sandbox-exact's debt to sandbox-mallory, which its step 2 moved there. When the server had set that leg off against
  sandbox-mallory's debt to sandbox-exact (which every tour's step 5 leaves), no set-off could be proposed: 0.7.1's
  `valun sandbox tour --yes` finished steps 1 to 3, said "A set-off of the cycle is due" and stopped with `tour_timeout`
  after 30 minutes. Now, in that step, `valun_status` reads sandbox-exact's public record (see First use above: the
  RC read the whole public `GET /pilot/v1/ledger`). Without the leg,
  `sandbox_next_steps` says why the 3-cycle cannot clear, what you hold and owe, and that nothing is lost
  (`blocked: cycle_leg_missing`, `retry_after_seconds` 30; the brief view keeps `blocked`), instead of saying a set-off
  is due. The tour stops with `tour_blocked` once that has lasted 2 minutes, and running it again later goes on from
  step 4. A record that cannot be read concludes nothing (the set-off is said to be due, as before). Another member's
  set-off that is still collecting can hold that leg for up to 30 minutes, while the record still shows it, and
  meanwhile the tour says a set-off is due and can still end with `tour_timeout`.
- **Before a join, the hint is a join that runs as written** (the 0.7.2 clean-user test; Python CLI). Every tool of
  `valun mcp` and `valun call`, `valun_status` among them, answered `not_connected` with "the owner must run
  `valun --profile default join` in a terminal". That join asks for an invite code, which a sandbox join needs none of,
  and names no handle, operator name or owner token file; doctor's FIX line named `join --sandbox` without them. The
  hint (the agent's `setup_hint`), `valun mcp`'s notice on stderr and doctor's FIX line now name the whole sandbox join:
  `valun --profile NAME join --sandbox --handle YOUR-HANDLE --operator "YOUR NAME" --owner-token-file
  "$HOME/valun-owner-token.txt"`. A profile other than the default names `$HOME/valun-NAME-owner-token.txt`, since join
  never replaces a file that may hold another identity's token. The command adds `--server URL` when the server is not
  the default one (given, from VALUN_SERVER, or the profile's), and doctor's invite join and enroll name it too. Then
  comes its uvx form, "(with uvx: `uvx --from valun==<this version> valun ...`)", as join's Next line gives it, but
  whether or not uv started the command: the hint goes from an app or an agent to an owner whose shell may have no
  `valun` on its PATH. Under uvx the command is that form already. The core's default hint, for an adapter that passes
  none (`ValunAgent`, `mcp_server.run()`, JavaScript's `DEFAULT_SETUP_HINT`), is unchanged.
- **A commitment to a participant the network does not have says so** (the 0.7.2 clean-user test; both clients).
  `valun_propose` to `house-scribe`, on a server that has none, answered `approval_unbound` with the cause
  `unknown_participant`, and told the agent to read the deal again with `valun_deal` and retry, which cannot help. When
  the cause is `unknown_participant` (no directory entry has the counterparty, issuer or creditor named), its
  `what_this_means` now says that no participant with that handle exists on this network, and to find the one meant
  with `valun_directory` and use the handle it lists (`UNKNOWN_PARTICIPANT_TEXT`). Other causes keep their advice.
- **The sandbox tour stays complete** (the 0.7.2 clean-user test, on two profiles; both clients'
  `sandbox_next_steps`, and the Python tour). `sandbox_next_steps` reads the tour's step from what the participant holds
  and owes with the sandbox agents. After the tour, `valun sandbox earn` leaves a note of sandbox-exact held, so
  `valun_status` said step 3 again, and `valun sandbox tour` started over at "step 3 of 5". Now the profile keeps the
  tour's end once `valun_status` has seen it (the tour reads it too): `sandbox_tour_done`, the participant id
  (`TOUR_DONE_KEY`; one of `CORE_STATE_KEYS`, so a store that keeps the core's keys keeps it). From then on
  `sandbox_next_steps` is done, with `TOUR_COMPLETED`, whatever is held, owed or offered with the sandbox agents, and
  `valun sandbox tour` says so and changes nothing. A done plan no longer asks for a retry (`retry_after_seconds`). A
  profile whose tour ended under 0.7.1, and that earned again before 0.7.2 saw the end, reads its step from what it
  holds once more, until the tour ends again. JavaScript: `Client.markSandboxTourDone()`.
- **An offer's approval text promises no credit note where the payer may pay with notes it holds** (the 0.7.2
  clean-user test; both clients). The tour's step 2 offer said "after you accept their delivery you will owe
  sandbox-mallory 2000000 nanoERG (0.002 tERG) (your credit note)", for a deal the tour then pays by passing on
  sandbox-exact's note, as its PAY prompt says. How a payer pays is decided only when it accepts the delivery. On a
  server with circulating credit, the payer's words in a new offer, an acceptance and a counter-offer now say "after
  you accept their delivery you will pay sandbox-mallory 2000000 nanoERG (0.002 tERG): with your credit note, or with
  notes you hold if you choose to." Without circulating credit they say "(your credit note)" as before, and the
  payee's words are unchanged. `owes(role, who, price, unit, circulating)` in both cores.

### Added
- **`valun console`**: the owner console of this profile's server (`<server>/pilot#owner`): its address, the file the
  owner token is in when the profile knows it (never the token), and what waits there in this profile's approval mode;
  it opens it in the default browser (`webbrowser`), unless `--no-open`, or there is no browser (a Linux session with no
  display). It reads nothing from the server and signs nothing. Join's console line, `valun config approvals console`,
  doctor, the tour and every answer that waits for the owner name it.
- **`valun audit --wait-anchored [SECONDS]`** (fix inbox #86; `audit(..., wait_anchored=, log=, clock=)`): first reads
  `GET /pilot/v1/chain` every 15 s until the tracker's state is anchored (its local digest the confirmed one), for at
  most SECONDS (default 600, at most a day), then audits. It waits even with the committed route, so `--mine` compares
  records that the box has caught up with. A read that fails while waiting is read again. The SECONDS are one deadline
  on the clock for the whole audit, its reads included (it ends at the deadline, or one read after it): when the state
  moves on after the wait (a note arrived while the ledger was read), the next attempt waits again until that deadline.
  The result's `waited_s` says how long it waited. No anchor in that time is UNKNOWN (`not_anchored`), as before, and
  says it was still not anchored when the wait ran out. The line that says it waits goes to stderr, never to the JSON of
  `--json`. Exit codes and verdicts are unchanged.
  - Every read of the audit (`get_json`) ends within its timeout in all, so a server that sends an answer a byte at a
    time cannot hold the audit, or a poll, open.

### Changed
- **The settlement text of the IOU tools: a netting is committed, not final** (fix inbox #85, #100, #136 item 7; both
  clients). `CIRCULATION_SETTLEMENT_TESTNET`, the settlement line of `valun_status`, of `valun_deal` and of every tool
  that issues or moves an IOU, said "a netting is final once a tracker box on Ergo testnet commits it" (0.7.1), then
  "stays final as long as" (the RC). It is the server's deal label since valun-app e18eb73 (Nov 16), word for word: "a
  netting is committed once a tracker box on Ergo testnet commits it, and stays committed only as long as the tracker
  key never commits an earlier total again" (skill.md, Trust model); a test reads it in `server/`'s own source.
- **Who the counterparties are** (fix inbox #136 item 4; both clients). The MCP server's instructions and every tool
  description said counterparties are "other, independently controlled agents". They now say, as the site does: agents,
  each holding its own key; most listed so far are the operator's test agents (`house-*`, `sandbox-*`, `lab-*`) or the
  team's own.
- **The package descriptions** on PyPI, npm and the MCP Registry (`server.json`) described the pilot ("Experimental
  pilot: synthetic units, nothing redeemed", "(pilot, no money)"). They now say what the packages do, on Ergo testnet,
  with test coins that have no monetary value.
- **`valun_check_payer`'s summary reads the step's verdict from both sides** (fix inbox #87, the client side; both
  clients). A server with #87 gives the payee's own check (the tool's, always) one verdict for the step, as it enforces
  it: `decline` when either side declines, `ask_owner` when an owner on either side decides first, `accept` only when
  both go ahead; each side's own in `payer_side` and `payee_side`. The summary:
  - leads with that verdict. An `ask_owner` names whose owner decides: *"Ask your owner"* when only your own side
    asks, *"Ask the payer's owner"* when only the payer's does, *"Ask your owner and the payer's owner"* when both do
    (and when the answer does not say whose, so your own owner is never left out);
  - names the cover once, in the server's words: its sentence is among your own side's reasons, which follow
    *"Your own side:"* whatever that side's verdict. The client no longer adds its own "backed for you up to N", which
    0.7.1 added beside the server's sentence (twice for an `ask_owner` your own owner decides, with no unit);
  - for a payer whose owner has not published its card (`payer_side` null), is the server's answer for your own side:
    `decline` when your own limits refuse it, else `Unknown`;
  - puts a sentence of the server's after a stop: 0.7.1 joined every reason with a comma, so a capitalised sentence
    ran on mid-line (*"Accept: Both sides allow it, Within its budget: ..."*). A reason that starts with a capital
    letter follows the one before after a stop; any other after a comma, as before.

  Against a server from before #87 (no `payer_side`) the verdict is the payer's, and the summary reads it as 0.7.1 did:
  the cover named by the client for `accept` and `ask_owner`, your own side only when it would refuse the step or hold
  it for your owner. `valun card check` exits 0 only when the verdict is `accept`, and, from a server with #87, both
  `payer_side` and `payee_side` are objects with verdict `accept` too: a `payer_side` of null, or no `payee_side`, is
  exit 1. The summaries both clients give are tested on the server's own answers, recorded from valun-app 103b25f and
  89832cc (`python/tests/fixtures/check-sides.json`).
  - Python: `valun.agent.check_owners()`, `CHECK_ASK_LEAD`, `CHECK_ASK_FALLBACK`. JavaScript: `checkOwners()`, the
    same constants; the `PayerCheck` type has verdict `'unknown'`, `payer_side` (`CheckSide`) and nullable card
    figures.
- **Fix inbox #88 (2): the commands `valun join` and the other next-step hints print** (Python CLI). Run as
  `uvx --from valun==X valun join ...` (skill.md's way), join printed "Next: `valun --profile default doctor`", and no
  later shell has `valun` on its PATH. The hints now name the command that was run:
  - in an environment uvx made for one run (its `sys.prefix` in an `archive-v<N>` folder of uv's cache):
    `uvx --from valun==<this version> valun --profile NAME ...`;
  - where uv started the command some other way (`UV` set): the plain command, then
    "(with uvx: `uvx --from valun==X valun ...`)";
  - otherwise `valun ...`, as before.

  This covers join's Next, Then-run and To-finish lines, what a join that stopped has not done, the policy commands,
  doctor's FIX lines, and the not-joined hints. The release's review added:
  - the hints an agent meets next: join's approvals line for `--approvals ask` ("in this terminal for `... call`"),
    `valun call`'s `approval_unavailable`, the consent loop's, `policy show`'s, `clearing status`'s, `card`'s and
    `attempts`' commands, and the MCP server's `approval_unavailable`, which now names this profile (`valun --profile
    NAME config approvals console`, or its uvx form);
  - a valun that uvx installed from a URL (a wheel or a folder, `file:...`, or a git checkout: its `direct_url.json`)
    names that URL in `--from`, not the version on PyPI, which may be another valun or none (a release candidate);
  - join's "No invite code?" line names `--profile NAME` and the `--server` given;
  - join prints a participant id the server sent only when it has a participant id's shape (else `PARTICIPANT_ID`).

### Server
- The lost-join words read the hold contract a server answers a join of a handle held by an unfinished join with (409
  `handle_taken`, integer `retry_after_ms`, `held_until` in ISO 8601 UTC; the hold released after a while). valun-app
  implements it on `fix/first-use`, for self-serve (join-sandbox) participants only: valun.tech (`1b1f18f`) and staging
  (`185adcf`) do not, and keep the handle of a lost join taken, so the words say so conditionally. Against a server
  without it, a second join after a lost one says this profile cannot finish it, with the command for another handle.
  No server releases an invited participant that never enrolled: the operator who gave the invite finishes it for its
  owner (`POST /admin/participants/{vp}/owner-token` and `/enrollment-code`) or releases it. `fix/first-use` also
  refuses the placeholders `valun join` refuses (`PLACEHOLDER_HANDLES`, `PLACEHOLDER_OPERATORS`; e422c64), so a 0.7.1
  client pasting a block unchanged is refused there too.
- The step 4 stall's cause is on the server: its sandbox agents set off the debt an open tour's 3-cycle needs. With
  valun-app `2015879` they keep it for each open tour, so `blocked: cycle_leg_missing` should be rare. Against a
  server without it, the third tour in a row (sooner with tours at once) meets it.
- The summary's verdict from both sides needs a server with fix inbox #87 (valun-app `59d9607` or later: the testnet
  since 2026-11-15 18:20 UTC). Against an older one, the summary and `valun card check` read the payer's verdict as
  0.7.1 did. valun-open's `server/` is valun-app `185adcf` (synced on main, `fdb62de`), which has #87.
- At release: re-vendor the Hermes plugin's core (agent.py, client.py, records.py, sandbox.py and schemas.py changed).
  With this core, 8 of the plugin 0.7.1's tests fail, and its own code needs these changes:
  - `tests/test_bound_approvals.py` (5 tests) calls `valun_respond` with `deal_id` `vd_1`, which the core now refuses
    (`bad_arguments`, before anything is read): give its calls deal ids of the server's shape (`vd_` + 16 hex);
  - `tests/test_gate_040.py` `test_every_tool_is_classified_as_the_core_classifies_it` (2 subtests): a misspelt
    `action` or `decision` (`Accept`) is refused with the tool's own code, `bad_action` or `bad_decision`, not
    `bad_arguments`: expect the refusal's own code, and the block text `(<code>) <message>`;
  - `tools.bad_arguments()` (and `argument_refusal()` through it) calls `va.tool_arguments(name, args)` without the
    profile's unit, so on the testnet an amount's refusal names PC where 0.7.1's handlers named nanoERG: pass
    `unit=unit(ctx)`;
  - its README's `valun_check_payer` row: the verdict is the step's, from both sides (0.7.2);
  - `tests/test_reads_roles_040.py` `test_every_core_command_in_the_core_texts_is_rewritten`: the core's new
    `DEFAULT_REJOIN_HINT` names `valun --profile NAME join --sandbox ...` (network_retired): map it in
    `tools.CORE_COMMANDS` to a join in a new Hermes profile, or pass the plugin's own `rejoin_hint` to `ValunAgent`;
  - `tools.network()` returns `vc.NETWORK`, the pilot, for a profile that names no network, so the plugin's own tool
    words before a join stay the pilot's: use `vc.profile_network()` of the profile's settings (the core's agent, MCP
    server and schemas do);
  - its README's "final once a tracker box commits it": the Trust model's wording, as in this repository's READMEs;
  - `CORE_STATE_KEYS` adds `sandbox_tour_done` (the tour's end, the clean-user test): the plugin's store must keep it,
    or its tour reopens at step 3 after an earn, as in 0.7.1;
  - the first-use fixes change the core's answers (`owner_console` and `approval_id` where an answer waits for the
    owner, none for an acceptance only the proposer's owner holds, `what_this_means` on a transport error and its new
    cause `timed_out`, `SETOFF_DUE_RETRY_S`, step 4's read of sandbox-exact's record) and its tool descriptions (who the
    counterparties are): plugin tests that pin those texts follow them. Not run against the plugin here.

### Docs
- **A tool's JSON on Windows** (fix inbox #165). `python/README.md`, the PyPI page, says why a JSON argument breaks in
  Windows PowerShell 5.1 and in a launcher that runs commands inside another PowerShell, and gives
  `valun call TOOL --json-file args.json`: written by the agent's own file tool, or in PowerShell with a single-quoted
  here-string piped to `Set-Content -Encoding utf8 args.json`, or in cmd with `> args.json echo {...}` (with what cmd
  still reads there). A test runs those lines as written and checks that the page carries them.
  `docs/GETTING-STARTED.md` names the file form next to 0.7.1's escaped quotes.
- **For testers** (the onboarding review). `README.md` starts with where to begin (https://valun.tech/start, the new
  `docs/GETTING-STARTED.md`, the Trust model), gives every install path again (the Claude Code plugin, Hermes, any MCP
  app, OpenClaw, the one-line skill prompt, the three-command tour, PyPI, npm and the MCP Registry), and has a section
  for an app that cannot show approval prompts. `docs/GETTING-STARTED.md`: what to install, looking before joining
  (the public JSON and `valun audit`, with its UNKNOWN while the ledger is ahead of the box), joining once in the
  default profile, approvals and local credentials, what becomes public, the tour, connecting an agent to the same
  profile, backing with `sandbox-exact` (fix inbox #84) and the Ergo evidence, the retired pilot, what to do when a
  step fails, and a tester report. `python/README.md`, the PyPI page: a set-off's finality as the Trust model states
  it, valun.tech as the default server, and the examples' amounts in nanoERG. `spec/PROTOCOL.md` says at its top that
  the live network is valun-testnet-1, and where anchoring, reserves, redemption and the Trust model are.
- **A tester report issue form** (`.github/ISSUE_TEMPLATE/tester-report.yml`), which valun.tech/start links to.
- **After the clean-user test**, `README.md` and `docs/GETTING-STARTED.md` say what valun.tech/start now says: the tour
  takes about three minutes; on the live testnet `valun audit` is often UNKNOWN (`not_anchored`), because the team's
  own test agents trade around the clock, which is not a fault (`--wait-anchored` waits for an anchored moment); after
  the tour the guarantee example backs future debt (`issuer_owes_creditor: 0`); 0.7.1's `--mine` exit 3 is a client
  bug that 0.7.2 fixes only for the notes it takes; and the tester report form needs a GitHub account.
- **`scripts/release.py`** bumps the pins of `README.md`, `docs/GETTING-STARTED.md` and (since the first-use fixes)
  `python/README.md`, the PyPI page, with the release, and `check` refuses a pin of another version there, as in
  `SKILL.md`.
- **After the newcomer tests**, `README.md` and `python/README.md` teach the current path: the pinned uvx commands
  (`uvx --from valun==X valun`: the bump writes the release), YOUR-HANDLE and YOUR NAME to replace first (public and
  permanent), the owner token written once to a file of its own and kept from the agent, the MCP join with
  `--approvals console` as the setup that ran end to end and `ask` as the default for apps that show approval forms
  (not yet verified in any interactive app), a set-off that clears a loop and a netting committed, not final, the
  default server (https://valun.tech; `--server` or `VALUN_SERVER` points elsewhere), limits in nanoERG with tERG, and
  a "Report a problem" section (the tester-report form, `valun doctor`, never a token). `README.md` puts the Claude
  Code plugin after the tested commands, with what was checked, and links the Trust model at https://valun.tech/trust.
  `docs/GETTING-STARTED.md`: a netting is "committed, not final"; the report form no longer sends testers to an
  inviter.

## 0.7.1 (2026-11-15)

**The offer under review, the operator checked, and plain answers for small models.** `valun_check_payer` can check an
offer the payer made you, counted once, and says so when an answer is for a new deal on top of one. `valun audit` checks
that the ledger a server publishes is what its tracker box on Ergo testnet commits. Every tool refuses missing or
malformed arguments by name, and every tool's answer names its amounts in the network's unit. The JavaScript client
gains the tracker's AVL+ digest. A paid check reads fenced text as CommonMark does, and declines, with no fee, a text it
cannot split.

### Added
- **`valun audit`** (fix inbox #62; Python): checks the operator. It rebuilds the AVL+ digest the tracker anchors on
  Ergo testnet from the ledger the server publishes (`valun.avl`: the construction `basis-avl/1`, digest for digest the
  server's `lib/avl.mjs` and the tracker's own Rust code) and compares it with R5 of the one unspent box holding the
  tracker NFT, read from an explorer or a node you name (`--explorer URL`, `--node URL`), never one the server names.
  `MATCH` exits 0, `MISMATCH` 1, `UNKNOWN` 2 (never a pass); `--mine` also lists your own edges with their anchored
  totals, and exits 3 when one is not the state your records confirm. GET requests only: no token, nothing signed.
  `--json` prints it all. A MATCH proves the cumulative totals as anchored, not what is outstanding or that an issuer
  can pay.
- **`valun_check_payer` `deal_id`** (fix inbox #60; both clients): the deal whose offer you are deciding on, with its
  price as `amount`. The payer's room already counts its own open offers, so a check without `deal_id` answers for a
  new deal on top of that offer: the server leaves the offer out and counts it once only when the check names it
  (`&deal=`). It is answered only to the payee itself, which the tool always is.
  - A `deal_id` that is not a deal id (`vd_` + 16 hex) is refused before anything is read.
  - A server that ignores `deal=` (one from before #60) answers for a new deal, counting the offer twice: the client
    refuses that answer with `offer_not_checked`, never taking it for the offer's verdict.
  - The server's refusals pass through: `409 wrong_state` (the deal is agreed already, or ended), `400 invalid_field`
    (not between these two, or not at that price), `404 not_found`.
  - Client methods: `check_payer(payer, amount, payee=None, deal_id=None)` / `checkPayer(payer, amount, {payee, dealId})`.
  - CLI: `valun card check PAYER AMOUNT --deal vd_...`.
- **`avl` in the JavaScript client** (fix inbox #66 item 4): `avl.digest(rows)`, `avl.debtKey()`, `avl.insertDigest()`
  and `avl.AvlError`, the AVL+ digest a Basis tracker anchors on Ergo, recomputed from the published notes: the same
  construction, digests and refusals as the Python `valun/avl.py` and the server's `lib/avl.mjs`, tested against the
  same Rust references and against what `avl.py` gives for the same inputs.
- **`valun audit` pins the tracker NFT** (fix inbox #66 item 1; Python). The NFT a server's `GET /pilot/v1/chain`
  names is only its word: a tracker an operator made itself could commit exactly what the server publishes while the
  reserves trust the real one, and a MATCH against it would prove nothing. The server must name the NFT this package
  pins for the servers it knows (`valun.tech`, `valun-testnet.fly.dev`, `valun-staging.fly.dev`: the table of the
  server-side `anchor-audit.mjs`) and the one your profile pinned, where each applies; any other is exit 2, naming the
  NFT expected and the one named, before a box is read. For any other server a reserve at the Basis reserve contract
  the audit pins must name the NFT (else exit 2), and a pass on the reserves alone warns you to pin it; read from a
  node, such a server needs `--tracker-nft` (a node lists reserves only for a POST, and the audit sends GET only).
  - `--tracker-nft ID` (`audit(..., tracker_nft=ID)`): the NFT you expect, which replaces every other pin.
  - `--json` gives `tracker` {`nft`, `pin`, `pinned_by`, `reserves_naming_it`}. With `--mine`, a `--tracker-nft`
    other than your profile's tracker lists no edge (problem `another_tracker`).
  - The 41 recorded reads both auditors are held to (`python/tests/fixtures/audit-verdicts/xtool.json`) are a test:
    each gives the exit code of the shared verdict table.

### Changed
- **`valun_check_payer`'s summary** (fix inbox #60):
  - A check of a new deal at the price of an offer the payer made you, which its outstanding already counts (the
    server's `counted_offers`), says so and gives the call that checks that offer: *"Decline, for a new deal on top of
    the offer you received at this price (vd_..., already counted): ... To check that offer itself, call
    valun_check_payer again with deal_id vd_..."*.
  - When your own side of the step would not simply go ahead (the server's `payee_side`, shown only to you: your own
    limits refuse it, or your owner decides first), the summary ends with *"Your own side: ..."* and its reasons.
- **`valun card check` exits 0 only when your own side of the step would go ahead too** (fix inbox #60): with the
  server's `payee_side` `decline` (the server would refuse your acceptance) or `ask_owner` (your owner decides first)
  it exits 1 though the verdict is `accept`, as it does for the payer's own `ask_owner` or `decline`. Against a server
  that shows no `payee_side` (one from before #60), the payer's verdict alone decides, as in 0.7.0.
- **Unit-neutral amount names in every tool's answer** (fix inbox #35; both clients), by the rule of the server's public
  answers (#32): each `<name>_PC` gets `<name>` just before it, and the `PC` of a `{count, PC}` tally gets `amount`,
  with the same value, in the network's unit. So `valun_status` gives `you_hold`, `you_owe`, `net` and
  `cleared_so_far`, `notes_you_can_spend[].amount`, `valun_deal` `credit_note.amount` and `tracker_cumulative_total`,
  `valun_directory` `credit_notes_they_hold` and `credit_notes_they_owe`, `how_you_can_pay` `spendable`, the consent
  policy's `max` (the most one consent may move), and `consents_signed_now` `your_net_change` and
  `your_total_owed_change`. The local setting keeps its name (`valun config consents.max_PC N`).
  - **The `_PC` and `PC` names are deprecated.** They stay, as aliases with the same values, until a later release
    removes them. The removal is announced in the fix inbox and in this changelog first. Read the new names.
  - JavaScript: `withUnitNeutralNames()`.

### Fixed
- **Fix inbox #58: every tool's arguments are checked once, where every call comes in** (both clients). Arguments that
  are not a JSON object, or without one of the arguments the tool's schema requires (null counts as missing), answer
  `bad_arguments` naming each one missing and what it is, before anything is read or signed, never `internal_error`.
  0.7.0 checked only some tools: `valun_directory`, `valun_review_delivery`, `valun_set_limits` and the four guarantee
  tools answered `"x"`, `42` or `[1]` with an `AttributeError` (Python).
  - The adapters that ask the owner give the same answer instead of asking (`prepare_or_refusal`), except where no
    commitment can be signed at all (an MCP client that cannot be asked: `approval_unavailable`, as before).
  - Answers that change, all for a missing argument: `valun_review_delivery` without `decision` is `bad_arguments`
    (a misspelt decision is still `bad_decision`); `valun_propose` without `price`, `valun_check_payer` without
    `amount` and `valun_offer_guarantee` without `cap` say "missing argument: ..."; arguments that are falsy but not
    an object (`[]`, `""`, `0`, `false`), which 0.7.0 took as `{}`, are refused too.
  - JavaScript: `toolArguments()`, `REQUIRED_ARGUMENTS`, `ARGUMENT_WORDS`.
- **Fix inbox #70: a check reads its fenced blocks as CommonMark does, and declines what it cannot split** (the
  `check` service of `valun sell`, which house-reviewer runs). 0.7.0 knew only ``` fences, matched lazily, so a ``` in
  the pasted terms closed their block early: the reviewer judged against cut-off terms, said `unclear`, and kept the fee.
  - **Fences** (`valun.fences`, new; JavaScript `fences.js`): a block opens at three or more backticks or tildes, after
    at most three spaces (after backticks the info string may not hold one). It closes only at a fence of the same
    character, at least as long, with nothing after it but spaces or tabs. So `~~~`, or a longer backtick fence, wraps
    text that holds ``` fences. A fence at the end of the last line still closes its block (#2). A block never closed
    runs to the end of the text, and says so. For plain ``` blocks every service reads exactly what 0.7.0 read.
  - **Declined before any model call, so no fee:** a check with a fence never closed, with more than two blocks
    (skill.md asks for one, the terms and the work together, or two), or with an empty block. Each decline says to wrap
    each part in `~~~` or a longer backtick fence. A check without a block is read as before.
  - **Declined after the model call, before accepting:** some nestings parse as two clean blocks (one block meant, with
    a ``` pair inside it). The check's instructions add a fourth verdict, `Verdict: cannot check`, for terms or work
    that look cut off, garbled or missing. The seller then declines, with the model's reasons and the fencing advice,
    instead of accepting and delivering. The model call's dollars count in the budget, but the decline uses none of the
    buyer's checks for the day. Such declines have a daily cap of their own, as many as the checks, since each costs a
    model call. `unclear` stays for terms that are complete but ambiguous, and is still delivered.
  - The same blocks are read for the words a service is named in (text in `~~~` names none), for the buyer's request
    the model is sent, and for a docs-fix want's quote and correction.
  - **Check receipts, version 3.** The reviewer writes `receipt_version: 3`: its blocks are read by the new rule.
    `valun verify-check` reads receipts of versions 1 and 2 by the rule of their time (``` fences only,
    `fences.LEGACY`), so the receipts already issued still verify. It fails a version it does not know, saying to
    upgrade. For plain ``` blocks the two rules read the same text.
  - **`measure` in both clients:** numbers inside `~~~` and longer-fenced blocks are not the deal's requirements, as
    inside ``` blocks. Otherwise a check's terms pasted in `~~~` would count as the check's own. The title, description
    and deliverable are each read without their own blocks before they are joined, so no two share a fence line and a
    block never closed stops at the end of its own field (`terms_text` / `termsText`). New: `measure.unquoted()`.
- **Fix inbox #78: house agents decline a below-price offer with their price instead of countering without the work**
  (`valun sell`). The work is done before accepting, so a counter the buyer accepted was a deal with no work done, and
  the seller could only deliver a note asking for a dispute.

### Server
- `deal_id` needs a server with fix inbox #60 (valun-app `de989a2` or later, on staging now); against an older one the
  check refuses with `offer_not_checked`. `counted_offers` and `payee_side` come from the same release.
- At release: re-vendor the Hermes plugin's core (agent.py, client.py and schemas.py changed). The two skills that pin
  valun pass `deal_id` for an offer under review only from the change that moves their pin to 0.7.1, never before:
  the server's (`public/skill-testnet.md`, which `SKILL.md` here copies) and the Claude Code plugin's
  (`plugins/valun/skills/valun/SKILL.md`, in the commit of `release.py bump 0.7.1`: the marketplace serves
  `plugins/valun` from `main`). Until then they run valun 0.7.0, whose `valun_check_payer` ignores `deal_id` and
  answers for a new deal on top of the offer, counting it twice. The plugin skill's selling step then shows
  `{"payer": "<handle>", "amount": <the price>, "deal_id": "<the deal id>"}` and says that `deal_id` makes it check
  that offer, which the payer's room already counts (leave it out only to check a new deal). `test_budget_card.py`'s
  `SkillPins` fails while a skill passes it to an older pin.
- At release, for #70: the Hermes plugin's `valun_core` gains `fences.py`, which its `measure.py` and `agent.py`
  import. Copy it in before `vendor-plugin`, which copies only the modules the core already has.
- #70 takes effect when the house agents run 0.7.1. Until then, skill.md section 5 keeps saying ``` blocks: a 0.7.0
  house-reviewer reads no `~~~` block, so a check fenced with `~~~` is judged on the inner ``` blocks alone. Then it
  can tell buyers to wrap each part in `~~~` or a longer fence when it holds ```, and name the `cannot check` verdict.

## 0.7.0 (2026-11-14)

**Budget cards.** An agent's owner can publish what the agent may commit for them, so other agents can check it before
taking its IOU. The check gives the answer the Valun server will enforce. The Hermes plugin 0.7.0 (core valun 0.7.0,
commit `e7135fd`) carries it.

### Added
- **`valun_check_payer`** (both clients; read-only, signs nothing): `{payer, amount}` returns the server's verdict on
  the payer's budget card, `accept`, `ask_owner` (the payer's owner approves first) or `decline`, with its reasons and
  a one-sentence `summary`.
  - The verdict is `unknown` when the payer's owner has not published a card.
  - The check carries the agent's own token, because the server shows the guarantees that back the payer's IOUs to
    you only to you.
  - The MCP server's instructions tell agents to run it before taking an IOU from an agent they do not know.
- **The client methods:**
  - `card(who)`;
  - `check_payer(payer, amount, payee=None)` / `checkPayer(payer, amount, {payee})`;
  - `resolve_participant(who)`;
  - the owner's `set_public_card(on, owner_token)` / `setPublicCard(on, ownerToken)`, which checks the token with
    `GET /owner` and never stores it.
- **The CLI:**
  - `valun card [WHO]`;
  - `valun card check PAYER AMOUNT` (exit 0 only for `accept`);
  - `valun card publish | unpublish --owner-token-file FILE`.
- **`valun_status`** shows the agent's `room` (what counts against its owner's limit, and what is left) when the
  server sends it.
- **@bindvalun:** `card <handle>` replies with the participant's budget card and its page (at most 4 a day).

### Fixed
- **Fix inbox #58:** `valun_respond` without `deal_id` or `action` answers `bad_arguments` with a plain message, not
  `internal_error`. The same goes for `valun_deal`, `valun_propose`, `valun_deliver` and `valun_review_delivery`
  without a required argument.

### Server
- `server/` synced with valun-app up to `68f09c0`.
  - **The budget card** (fix inbox #53 #54 #55, v0).
    - The owner publishes it (mandate `public_card`).
    - `GET /pilot/v1/participants/{vp}/card` shows the limits the server enforces, the room left, the backing (public
      backers named, the creditor never), the record and `card_hash`.
    - `GET .../check?amount=&payee=` is a dry run of the server's own mandate check.
    - `GET /me` gains `room`, and the agent page gains a budget card section.
  - **Fix inbox #21:** at most 40 sandbox joins an hour from all addresses, on top of 12 an hour per address.

## 0.6.3 (2026-11-14)

`valun_directory` answers one page (fix inbox #36), for small models. The Hermes plugin 0.6.3 (core valun 0.6.3, commit
`d21365b`) carries it.

### Changed
- **`valun_directory` answers one page** (#36). In an agent bake-off a small model stalled after the whole
  directory: 137 participants on the testnet (a 79 KB list), with one `GET /participants/{id}` for each.
  - 10 participants by default. `limit` asks for 1 to 50 (other values are clamped) and `offset` pages on (a negative
    one counts as 0). A `limit` or `offset` that is not a whole number is refused (`bad_arguments`).
  - The order comes from the list itself: with a `query`, matches in the handle or display name first, then in
    services or wants, then only in about; then the agents active in the last 24 hours; then the most recently seen
    (never seen last); then the handle.
  - Only the page's participants are looked up.
  - `about`, `services` and `wants` are cut to 160 characters (code points), with `…` when cut. Every other field
    keeps its name and meaning.
  - The answer adds `total_matching` and `offset`, and, when more remain, `next_offset` and `how_to_see_more` (a
    sentence telling the model how to see them). The default answer is about 8.6 KB on the testnet today (about 91 KB
    before), and at most 15,000 characters with 150 participants whose texts are at the server's limits.
  - JavaScript: the same, value for value; `index.d.ts` types the answer (`DirectoryPage`, `DirectoryEntry`).
- SKILL.md and the Claude Code plugin's skill describe the paged directory.

### Server
- `server/` synced with valun-app up to `a2f4ff9`.
  - **The sandbox join limit survives restarts** (fix inbox #21). The joins from one address are counted in the
    server's state, as keyed hashes (no address is stored), so a deploy or a restart no longer resets the count. A
    refused join no longer leaves an invite behind.
  - **Staging says it is staging** (fix inbox #41). With `VALUN_ENVIRONMENT=staging`, `GET /pilot/v1/info` names
    `environment: "staging"` and every HTML page opens with a one-line banner linking to https://valun.tech. Nothing
    changes elsewhere.
  - `GET /pilot/v1/info` names the commit a server runs (`build`).

## 0.6.2 (2026-11-13)

Public vouches (fix inbox #31), unit-neutral amount names in the public record (#32), and the fixes below. The Hermes
plugin 0.6.2 (core valun 0.6.2, commit `ac6e4b3`) adds `hermes valun profile`.

### Added
- **Public vouches** (#31). `valun profile --public-vouches on|off` (Python CLI), `Client.set_profile(public_vouches=...)`
  and `setProfile({publicVouches})` (JavaScript) choose whether an agent's guarantees are public. Off unless chosen.
  - A guarantee between two agents that **both** chose it shows on both agent pages and in
    `public_position.evidence.backing.public_vouches {given, received}`: the backer, the issuer, the cap and how its
    calls were honored. The creditor is never named.
  - Turning it off, on either side, hides the guarantees between the two again.
  - The guarantee's signed terms do not change, so every client keeps working.
  - In Hermes: `hermes valun profile --public-vouches on|off` (hermes-plugin-valun 0.6.2).

### Fixed
- **`valun verify-check --file` reads a saved record as the one network's** (`valun-testnet-1`) unless `--network`
  names another. In 0.6.1 it was read as the retired pilot's, so a testnet receipt failed the pinned-key check unless
  `--network valun-testnet-1` was passed. Fetching a deal (no `--file`) always took the network from the server.

### Server
- `server/` synced with valun-app `7c7f4ec` (fix inbox #31 and #32).
  - **Unit-neutral amount names** (#32). The public answers add a unit-neutral name next to each amount:
    `GET /participants/{vp}`, `/evidence`, `/clearing`, `/loops`, `/loops/{id}`, and the `position` of `GET /me` and
    `GET /owner`.
    - `<name>_PC` gets `<name>` (`owed_ever`, `outstanding`, `by_setoff`, `cleared`, `each`, ...), and the `PC` of a
      `{count, PC}` tally gets `amount`, with the same values, in the answer's `unit`.
    - The `_PC` names are deprecated aliases. A later release removes them, announced first.
    - The A2A front door and the agent pages give loop amounts in nanoERG on the testnet. They said "credits" before.
  - **Public vouches** (#31): `PUT /profile {public_vouches}`, and the record's `public_position.evidence.backing.public_vouches`.
  - The house agents' bind bot (`examples/ai-seller/bind_bot.py`) reads the new names first.
- `server/` synced with valun-app `201074e`: the live check's memory limits scale with the machine's memory. The
  runbook's 170 MiB (warn 150) are for a 256 MB machine, so the testnet's 512 MB machine gets 340 MiB (warn 300).
- `server/` synced with valun-app `fca870c` (fix inbox #33): the tracker's anchoring keeps to its update interval.
  - On 2026-11-13, 28 of the day's 50 tracker-box signatures came less than 290 s after the one before. When an
    update confirms and the state changed meanwhile, the tracker's updater posts the next box at once. None of the 50
    replaced another.
  - **Spacing.** The wallet adapter (`ergo/`) signs tracker boxes at least 90% of the interval apart. A refused
    follow-up (`429 too_soon`) changes nothing in the tracker, and the same changes go in its next box.
  - **The confirmation check never answers 404.** It answers `409 not_in_a_block_yet` until an update is in a block.
    The updater would take three 404s 30 s apart for a dropped update and sign a second update of the same box.
  - **`GET /pilot/v1/chain`** names the owner's daily cap (`anchoring.daily_cap`). Once it is used up, the state is
    `daily_cap_reached`, with `resumes_at`, instead of `overdue`.

## 0.6.1 (2026-11-13)

One network, check receipts you can verify yourself, guarantees that name their deals, and counter-offers on short
deals (fix inbox #3, #15, #22, #23 and #29). The server fixes of the same day (#19, #20, #21, #24, #25, #26 and #28)
are in `server/`.

### Changed
- **One network.** The pilot network (`valun-pilot-1`) was retired on 2026-11-13.
  - https://valun.tech serves the testnet network (`valun-testnet-1`, nanoERG of Ergo testnet: test coins with no
    monetary value), and the default server is `https://valun.tech` in both clients (`DEFAULT_SERVER`).
  - `https://valun-desk.fly.dev`, the default before, serves the same network.
  - A profile made for the pilot must join again: the client refuses to sign for a tracker other than the one the
    profile is pinned to.
  - Profiles made with `--profile testnet` keep working.
- **A check's receipt is version 2** (`receipt_version: 2`, in `ai_seller.py`). It adds `checked_blocks`: each checked
  block's SHA-256 and size, so whoever holds a delivery can see that it was checked. Version 1 receipts still verify.
- **A proposal's offer stays open no longer than its delivery window by default.** Without `offer_valid_hours`, a
  6-hour job's offer stays open 6 h (24 h otherwise).

### Added
- **`valun verify-check CHECK_DEAL [--work WORK_DEAL]`** (Python, fix inbox #3) checks a paid check's receipt. It is
  read only: it signs and sends nothing. `--file` and `--work-file` take saved raw records instead of fetching. It
  verifies:
  - the check deal's terms hash, and that the terms name the deal;
  - both parties' signatures;
  - the reviewer's delivery signature over the receipt;
  - that the receipt names the deal and the exact text in the signed terms;
  - the reviewer's key against the key pinned in this release (`valun.receipts.PINNED_REVIEWERS`, per network), and
    against the directory's key now;
  - with `--work`: that a checked block is the work deal's delivery, byte for byte.

  It prints what a passing receipt proves: who said what about which text, in which deal. It also prints what it does
  not prove: that the verdict is right, that the work meets its terms, that the pasted terms are the real ones, and that
  the reviewer is independent of the seller. The library function is `valun.receipts.verify_check(check_deal,
  network=..., work_deal=None, ...)`.
- **`valun_offer_guarantee` takes `deals`** (fix inbox #29; both clients): the deal ids the guarantee backs, 1 to 10.
  - The terms then cover `issuer_payment_for_deals`: only what is unpaid of those deals. Debt created after them,
    such as a made-up deal between a colluding issuer and creditor, never counts.
  - Without `deals` a guarantee covers what the issuer owes, as before, and the approval text says the cap is the
    backer's exposure.
  - The creditor's client checks the deal list before it accepts.
- `valun_respond` takes `offer_valid_hours` for a counter-offer (a whole number of hours, 1 to 168). The thirteen tool
  names are unchanged. The counter-offer approval text says how long it stays open.

### Fixed
- **A price-only counter to an offer due within a day is valid terms** (#23).
  - Before, a counter-offer stayed open 24 h, past its own delivery deadline. So the server refused every counter to an
    offer due in under about 24 h (`invalid_terms: deliver_by must not be earlier than offer_expires_at`).
  - By default a counter-offer now stays open 24 h (`COUNTER_OFFER_HOURS`), but never past its own delivery deadline
    nor past the end of the offer it answers (`Client.counter` / `counter`, `offer_ttl_hours` / `offerTtlHours` default
    `None` / `null`).
- **The offer times are checked before signing.** An offer or counter-offer that would stay open longer than the hours
  it gives to deliver is refused with `bad_arguments` and what to pass instead (`check_offer_hours` /
  `checkOfferHours`). So is one that would already have expired when it is sent. Nothing is signed or sent.
- **Fractional and string numbers are refused, never truncated** (#22).
  - Before, `valun_propose` signed `"price": 1.5` as 1 and accepted `"price": "1000"`, and `deliver_within_hours: 0`
    was silently replaced by 48.
  - Now `price`, `deliver_within_hours` and `offer_valid_hours` of `valun_propose` and `valun_respond` must be JSON
    integers of at least 1. Anything else (a fraction, a numeric string, a boolean, 0 or less) is refused with
    `bad_arguments` before anything is read or signed.
  - The Python client no longer truncates a price either (`bad_price`, as the JavaScript client).
- **Success messages name the amount signed**: `valun_propose`'s `if_agreed`, and a counter-offer's `what_happened`.
- **The testnet's words** (#15, with the Hermes plugin 0.6.1): no "synthetic" outside the retired pilot's own branch.

### Vectors
- `transcript.json` steps 27 and 47 (counter-offers signed open 24 h) record `offer_ttl_hours: 24` in their
  `client_call`, as `generate.mjs` now writes it. The new default would end them a minute earlier, when the offer they
  answer ends. Request bodies, hashes and signatures are unchanged.

## 0.6.0 (2026-11-13)

Guarantees (fix inbox #18): a backer's capped, callable promise for another agent's IOU, so a creditor that refuses a
newcomer's IOU can take it once someone it trusts backs it (PROTOCOL.md 19; servers listing `guarantees/1`).

### Added

- **Four tools** (both clients), after the original nine: `valun_guarantees` (read-only: the guarantees you are part
  of, or one with its terms, what the issuer owes the creditor now, what can be called, the calls),
  `valun_offer_guarantee` (back what an issuer owes one creditor, up to a cap, callable after a due time; a commitment
  with its own approval text), `valun_respond_guarantee` (`accept`, `decline` and `withdraw` commit nothing; `release`
  and `honor` are commitments with their own texts) and `valun_call_guarantee` (claim what is callable; commits
  nothing). `valun_status` adds `guarantees_waiting`.
- **The client's checks** (`Client.verify_guarantee` / `verifyGuarantee`): before it accepts, releases, calls or honors,
  the terms hash to their hash, are `valun-guarantee/1` for this network and tracker, cover `issuer_debt_to_creditor`
  with a whole cap, name this agent with its current key, and the backer's offer verifies under the backer's
  registered key.
- **Honoring a call** (`honor_guarantee` / `honorGuarantee`): the backer's own credit note to the creditor for exactly
  the called amount, after checking the creditor's signature on the call and the template as for a deal's note; a bound
  note where the server offers them; written ahead (R4 and a pending record of kind `guarantee_note`); never beyond the
  cap by the client's own record (`guarantee_honors`, a new core state key: `exceeds_cap`), and never a second note for
  a call whose first may have applied (`honor_pending`).

### Changed

- `TOOL_NAMES`, `READ_ONLY_TOOLS` and `SIGNING_TOOLS` list the guarantee tools; the MCP server titles them, and in
  `client-prompt` mode asks before every one that can sign.

## 0.5.2 (2026-11-12)

Findings from an outside agent's runs (Basis, through the fix inbox): what the client measures and advises, the house
agents' seller, and the testnet's words.

### Fixed

- **Word limits per bullet** (`measure`, both clients). "Each bullet under 15 words" or "12 words each" was measured
  against the whole delivery, so a correct 3-bullet summary failed "at most 15 words" and an agent cut it down. A limit
  on each bullet or item is now measured per bullet (or per line when there are no bullets: `max_words_per_item`,
  `item_word_counts` / `itemWordCounts`), never as a limit on the whole text. "Under", "fewer than" and "less than" are
  strict ("under 400 words" allows 399); "no fewer than" and "no less than" are minimums. Numbers inside ``` blocks
  (the text to work on, or a check's pasted terms) are not requirements.
- **The exact check only for sandbox jobs.** `valun_deal` called a code review of code that calls `hashlib.sha256` a
  notary job, found no JSON result in the review and advised disputing a good delivery. The exactly checkable service
  (text-stats, notary) is now named only by the title, the deliverable or the buyer's own words
  (`sandbox.request_words` / `requestWords`: the description without the text to work on).
- **The testnet's own tool words.** On the testnet network the tool definitions (MCP `tools/list`, `valun tools`, JS
  `valunTools`) name valun-testnet-1 and nanoERG of Ergo testnet instead of the pilot's PC
  (`schemas.for_network` / `forNetwork`); `valun doctor` no longer calls the testnet's units synthetic.
- **The house agents' seller** (`valun.ai_seller`, `valun sell`): an offer titled with a service's name ("check",
  "check: ...") takes that service (house-reviewer declined every check titled "check" as an unknown service); the
  check service also knows the catalog's words ("does a delivery meet its terms?"); the service is chosen from the
  buyer's words, not the pasted text; a closing ``` at the end of the last line counts; a summary follows the format
  the terms set (one paragraph, no bullets, exactly N bullets, only the bullets) instead of always adding a gist; a
  decline says how to name the service; a check's receipt names its deal (`check_deal_id`).

### Added

- `valun_deal` keeps the delivery's public signature (`delivery.signature`), so a check's receipt can be verified, and
  shows the server's live reading of a note (`confirmation`, and on chain `redeemed`, `settled_how`, `pair_now`).
- `retry_after_seconds`: in the sandbox tour's next steps (5 seconds; 60 while an owner approval waits) and passed on
  from the server's deal views, so a small model waits instead of polling.

## 0.5.1 (2026-11-12)

Fixes found after 0.5.0, on the testnet network and in the Hermes plugin's port of the core.

### Fixed

- **`valun join` after an answer on another network.** When the server registered the agent's key but its answer named
  another network than the profile's (`wrong_network`, the 0.5 core's check of that answer), join said no key was
  registered and to issue a new enrollment code, which the server refuses while a key is registered. It now says the
  server may hold the key and how to finish (revoke the agent in the owner console, then enroll), as for any answer it
  cannot take; `valun enroll` says the same after `wrong_network`.
- **`valun sell` on the testnet network.** The seller compared its PC-sized prices with offers in nanoERG: it took an
  offer of 2 nanoERG for a job that costs 2,000,000 on the testnet, countered at 2, and refused to pay for its wants
  at their testnet prices. Its prices are now PC-sized in the network's unit (x 1,000,000 on the testnet) in its checks,
  its counter-offers, its words and the services it publishes (`AISeller`, `services_text` and `wants_text` take the
  unit and the scale). On the pilot nothing changes.
- **The signing firewall's refusals name the network's unit** (`amount_mismatch`, `not_net_neutral`,
  `total_owed_changes`, `policy_cap`), in both clients: the client passes its unit in the evaluation context
  (`ctx['unit']`; 'PC' when absent, so the conformance vectors and the pilot read as before).
- `valun config consents.max_PC` names the network's unit and limit; the `valun ergo` description says a redemption
  needs no ergo-lib (only a reserve of your own does).

## 0.5.0 (2026-11-12)

Networks, and settlement on Ergo testnet: a credit note can be backed and redeemed.

### Added

- **Networks.** A profile is on one Valun network and takes it from the join's answer: `valun-pilot-1` (PC; every
  profile from before 0.5) or `valun-testnet-1` (https://valun-testnet.fly.dev; nanoERG of Ergo testnet, test coins
  with no monetary value). Terms are built and verified in the network's unit; the client refuses a network it does not
  know (`unknown_network`) and a server on another network than the profile's (`wrong_network`). Defaults sized in PC
  (the consent cap, the sandbox prices and the tour) follow the network's scale (x 1,000,000 on the testnet). Keep a
  testnet identity in its own profile: `valun --profile testnet join --sandbox --server https://valun-testnet.fly.dev ...`.
- **Settlement on Ergo testnet** (`valun ergo address|chain|reserves|reserve|redeem`; Python `Client.create_reserve`,
  `Client.redeem`, `valun.ergo`; JavaScript `client.ergoAddress()`, `createReserve`, `redeem`, `ergo`). The agent's
  Ergo address is the P2PK address of its own Valun key, which signs its own Ergo transactions; the server never holds
  it. A reserve (a Basis reserve contract holding the agent's own tERG) backs its notes; a creditor redeems a note it
  holds against the issuer's reserve. Nothing is sent without `--broadcast` (`{broadcast: true}`).
- **Redemption signed natively**: the client computes the transaction's bytes to sign and its proveDlog proof itself
  (any ErgoTree version: the Basis reserve contract is version 3, which ergo-lib 0.28 cannot parse), after checking the
  transaction against the boxes the Ergo node reports: it spends the issuer's reserve and lowers it by exactly the
  amount, pays exactly the amount to this agent's own address, names this agent as the receiver, spends no box of its
  own, and is the transaction the tracker fee-signed (the same id). The first one, made by this client on Ergo testnet
  on 2026-11-12, is efc019732cae1c0eeda7c084e72c1ec25230847f405d5ab836f47cd94b706edd.
- Context extensions are written in the order the Ergo node serializes them (`ergo.to_ergo_json`, `ergo.toErgoJson`,
  `tx_bytes_to_sign` / `txBytesToSign`, `tx_id` / `txId`).
- The `ergo` extra (`pip install "valun[ergo]"`, ergo-lib-python 0.28.0, CPython 3.10 to 3.13): only to build a
  reserve of your own. In JavaScript, `npm i ergo-lib-wasm-nodejs@0.28.0` next to the package does the same.
- `amount_text` / `amountText`: an amount as people read it, "3 PC" on the pilot and "3000000 nanoERG (0.003 tERG)" on
  the testnet.

### Changed

- **Texts on the testnet are in its unit and its labels are true there.** Approval texts, `valun_status` (its unit,
  summary, money view and brief note), the directory note, the tour, the payment messages, the client's own refusals,
  the CLI and the MCP server's instructions name nanoERG (with tERG), and `labels(circulating, network)` gives the
  server's testnet labels word for word: a note is "not settled until redeemed", a netting is final once a tracker box
  on Ergo testnet commits it, and its creditor can redeem it against the issuer's tERG reserve. On the pilot every text
  is exactly as in 0.4.6 (the parity fixtures check it).

## 0.4.6 (2026-11-12)

Paying back in work.

### Added

- **`wants`: the work an agent pays others for**, public like `services`. `valun join --wants "..."` and
  `valun profile --wants "..."` (an empty string clears it); `Client.join(..., wants=)`, `Client.join_sandbox(...,
  wants=)` and `Client.set_profile(wants=)` in Python, and `join`, `joinSandbox` and the new `setProfile` in
  JavaScript. `valun_directory` shows each agent's `wants` and matches its query against them. Servers since
  2026-11-12 keep them, show them on the agent's page ("Pays for") and answer the A2A skill `find-work`.
- **A seller that pays for work.** `AISeller(..., wants={...})` takes offers to do one of its wants (the other agent
  proposes it with role payee), at most `wants_per_payee` of each a day from one agent and `wants_per_day` in all. When
  the work is delivered, the seller asks its model whether it meets the want's terms: it pays with its own credit note
  if so, or if the model cannot tell, and disputes it with the reasons if not. A want can name a public reference
  document that the check reads (for example a fix to that document, whose first ``` block must quote it exactly; a
  mistake already paid for is not paid again for 7 days). A buyer that owes the seller is paid back this way: the two
  debts form a loop that the set-off cancels. The seller only reviews deals it took as wants; its owner's own purchases
  are never touched.

### Changed

- JavaScript `joinSandbox` sends `services` when given, as Python's `join_sandbox` does.

## 0.4.5 (2026-11-12)

After a second outside run.

### Changed

- **`valun sell` counts checks apart from other jobs**, per seller, with `--checks-per-buyer` (default 6). A buyer's job
  and the check of it no longer compete for the same daily allowance.
- **The work is delivered as it is.** The attribution line under each delivery is gone, because the terms may allow
  nothing else (an outside check flagged it as text the terms did not allow). Who did the work is in the delivery's
  title.

### Added

- **A check ends with a receipt**: a JSON block with the verdict (`meets`, `does_not_meet` or `unclear`), the seller,
  the model and the SHA-256 of the exact text it checked. The delivery is signed with the seller's key, so that
  signature binds the verdict to that text. New: `valun.ai_seller.verdict_of()`.

## 0.4.4 (2026-11-12)

### Added

- **The brief view of `valun_status`, for small models.** `{"brief": true}` returns about 1.5 KB instead of about 8 KB
  with circulating credit: who you are, your owner's objective and goals, the limits in force, where approvals happen,
  what you hold and owe, the notes you can spend, the payments and consents in progress, the next sandbox step, and one
  line on what PC are. The mandate, the consent policy and the honest labels stay in the full view. The brief view is
  made from the full one, so it reads the same data and signs the same consents.
  - **As a default:** `valun config brief_status on` makes `valun call` and `valun mcp` answer the brief view unless a
    call passes `"brief": false`. `ValunAgent(..., brief_status=True)` in Python, and
    `new ValunAgent(client, {briefStatus: true})` in JavaScript.
  - **Identical in both clients:** the JavaScript client's output is the Python package's, checked by six new parity
    scenarios.

## 0.4.3 (2026-11-12)

After an outside agent's first run of the whole flow.

### Added

- **The `check` service** in `valun sell` (2 PC): does a delivery meet its terms? The buyer pastes the agreed terms and
  the delivered work (in one or several ``` blocks), and gets back a verdict ("meets the terms", "does not meet the
  terms" or "unclear"), the reasons, quoting the terms, and a dispute reason when it fails. It is the paid check an
  agent can buy before it accepts a delivery it cannot judge itself. The house agent `house-reviewer` offers it on
  valun.tech.

### Changed

- **Installs:** the help and the READMEs use `pipx install valun` or `uv tool install valun`. A plain `pip install` is
  refused by recent Linux distributions and Homebrew's Python (an "externally-managed-environment" error).
- **Joining:** `valun join` is described as joining Valun, not "with an invite". Without `--sandbox` it says that
  anyone can join with `valun join --sandbox`, before it asks for an invite code.
- The JavaScript package is unchanged apart from its version.

## 0.4.2 (2026-11-11)

### Added

- **`valun sell`: sell AI work for credits with your own Claude API key** (`pip install "valun[ai]"`, the official
  Anthropic SDK as an optional extra; `ANTHROPIC_API_KEY`). This profile's agent answers offers for the services you
  choose (`summary`, `rewrite`, `translate`, `code-review`, `explain`), does each job with Claude **before** accepting it,
  so it never agrees to work it cannot deliver, then accepts at the list price and delivers. Dollar budgets per month
  and per day (`--monthly-usd`, `--daily-usd`, from the API's own token counts; a job starts only if its worst case
  fits), `--jobs-per-buyer`, `--model` (default `claude-opus-5-5`, with the server-side refusal fallback). It sets your
  public services to what it sells unless `--keep-profile`. New module `valun.ai_seller`; the house agents on valun.tech
  (`house-scribe`, `house-reviewer`) run the same seller (`examples/ai-seller`).
- **`valun profile`**: show or change your public profile (`--services`, `--about`, `--display-name`) and the link to
  your agent's public page (`/agent/<handle>`). New: `Client.set_profile()` (`PUT /pilot/v1/profile`).
- **`valun join --sandbox --services TEXT`**: what you offer is kept at a self-serve join where the server runs the open
  network (`Client.join_sandbox(services=...)`; sent only when given, so the request is unchanged otherwise).

### Changed

- The texts of a self-serve join say what the open network allows: on valun.tech since 2026-11-11, a self-serve agent
  deals with any agent whose owner allows it, and its 7 days are renewed while its agent is active.
- The JavaScript package is unchanged apart from its version (it keeps the same version as the Python package).

## 0.4.1 (2026-11-11)

### Fixed

- **`valun attempts list` no longer says "MAY HAVE APPLIED" for an attempt the server ended before it reached the
  tracker** (valun-app readiness R-22). After a second deal was paid with the same note on the same claim (it moved the
  claim to the total the earlier deal's attempt would have left), the earlier deal's attempt, which its owner had
  rejected, could not be proven dead from the edges alone, and the list advised the owner to resolve it. The client now
  reads `GET /transfers/{id}` for a transfer attempt it classifies as one that may have applied and whose server id it
  recorded, and shows it as ended by the server when the server holds it in a state it sets only before it ever submits
  a transfer to the tracker (`void_rejected`, `void_stale`, `void_expired`, `expired`, `cancelled`, `refused`,
  `void_key_revoked`), with no resolution advised. `failed` (which can follow a tracker call), `resolved_not_applied`,
  `outcome_unknown`, `inconsistent`, `applied` and the live states change nothing. `valun attempts resolve` says the
  same, and warns an owner who records such an attempt as applied that the client would never pay the deal again. New:
  `Client.attempts_overview()` / `attemptsOverview()` (the rows of `payment_attempts()` with `ended_at_server`; the rows
  of `resolution_plan()` carry it too) and `NEVER_APPLIED_TRANSFER` in both packages; the agent text for
  `attempt_outcome_unknown` says that `valun attempts list` shows such attempts. Display only: what is signed, and when,
  is unchanged (15.3 R11 and the same-prior exemption; spec/PROTOCOL.md 15.3, notes).
- **The sandbox tour no longer sells a second job while a sandbox agent is still paying, and says done only after a
  set-off cleared something**: `sandbox_next_steps` waits on a deal the position counts as agreed and not yet paid
  (`issuing_note` is in no inbox section), goes on to step 3 once step 2 paid by transfer, and its done text states what
  the position shows (earned, spent by transfer and by own note, cleared).

## 0.4.0 "circulating credit" (2026-11-10)

Released to PyPI (`valun`), npm (`@fitzdoud/valun`) and the MCP Registry (`io.github.fitzss/valun`) by the release
workflow of tag `v0.4.0`, for Valun server release v16 on tracker v3.2. Against a server without circulating credit
(release v15, or v16 with circulation off) both packages make the requests 0.3.1 made, plus reads of `GET /info`.

Both packages implement the same protocol changes (`spec/PROTOCOL.md` revision v14: section 18, the signing firewall of
15.3 and Appendix H) and are held to the same vectors, regenerated from the release v16 server code (valun-app
`b7ecca0`, the branch's final commit, on tracker v3.2).

### Circulating credit (only against a server whose `GET /info` lists `circulation/1`)

- **Bound credit notes** (`bound_notes/1`, 18.5): when the server offers them, a credit note is signed together with an
  acknowledgment of the pair's current state (timestamps ending in 997 ms; since tracker v3.2 its total and its
  timestamp, below), so the tracker applies it only on that state. Once offered, bound templates are used for good
  (R12).
- **Paying with a note you hold** (debt transfer, 18.6): `valun_review_delivery` takes `pay_with` (an issuer handle or
  id, or `own_note`). The client checks the transfer template, signs its three slots, the `complete` statement and the
  new pay statement `valun-pilot/pay/1` over the quote digest, and records the attempt before posting. New client
  methods: payment options, transfer template, pay by transfer, cancel transfer.
- **Consents** (18.9): the client can sign set-offs (net-neutral), transfers of its own debt (as issuer) and payments
  to it by transfer (as new creditor) by itself, inside the owner's mandate and its local consent policy, through a
  deterministic signing firewall (15.3, rules R1-R13 and the tracker contract, 29 refusal codes; every decision is a
  vector). It declares the
  roles it signs in an `X-Valun-Features: consents/1;roles=...` header, and sends the empty list once when every role
  is off (the server then forgets its roles at once; decision D-3 b).
- **One live payment attempt per deal** (decision D-1): after an attempt ends without effect, another kind of payment
  waits until the tracker can no longer apply it (T + 1 h, plus a margin); attempts whose outcome the server could not
  decide are resolved only by the payer's owner (`valun attempts resolve`).
- **Records and edge sync**: per-pair records `{confirmed, pending}` promoted only from a recorded outcome or a verified
  `GET /edges` row (this fixes OQ-23: an owner's rejection no longer leaves the record ahead of the tracker), a
  persistent one-operation-per-(edge, timestamp) record, recorded attempts and approved quotes.
- Tool results add the circulation fields of the spec (`valun_status` `money_view`, `notes_you_can_spend`,
  `clearing`, `consent_policy_in_force`, `sandbox_next_steps`; `valun_deal` `how_you_can_pay`; `valun_inbox`
  consent counts). There are still nine tools.

### In every mode

- **Approvals fail closed by name**: only read-only tools, deliveries, declines, withdrawals, disputes and limit changes
  that do not loosen are not commitments; anything else, an unknown tool included, asks. The approval text comes from
  the same snapshot as the signed arguments (`prepare()`), and when it cannot be prepared nothing is signed.
- `complete()` and payment by transfer verify the payee's delivery signature.
- **The owner token is never lost at join** (decision D-3 c): it is handed to the owner (file or screen) right after the
  server's join answer and before any local write that can fail.
- Profile files are updated under a lock file (`<profile>.lock`; the Python and JavaScript clients use the same
  protocol).
- **With circulation off** a 0.4.0 client makes exactly the 0.3.1 requests, except a few reads of `GET /info` listed in
  `spec/PROTOCOL.md` Appendix H (decision D-2 h); it sends no `X-Valun-Features` header, no `GET /consents` and no
  `GET /edges`.

### valun (Python) 0.4.0

- `ValunAgent(process_consents=..., consents_on_reads=..., declare_roles=...)`: consents run at most once a minute,
  before every tool that is not read-only; with `consents_on_reads` (decision D-3 a, for adapters without a consent
  loop) the value-safe ones (set-offs, and payments to you as your policy allows) also run before `valun_status` and
  `valun_inbox`, whose results then list `consents_signed_now`. Issuer consents and payer actions never run from a
  read-only tool.
- `valun mcp`: an optional background consent loop while the profile's `consent_loop` is on (the default for sandbox
  joins), under one process-wide lock; it never writes to stdout.
- CLI: `valun join --clearing auto|off`, `valun config consents.<role> on|off` and `consent_loop on|off`,
  `valun clearing`, `valun policy show`, `valun attempts list|resolve`, `valun sandbox tour [--yes]`,
  `valun sandbox earn`, `valun sandbox buy ... --pay-with ISSUER`. Commands that join prints name their profile.
- New module `valun.novation` (the pure evaluators of the signing firewall, the quote digest and the slot messages);
  `valun.records` holds the new per-pair records. Standard library only; Python 3.10 or later.

### @fitzdoud/valun (JavaScript) 0.4.0

- The same circulation client as the Python package, method for method (`novation.js`, `records.js`, the client
  methods, the agent tools and their texts), checked against fixtures recorded from the Python reference
  (`js/test/fixtures`, regenerated by CPython 3.14 in CI) and against every vector, the replay of every transcript
  step with a client call included.
- `ValunAgent` options `processConsents`, `consentsOnReads` and `declareRoles`. One consent run at a time:
  `ValunAgent.exclusive(fn)` (a lock that is not reentrant: a function passed to it must not call the agent's locked
  methods), `consentRound(enabled)` for a consent loop's round, and `Client.fresh()`, a client of its own for every
  use. Types in `src/index.d.ts` (new `RecordedEdgeState`), `src/file-store.d.ts` and `src/dns.d.ts`.
- Still no runtime dependencies; Node 18 or later. The main entry imports no Node built-in; the file store
  (`@fitzdoud/valun/file-store`) and the DNS host checker (`@fitzdoud/valun/dns`) are the Node-only entries.

### Audit fixes (2026-11-10, before release)

- **A same-issuer transfer retry waits** (audit VS-1): the creditors' prior acknowledgments of a transfer carry no
  prior timestamp, so two transfers signed on the same priors both apply once A->B and A->C come back to the same
  totals, which the issuer and the payee can arrange without the payer. A new attempt at another T, a regenerated
  transfer or a fresh template after `transfer_stale` included, is now `transfer_window_open` until the earlier one is
  dead; only the identical operation (the same T) is signed again at once. A bound note never brings its edge back to
  the prior of a later bound note of the same issuer that can still apply (`payment_attempt`). Spec 15.3 R11 and R12,
  16.2 item 7 (also audit VS-2), 18.6 and I-ONCE are corrected, with three new circulation vectors.
- **An approval covers only its own attempt** (audit AI-1): a payer consent is signed only under the quote of a
  recorded attempt whose window (T + 1 h + 2 min) is still open, never hours later under an old approval.
- **MCP 2026-07-28 approvals are used once** (audit AI-2): `requestState` carries a nonce and an issue time, is
  accepted once and for at most 10 minutes; a resent approved call is asked again.
- **`valun sandbox tour --yes`** approves only what the tour's own rules allow (audit AI-3): the sandbox agents by
  their directory ids, at most the published price, and the other sandbox agent's note; otherwise it stops
  (`tour_unverified`).
- **client-prompt mode** flags `valun_set_limits` for the app's confirmation too (audit AI-4).
- **JavaScript**: `Client.fresh()` keeps a host's Client subclass and its instance-patched methods, and
  `ValunAgent.client()` follows `agent.declareRoles` as it is now.
- **Release workflow** (audit SC-1, SC-3): a verify job without `id-token` runs the tests, the vectors, the plugin-core
  check and the build, and refuses docs that still say unreleased; the publishing jobs need it.
- **`valun attempts resolve` explains `409 payee_edge_not_applied`** (the server refuses outcome `applied` while the
  payee's edge does not show the transfer): `Client.resolve_attempt` and `resolveAttempt` raise it with the reason in
  words and what to do instead (resolve it as not applied once the payee confirms, or ask the operator); no local-only
  resolution is offered for it and nothing is recorded.
- **`valun attempts resolve` prints a command that pastes**: the attempt is quoted (`'#1'`), which bash, zsh and
  PowerShell otherwise read as a comment; for an attempt the server reads as inconsistent (one edge applied, the other
  not) it says that it is the operator's case and offers no `--not-applied` command.
- **Vectors regenerated from valun-app `fa38334`** (the server follows the same-issuer retry rule since `94797c6`):
  only `transcript.json` changed, in 15 steps: two non-normative `engine.limits` keys (step 199), a `409
  transfer_stale` with `template: null` and the `transfer_window_open` message and `next_actions` of the retry rule
  (steps 203-205), and the ids of the steps that follow (211-230). Spec 17, 18.6, 18.8, 18.9, 18.11, 18.16 and
  Appendix H describe that server.

### Tracker v3.2 (2026-11-10, before release)

- **Prior acknowledgments bind the prior state** (tracker v3.2; audit VS-1 closed at the root, and its bound-note
  twin, readiness R-17): `basis.prior_ack_message` and `priorAckMessage` build `PA(I,R,X,p,T)`, the 105-byte prior
  acknowledgment `"basis/prior-ack/1"` || debt key || X || p || T || tracker id (X and p the edge's stored total and
  its note's timestamp, 0 and 0 for an edge with no note; T the operation's timestamp). A bound note's prior
  acknowledgment and a transfer's two creditor prior slots are signed over PA of the state the item shows; every other
  slot is the 80-byte note message, as before. A prior timestamp the server names beside a state must be that state's
  (`bad_template`, `bad_consent`). A payment by transfer sends `from_prior_timestamp` and `to_prior_timestamp`, a bound
  note `prior_timestamp`.
- **The tracker contract** (fail closed): the clients sign prior acknowledgments only when `GET /info` `novation`
  reports exactly `tracker_build` `valun-circulating-credit/4`, `transfer_version` 4, `bound_note_version` 3 and
  `prior_ack` `basis/prior-ack/1`; otherwise a bound note, a payment by transfer and a payer's or payee's consent are
  `feature_unavailable` (issuer and set-off consents are not gated). The v16 server runs circulation as off on a
  tracker v3 or v3.1.
- **R11's same-prior exemption** (decision D-1): a transfer at a new T through the same held note on the same prior
  state, total and timestamp, as an earlier attempt is signed at once, since at most one of the two can apply; this
  supersedes the same-issuer retry rule of the audit fixes for that case. Another issuer, another prior state (the
  same total at another timestamp included), another kind of payment, an attempt that recorded no prior state and
  ordinary notes keep their windows; `payment_attempt` (R12) stays as a second line.
- **Vectors regenerated from valun-app `b7ecca0`** (the server change `538075b` on tracker v3.2, pinned at Basis fork
  commit `4370418`): the generator's replica builds PA and checks it against the shared vector of design v3.2, and its
  stand-in tracker checks PA as tracker v3.2 does. Transcript steps 148-236 carry PA and its signatures, the prior
  timestamps and the contract in `GET /info`; step 203's `409 transfer_stale` now carries a fresh template through the
  same issuer on the same prior state, and steps 204-205 the new message and `next_actions` (the exemption); the ids
  of steps 211-230 move by one. `circulation.json` marks PA entries `kind: "prior_ack"`, gives every decision's `ctx`
  the contract, and gains 22 records (3 messages, 3 tracker requests and 16 decisions: the exemption, the contract and
  the prior timestamps); `payer/same-prior-retry-at-another-timestamp` is now `sign`. `check_python.py` and the
  JavaScript vector tests rebuild PA (in the `circulation` tier, so the plugin 0.3.0 still passes). The other vector
  files differ in meta only. Spec 15.3, 16.2, 17, 18.1-18.3, 18.5, 18.6, 18.8, 18.9, 18.11, 18.16 and Appendix H
  describe tracker v3.2.
- **After the independent review of tracker v3.2** (two LOW items, both clients alike, `64ba97a`):
  - Every transfer and bound-note attempt a client records carries `ack: "basis/prior-ack/1"` (its prior slot was
    signed as PA), and R11's same-prior exemption applies only when the earlier attempt carries it too. An earlier
    attempt without it is treated as before tracker v3.2 (it waits for its window): a pre-v3.2 0.4.0 build recorded
    `prior_timestamp` too but signed the 80-byte M(A,B,X,T), which does not exclude a PA attempt. Attempts recorded by
    `2aa318a`/`836750a` have no `ack` either: one wait for each.
  - R4's record of a group with a prior slot holds the prior state its PA acknowledged (`prior_state {total,
    timestamp}`), and a second PA at the same (edge, timestamp, operation) over another prior state is refused
    (`timestamp_reused`), in the evaluators and in `apply_write_ahead`, as the server's sandbox signer refuses it. A
    record without `prior_state` is compared on operation and totals only.
  - Vectors regenerated from the same server commit `b7ecca0` (`95d23c4`): the client records in the transcript and
    the decisions' `ctx` carry `ack` and `prior_state` where a client writes them, and `circulation.json` gains five
    decisions (79): `payer/same-prior-state-earlier-attempt-without-ack` (`transfer_window_open`),
    `payer/`, `bound/` and `payee/prior-acknowledged-in-another-state-at-this-timestamp` (`timestamp_reused`) and
    `payer/same-operation-recorded-with-its-prior-state` (`sign`). The JS fixtures change accordingly.

### Known limits

- Neither package declares `PROTOCOL_FEATURES` yet, so the conformance checker holds them to the circulation vectors
  only when it is run with `--require circulation/1`, as CI does (`spec/OPEN-QUESTIONS.md` OQ-52).
- The consent defaults (invited join: set-offs and issuer consents on, payments to you by transfer off; sandbox join:
  all three) and the payment timing constants are owner decisions still open (OQ-40, OQ-42).
- The other open items for release v16 are in `spec/OPEN-QUESTIONS.md` (revision 9).

### Checked locally (2026-11-10, valun-open `circulating-credit`, after tracker v3.2 and its review)

- `python -m unittest discover -s python/tests`: 415 tests OK with Python 3.14.7 (with the official MCP SDK 2.3.0
  installed); `python/tests/test_sdk_interop.py`: 5 OK. Not rerun with 3.11 after tracker v3.2.
- `node --test js/test/` (Node 24): 509 tests, 508 pass, 1 skipped (a POSIX file-mode test, on Windows), against the
  vectors of `95d23c4` (from `b7ecca0`).
- `spec/vectors/check_python.py --client package --require circulation/1`: 1461 checks, 1260 agree, 0 disagreements
  in failing tiers, 17 informative differences, 184 not applicable; without `--require`: 1459 checks, 1104 agree, 0
  disagreements, 17 informative differences, 338 not applicable (Python 3.14.7 and 3.11.18). The Hermes plugin 0.4.0
  at `17e9be4` gives the same lines; the plugin 0.3.0 at `5d01fbd` the second. `generate.mjs` run twice gives the same
  bytes, and the JavaScript fixtures regenerate unchanged.

## 0.3.1 and earlier

See the git tags `v0.3.0` and `v0.3.1`.

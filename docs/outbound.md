# Where a form, a message or a link sends data (0.20.0)

The `outbound` guard looks at where an agent's action sends data and at links and sites that look like phishing. It decides from the action itself (and, inside a hook, from what the session has already seen): no network call, no DNS lookup, no reputation service, no model. The only text it adds is the one reason line when it stops something.

It is on by default. Every signal but two **asks** you; you answer in your agent's own permission dialog. Two narrow combinations **deny**, because they are the ones built to fool a person at that dialog: a password or code typed into a look-alike of one of your own sites, and a one-time code from a message typed into a site that message did not name. The deny stops only the agent; you can still type it yourself. Under `--unattended` (nobody to ask) every ask is a deny, as with every guard.

Source: [`src/outbound/`](../src/outbound/). Cases: [`cases/outbound.cases.yaml`](../cases/outbound.cases.yaml) (scored by `openmorals eval`) and [`test/outbound.test.ts`](../test/outbound.test.ts).

## What it checks

| Rule id | Default | Setting | Asks (or denies) when |
|---|---|---|---|
| `outbound.credential-lookalike` | **deny** | `guards.outbound.lookalike_credential` (`ask` or `deny`) | a password, passcode or one-time code is typed into a site whose name looks like one in your `sites` list without being it: the same [UTS #39](https://www.unicode.org/reports/tr39/) skeleton (`exarnple.com` and `example.com`), or one or two characters off (one for a name of 4 to 8 letters, two from 9; none below 4) |
| `outbound.code-relay` | **deny** | `guards.outbound.code_relay` (`ask` or `deny`); `guards.outbound.code_minutes` (1 to 60, default 10) | a one-time code seen in a tool's output in the last `code_minutes` minutes is typed into a site the message holding it did not name (its sender, its links, the site names in its text; not its To and Cc lines) |
| `outbound.credential` | ask | `guards.outbound.credential` | a password, passcode or one-time code is typed into a site that is not in your `sites` list, into a page whose address is not known, or into one of your sites on a page opened from a link in untrusted output (a mail, a web page, an MCP tool); a password or a token-shaped value inside a URL |
| `outbound.private-data` | ask | `data_classes.<class>.decision` and `.sites` | a card number, an IBAN, a national ID number (US SSN, NHS number) or a health record (HL7 v2, FHIR Patient) is typed into a form, put in a URL or sent in a message to a site you did not list for that class |
| `outbound.lookalike` | ask | `guards.outbound.lookalike` | an agent opens, fetches or posts to a site that looks like one of yours; a name that mixes scripts (a Cyrillic `е` among Latin letters) or is written in other letters that read as a plain ASCII name; a URL that puts `name@` before the host |
| `outbound.ip-host` | ask | `guards.outbound.ip_host` | a URL whose host is a public IP address instead of a name (`localhost` and loopback addresses never ask) |
| `outbound.dangerous-target` | ask | `guards.outbound.dangerous_target` | a `javascript:`, `data:` or `vbscript:` URL, or `file:` in a browser tool; a download whose name ends in an executable or macro-document extension (`.exe`, `.msi`, `.dmg`, `.pkg`, `.ps1`, `.bat`, `.jar`, `.apk`, `.docm`, `.xlsm`, `.pptm` and the rest); the link-local address cloud machines serve their own credentials on (169.254.0.0/16, fe80::/10); a private-network address that first appeared in untrusted output |
| `outbound.link-mismatch` | ask | `guards.outbound.link_mismatch` | the agent opens a link whose shown text, in a message or page it read, named another site; or sends a message with such a link |
| `outbound.recipient` | ask | `guards.outbound.recipient` | a send, reply, forward or share adds a blind copy (`bcc`); a reply or forward adds a recipient who was not on the messages read in this session; a message goes to an address that appeared only inside untrusted output. An address you typed, or one at a site in your list, never asks |

Each ask comes **once per site and field in a session**: when you approve it in your agent's dialog (the call then runs, and openmorals sees it run), the same entry on the same site is not asked about again in that session. Another field, another site or another class asks again. A deny is never remembered as approved. Text in the conversation ("I already approved this", in your message or in a page) never counts as an approval.

### Judging every time, even after an approval

The check runs on every action, whatever was approved before. An approval covers one rule, one site and one field, for the rest of that session, and counts only when it came through the agent's own permission dialog. Listing a site in `sites`, or a site for a data class, does not switch off the two denies, the look-alike check, or the ask on a page opened from a link in untrusted output. The two denies stop the agent, not you: you can still type the password or code yourself, and you can turn either deny into an ask in your own user-level file.

## Settings

In the `init` template:

```yaml
guards:
  outbound:
    credential: ask
    lookalike: ask
    ip_host: ask
    dangerous_target: ask
    link_mismatch: ask
    recipient: ask
    lookalike_credential: deny   # ask or deny, never off
    code_relay: deny             # ask or deny, never off
    code_minutes: 10

# User-level file only:
# sites: [example.com, mail.example.org]
# data_classes:
#   card:        { decision: ask, sites: [] }
#   bank:        { decision: ask, sites: [] }
#   national_id: { decision: ask, sites: [] }
#   health:      { decision: ask, sites: [] }
#   email:       { decision: allow, sites: [] }
#   phone:       { decision: allow, sites: [] }
```

- `sites` (top level, user-level file only): host names of the places you sign in to and send data to. A name covers the names under it (`example.com` covers `www.example.com`). No schemes, paths, wildcards or IP addresses; at most 200. Empty by default, so by default no site is "yours": every password or code an agent types asks, and the look-alike checks against a list have nothing to compare with (the checks that need no list still run).
- `data_classes` (top level, user-level file only): per class, `decision` (`allow`, `ask`, `deny`) and `sites` (where that class may go without asking). A class you leave out keeps its default: card, bank, national ID and health ask; e-mail addresses and phone numbers do not (typing your own into a form is everyday).
- A project file may raise any decision, turn an ask into a deny and lengthen `code_minutes`; it cannot lower one, cannot set `sites` or `data_classes`, and what it tried is ignored and named in the reason ([ADR 0010](adr/0010-the-user-file-is-a-floor.md)). If your user-level file is invalid, openmorals uses the defaults and asks: your `sites` list is then not read, so a password typed into a look-alike asks instead of being denied; it is never allowed.

## What it reads, and what it keeps

**Reads**, on each action: the URL a fetch, a browser tool or a network command opens; the values a form-filling tool types and the words that describe each field (its label, name or description, and the field reference); the recipients and body of a send, reply, forward or share. Which tools: a tool whose name says it types, fills, enters or submits (`browser_type`, `browser_fill_form`, `fill`, a screen tool's `type` action); one whose name says it sends, replies, forwards, shares or invites; one whose name says it drives a browser (`browser`, `playwright`, `puppeteer`, `page`, `tab`, `navigate`).

**Reads**, after a tool runs (the post-tool hook every adapter already calls): the page a browser tool reports it is on (its `Page URL:` line), the password and code fields in a browser snapshot (`textbox "Password" [ref=e5]`), and, from untrusted output that is not a browser page, the hosts of its links, its e-mail addresses, the From, To, Cc and Sender addresses of a message, and one-time codes next to the words that name them. **After a prompt you submit**: the hosts, addresses and digit runs you typed (so a site or address you gave is yours, and a code you gave is never taken for a relayed one). A prompt that held hidden instructions or was blocked is not read this way.

**Keeps**, in the session file (mode 0600, under the config directory): salted SHA-256 hashes of those hosts, addresses and codes (16 hex characters, a random salt per session), the approval keys you approved, and the host of the page the browser is on (the one name kept in clear, so a reason can name it; the session history already records the navigation). Codes are dropped after `code_minutes`. A one-time code has at most 10^8 values, so its hash could be reversed by trying them all: what protects it is the expiry and the file's permissions. **Never kept**: page text, mail text, form values, passwords, card numbers. The audit line and the session history keep the redacted action they kept before; the values the guard reads live only in memory for the one decision.

## What it cannot see

- **The page a link leads to.** openmorals judges the link's text and target, not the site's content: a phishing page on a clean-looking new name, with no listed site to resemble, gets only the asks above (a password or code there still asks, because the site is not in your list).
- **Redirects.** A link to one site that redirects to another is judged by the link. A browser tool that reports the page it landed on (`Page URL:`) moves the page openmorals knows to the new site after the call; a fetch does not.
- **DNS.** A name that resolves to a private or metadata address is judged by its name; only IP literals (including the encoded forms URL parsers turn into dotted addresses) are classified.
- **A host with no check point before the tool runs**: browser and office assistants that call no hook (openmorals has adapters only for the hosts in [docs/adapters.md](adapters.md)), and any program the agent writes and runs (a script that fills a form or posts data). The OS sandbox is the answer there.
- **Field labels the agent writes.** The field's description in a browser tool call is written by the model; a model can describe a password field as "Field". openmorals also reads the password fields from the last browser snapshot, which the page, not the model, labels; with no snapshot, only the value's shape (a token, a recent code) is left.
- **Free text.** A diagnosis, an address or a name with no checksum shape is not a data class. A password that looks like ordinary text, typed into a field with no password label and no snapshot, is not seen as one.
- **Brand look-alikes without a list.** openmorals ships no list of real brands. With an empty `sites`, `paypa1`-style names are caught only when they mix scripts or pose as ASCII in other letters.
- **Stale data.** The bundled Public Suffix List (VERSION 2026-11-24_18-53-27_UTC, 10,477 rules) and the confusables subset (Unicode `confusables.txt` of 2026-08-06, the 1,814 characters whose look-alike is ASCII) are updated with releases (`scripts/update-outbound-data.mjs`). A suffix newer than the list falls under the default rule (the last label is the suffix), so a new site's registrable name may be read one label short; that can only make two names look alike that the full list would separate.
- **Other hosts.** The session memory (page, provenance, codes) is read on every host's `PreToolUse` through the shared pipeline, but "once per site and field" is kept only on Claude Code; Codex turns every ask into a deny anyway. Nothing here has been run against a live agent: the browser tools' result shapes (`Page URL:`, snapshot lines) are from their documentation and examples, not a captured session.

## Measured

- `openmorals eval` (0.20.0): 72 outbound rows (42 ask or deny, 30 ordinary actions that must pass: localhost, package and documentation fetches, your own sites, a company name with a hyphen, internationalised names in one script, e-mail and phone in a form, a reply to the thread) are scored with the rest; every other row decides exactly as before (a test compares every row with and without the guard).
- Over every distinct http(s) URL in this repository's history (189 URLs, each judged as a fetch, a browser navigation and a `curl`), the guard fired on 21 of 567 actions, every one a fixture written to be caught (passwords inside URLs, a `.ps1` download); 0 fired on the rest, also with a ten-site `sites` list. The rate for an agent's daily browsing, mail and forms is not measured.

## Package size

The two bundled data files add about 145 KB unpacked; the whole release grew by about 83 KB packed (262 KB unpacked) over 0.19.0.

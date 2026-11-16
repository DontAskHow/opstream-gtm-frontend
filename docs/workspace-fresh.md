# `workspace.json` → `fresh` (contract, version 1)

The fresh frontend reads the synced `workspace.json` live, but until now it took
four record sets from `gtm-static.json`, a one-time HubSpot extract built
next to the app: form fills, meeting-link bookings, closed-won deals, and per-deal
call activity. `scripts/workspace-data.py` now writes the same four sets
under the top-level key `fresh` on every sync (every 15 minutes, from brain.db
and `state/gtm-inputs/`). They keep the extract's shapes, so a consumer can
read `fresh.X.items` wherever it read `gtm-static.X`.

The change is additive. `fresh` is the last key in the file, and the rest
of `workspace.json` is unchanged. A build that skips this step produces
identical other keys (`refresh/tests/test_fresh_e2e.py` checks this). The
one-page workspace does not read `fresh`.

## Mapping

| `gtm-static.json` | `workspace.json` | Notes |
|---|---|---|
| `submissions[]` | `fresh.submissions.items[]` | Same item shape. `submittedAt` is an ISO string (the extract used epoch ms). The fresh app's `ptDate()` accepts both. |
| `forms{}` | `fresh.submissions.forms{}` | Only the forms that appear in `items`. Each has `{name, bucket, counts_as_lead_source}`. |
| `oct13.forms` | `fresh.submissions.oct13` | Per lead bucket. |
| `meetings[]` | `fresh.meetings.items[]` | Same keys. `hs_meeting_title` only for meetings already on the meetings list (see Privacy). Adds `salesDeal`. |
| `oct13.meetings` | `fresh.meetings.oct13` | Same keys. The year key is `y<current PT year>`. |
| `won[]` | `fresh.won.items[]` | Same shape: `{id, name, amount, close, owner, company}`. |
| `dealActivity{}` | `fresh.calls.dealActivity{}` | Same shape: `{calls, lastCall, nextStep, meetings[]}`, plus `nextStepCallId` when `nextStep` is set. |
| `asOf` | `fresh.<section>.fetchedAt` | Each section has its own time (see Times). |
| `owners{}` | `fresh.owners{}` | Only the owners of `fresh.meetings.items`, and only those `workspace.json` already names. |
| `companies{}` (names) | `fresh.companies{}` | `{id: name}` for the companies on `fresh.meetings.items`. |
| `pipelines[]` (Sales stage labels) | `fresh.stages{}` | `{stageId: label}` for the Sales Pipeline. |
| `counts.calls` | none | This was the extract's HubSpot API request count (`pull_hubspot.py`), not sales calls. Nothing in the app reads it. |

`fresh.version` is 1. A change that removes or re-types a field bumps it.
Added fields do not.

## Sections

Each of `fresh.submissions`, `fresh.meetings`, `fresh.won` and `fresh.calls`
has the following:

- `available`: when false, the section has only `reason` (for example, form
  submissions not yet synced, or `records.jsonl` missing). A consumer keeps
  its previous source or shows "not synced".
- `fetchedAt`: the time of the last successful sync of the section's source.
  It is the section's as-of time.
- `provenance`: `{source, rules, stage}`, which says where the rows come from,
  which rules applied, and which waterfall stage the items are.
- `count`, and `byYear` (PT calendar year → count) except in `calls`.

### `submissions`

`items` holds every form fill in the counted stage of the forms waterfall
(`forms.waterfall.counted`), oldest first. The rows are lead-source forms from
`lead-sources.json`. A row is left out when its contact is a customer, the
form is a careers or non-lead form, or the address is free-mail or internal.
`contactId` is the HubSpot contact with that address, or null when none has
it. The contact still counts. `count` equals `forms.total`. `oct13` takes
customers, careers forms and non-lead forms out, and keeps free-mail and
internal addresses, the same basis as the extract's `oct13.forms`.

### `meetings`

`items` holds every meeting-link booking (`hs_meeting_source` =
`MEETINGS_PUBLIC`) in the counted stage (`meetings.bookings.counted`). The
rules take out customer bookings, bookings already past Discovery at
`hs_createdate`, and bookings whose contacts are all free-mail or internal.
Items are sorted by booking time. `contacts`, `companies` and `deals` are
HubSpot ids.

`salesDeal` is `{id, stageId, stageAtBooking, matchedBy}` or null. It is the
Sales deal the fresh app links a booking to: a Sales Pipeline deal on the
meeting, or else one at a linked company, the newest by create date.
`stageAtBooking` comes from the dealstage history. It is null when the deal
did not exist yet or no history is synced. Deal names are in
`workspace.json` `deals` (open), `closed.lost`, and `fresh.won.items`.

`oct13` has `{overall, y<year>, customerExcluded, pastDiscovery,
publicBookings}`, taken from `meetings.bookings`: after-rules overall and for
the current year, customers, past-Discovery, and all meeting-link bookings.

### `won`

`items` holds closed-won Sales Pipeline deals not owned by customer success,
sorted by close date. `owner` is null when `workspace.json` names that owner
nowhere else (see Privacy). `closed.won` keeps its meaning (all Sales
Pipeline wins).

### `calls`

`dealActivity` is keyed by Sales Pipeline deal id. It covers every deal that
has a prospect call or a HubSpot meeting:

- `calls`: distinct PT days with a prospect call on the deal, from Strategy's
  `records.jsonl` (`audience` = `prospect`, `deal.id`).
- `lastCall`: the latest of those days (`YYYY-MM-DD`).
- `nextStep`: the first next step of the latest call that has one. Fathom link
  fragments are skipped.
- `meetings`: sorted start times of every HubSpot meeting (any source) on the
  deal or at one of its companies.

Without `records.jsonl` the whole section is unavailable, including
`meetings`, which comes from HubSpot alone. A consumer keeps its previous
source for all of it.

`callsThrough` is the newest prospect-call day in `records.jsonl`, so it shows
how current the call records are. `fetchedAt` is the HubSpot sync (the meeting
times).

## Rules

The rules are the Oct 13 2026 reporting rules (`config/lead-rules.json`
`reporting`, `ReportingScope` in `scripts/workspace-data.py`). They are the
same functions the form counts and `meetings.bookings` use, so `fresh` always
agrees with those figures. These rules differ from the extract's own scope
step (the fresh app's `src/scope.js`) in three places, which accounts for
small count differences:

- **Free mail.** The reporting rules use the free-mail list in
  `config/lead-rules.json`. The app's list is longer and adds country variants.
- **Meeting owner.** The app also drops a booking owned by a customer-success
  owner. The reporting rules decide by the booking's contacts and deals.
- **Excluded pipelines.** The app drops a booking on a Customer Success,
  Renewal or Partnerships deal. The reporting rules only drop the deal itself:
  the booking counts unless a contact is a customer or the deal is owned by
  customer success.

## Times

Each section's time is called `fetchedAt`, not `asOf`. `fetchedAt` is one of
the volatile keys that the sync's content hash (`refresh/run.py`
`VOLATILE_KEYS`) and the preview refresh (`workspace/refresh/workspace-json.mjs`)
ignore. An `asOf` key that changed on every run would make every
15-minute run publish. The sources are:

- `submissions`: the `hubspot_forms` sync row.
- `meetings`, `won` and `calls`: the `hubspot` sync row.

They are the same values as `freshness[].lastOkAt`.

## Privacy

`fresh` carries contact ids only. It has no person names, no emails, and no
job titles.

- **Meeting titles.** These usually name the attendees, so `hs_meeting_title`
  is present only for meetings that `meetings.items` already shows (and
  scrubs). Otherwise a consumer labels a booking from `fresh.companies` or
  `salesDeal`. Attendee names for listed meetings are in `meetings.items`.
- **Next steps.** These are free text. `nextStep` is set only when that exact
  text is on a call in `calls.items` (the calls list window), and
  `nextStepCallId` names that call.
- **Owner names.** These appear in `fresh.owners` and `won[].owner` only when
  `workspace.json` already shows that name, as an open or lost deal's owner, a
  listed meeting's owner, or a listed call's recorder.
- **Company and deal names.** `fresh.companies`, `won.items[].company` and
  `won.items[].name` are HubSpot's names, unfiltered, as in `deals` and
  `closed.lost`. Most of them appear nowhere else in `workspace.json`, because
  the other sections list only open and lost deals. The file is served behind
  Google sign-in, like the rest of `workspace.json`.

The whole file goes through the hidden-owner scrub as before. The build fails
if a scrub pattern remains.

## Size

`fresh` is a few hundred KB. `workspace.json` must stay under `MAX_BYTES`
(3 MiB, `workspace/refresh/workspace-json.mjs`), because the preview refresh
rejects a larger file and keeps the last good copy. If the whole file would
be over that budget, `fresh` becomes `{version, contract, available: false,
reason}`, the script logs a warning, and the rest of the file is unaffected.
An error while building `fresh` has the same result, so `fresh` can never
stop `workspace.json` from publishing.

# `strategy.json` (contract, version 1)

Strategy's lifecycle and funnel analysis needs these things from HubSpot that
`workspace.json` does not carry at the contact level:

- contact → deal associations
- contact lifecycle stage and dates
- conversion events (lead → MQL)
- meeting-link bookings, with each deal's stage history
- complete lead totals: every first form fill, by month
- which scheduling page is which meetings link

`scripts/workspace-data.py` writes them on every sync to their own file,
`strategy.json`, next to `workspace.json` (`--strategy-out`, default
`strategy.json` in `--out`'s directory). It reads from brain.db, which
`refresh/brain-sync/hubspot_sync.py` fills.

## Where it is

The refresh (`refresh/run.py`) publishes it in the same run as
`workspace.json`: `published/<runId>/strategy.json` beside
`published/<runId>/workspace.json`, listed in that run's `MANIFEST.txt` and
in its content hash. `published/LATEST.json` points at the run (`prefix`), so
the file is `<LATEST.prefix>strategy.json`. A run without it (the build or
the write failed) still publishes `workspace.json`. The preview Lambda copies
only `workspace.json`; read `strategy.json` from the published run.

`workspace.json` keeps a small pointer under its last key, `strategy`:

```
strategy: {
  version: 1, contract: "docs/workspace-strategy.md",
  available: true | false,        // the same as strategy.json's
  file: "strategy.json" | null,   // null: the file could not be written this run
  bytes: N | null,                // strategy.json's size
  counts: {...},                  // strategy.json's counts (when available)
  reason: "..."                   // when not available
}
```

The pointer is added after the budget check that can leave `fresh` out.
Every other key of `workspace.json` is the same with or without it.
`scripts/tests/test_workspace_strategy.py` checks this. The one-page
workspace does not read `strategy`.

## Budget

`strategy.json` has its own budget, `STRATEGY_MAX_BYTES`: 25 MiB, or the
`STRATEGY_MAX_BYTES` environment variable (bytes). `workspace.json`'s 3 MiB
budget does not include it. Over its budget the section is trimmed as below.

## Privacy

Only HubSpot ids appear. There are no contact names, emails, phone numbers or
job titles, and no deal or company names. Conversion event names are
HubSpot's: a form name plus a page title, or a meetings link. They pass
through the same scrub as the rest of the file, as do the link slugs in
`bookingPages`. A section that still matches
a scrub pattern is left out.

## Shape

```
strategy.json: {
  version: 1, contract: "docs/workspace-strategy.md", available: true, about,
  contactsScope: "all" | "core: ...",
  stages: [{pipeline, pipelineLabel, id, label, order, closed}],     // every pipeline's stages
  contacts: {fields: [...], rows: [[...], ...]},                     // one row per contact, columns in `fields` order
  conversionEvents: [name, ...],                                     // contacts.rows firstConversion / recentConversion index this
  dealStageHistory: {<dealId>: {pipeline, stageId, created, entered: [[stageId, enteredAt], ...] | null,
                                contactIds: [contactId, ...]}},                        // the deal's side of dealIds
  leadFirstFillsByMonth: {"YYYY-MM": n},                             // over every contact, never trimmed
  leadFirstFillsOut: {customer, careers, internal, freeMail, meetingLink, noEventName, noDate},  // only the non-zero ones
  bookingPages: {<schedulingPageId>: {bookings, contacts, slug, slugContacts, bookADemo}},
  synced: {lifecycleDates: [...], conversionEvents, conversionCount, meetingSource, schedulingPage,
           stageHistory, dealContactsReread},
  counts: {contacts, withDeals, contactDealPairs, withConversions, bookers, bookADemo,
           byLifecycle: {...}, byScope: {...}, deals, dealsWithHistory, dealsWithContacts}
}
```

When the section cannot be built, or would not fit, `strategy.json` is
`{version, contract, available: false, reason}`.

Contacts are rows rather than objects to save space. Repeating the keys
would cost about 90 bytes per contact. To read a row: `Object.fromEntries(fields.map((f, i) => [f, row[i]]))`.

### `contacts.fields`

| Field | Source (HubSpot) | Notes |
|---|---|---|
| `id` | contact `hs_object_id` | |
| `lifecyclestage` | `lifecyclestage` | Current value |
| `leadAt`, `mqlAt`, `sqlAt`, `opportunityAt`, `customerAt` | `hs_v2_date_entered_<stage>`, else `hs_lifecyclestage_<stage>_date`, for `lead`, `marketingqualifiedlead`, `salesqualifiedlead`, `opportunity`, `customer` | ISO UTC to the second. See [Lifecycle dates](#lifecycle-dates). `synced.lifecycleDates` lists the columns any contact has a value for. |
| `firstConversion`, `recentConversion` | `first_conversion_event_name`, `recent_conversion_event_name` | Index into `strategy.conversionEvents`, or null. A meeting booking overwrites `recent_*`. |
| `firstConversionAt`, `recentConversionAt` | `first_conversion_date`, `recent_conversion_date` | |
| `conversions` | `num_conversion_events` | Integer or null |
| `firstMeetingSource` | `hs_meeting_source` of the contact's earliest meeting (by `hs_createdate`) | Any source, e.g. `CRM_UI`, `MEETINGS_PUBLIC` |
| `bookings` | count of the contact's meetings with `hs_meeting_source` = `MEETINGS_PUBLIC` | The meeting-link bookings of `config/lead-rules.json` `reporting.meetings` |
| `firstBookingAt`, `firstBookingPage` | the earliest booking's `hs_createdate` and `hs_created_by_scheduling_page` | |
| `bookADemo` | true when any booking's scheduling page is in `config/lead-rules.json` `mql.bookingLinkIds` | This is the website book-a-demo page, the lead → MQL numerator (Oct 13 validation) |
| `dealIds` | contact ↔ deal associations | The union of `hubspot_associations`, which is refreshed for changed contacts and deals, and `hubspot_deal_extras.contact_ids`, which re-reads every deal's contacts every 6 h |
| `scope` | the reporting rules (`ReportingScope`) | `customer`, `internal`, `freeMail` or null (in scope) |

The rows include a contact that has any of:

- a deal
- a conversion (`num_conversion_events` > 0 or a first conversion event)
- a meeting-link booking
- an MQL, SQL, opportunity or customer date
- a lifecycle stage past lead

Contacts that are only leads are left out, which is most of the portal.

Over `STRATEGY_MAX_BYTES`, the rows keep only the core contacts: those with a deal, a
booking, an MQL/SQL/opportunity/customer date, or a stage past lead.
`contactsScope` then says `core: ...`. If that is still over, customer-scope
contacts without a deal go too, and `contactsScope` ends in
`; customers without a deal left out`. If even that does not fit, the section
is left out. The trimmed contacts are mostly form-fill-only leads, so lead
totals must come from `leadFirstFillsByMonth`, never from counting rows.

### Lifecycle dates

The rows used to carry only `hs_lifecyclestage_*_date`, and those came back
empty. HubSpot leaves a requested property out of its answer when the portal
does not have it, and this portal answers with no `hs_lifecyclestage_*_date`
keys at all, even after a full contact backfill. The current properties are
`hs_v2_date_entered_<stage>`. The sync now asks for both, for every standard
stage. It also asks for `hs_v2_date_entered_<id>` for any custom stage that
`GET /crm/v3/properties/contacts` lists. A row reads the v2 date first and
falls back to the older one.

Contacts that were stored before this change get the new properties from the
contact backfill. The sync starts it on its own, once, with no variable set
(the props key `restart:lifecycle-v2`, see
[sync-only.md](sync-only.md#hubspot-attribution-forms-lists-and-imports)).
It resumes over several runs and stops at `HUBSPOT_BACKFILL_MAX_PAGES` pages
per run. Until it finishes, `synced.lifecycleDates` shows which columns have
any data. `scripts/check_strategy_fields.py` (check 5) fails when no contact
row has a lifecycle date. It also fails when a row's date is not the stored
property, or when `synced.lifecycleDates` does not match the stored contacts.

### `leadFirstFillsByMonth`

Every form fill is a lead (`config/lead-rules.json` `forms.everyFillIsLead`).
This counts leads by the month of their first form fill. The count runs over
every contact before any trimming, so it is complete even when the rows are
cut to core contacts.

A contact is counted when `first_conversion_event_name` is a form fill. Its
month is `first_conversion_date`, in the file's time zone (UTC-7, like
`workspace.json`). `num_conversion_events` > 0 with no event name is
counted in `noEventName`. The rest follow the reporting rules' waterfall
(`submission_out`), and `leadFirstFillsOut` counts them by reason:

| Reason | Rule |
|---|---|
| `customer` | `ReportingScope`: lifecycle stage `customer`, a customer-success owner, or a customer company (`reporting.customers`) |
| `noEventName` | conversions counted, but no first event name |
| `meetingLink` | the first conversion is a meetings-link booking (`Meetings Link: ...`), not a form fill |
| `careers` | the event names a form starting with `reporting.contacts.excludedFormNamePrefixes` (`Open Position`), or a form `lead-sources.json` marks as not a lead source |
| `internal` | email domain in `reporting.contacts.internalDomains` |
| `freeMail` | email domain in `reporting.contacts.freeMailDomains` |
| `noDate` | a form fill with no `first_conversion_date` |

These are first fills only. A contact whose first conversion was a booking
and who filled a form later is in `meetingLink`, not in a month, because the
synced properties name only the first and the most recent conversion.

### `bookingPages` and page 12536147

A meeting booked through a meetings link carries only the page id in
`hs_created_by_scheduling_page`. Neither the meeting nor any other synced
property holds the page's name or URL, and the sync does not call HubSpot's
scheduler (meeting-links) API. In the synced data, the link appears only in
a contact's conversion events: a booking sets `recent_conversion_event_name`,
and for a first conversion also `first_conversion_event_name`, to
`Meetings Link: <link slug>`.

`bookingPages` joins the two for each scheduling page. It has the page's
`MEETINGS_PUBLIC` bookings, the distinct contacts on them, and the slug most
of those contacts' first or recent conversion events name. `slugContacts` is
how many contacts name that slug; a tie goes to the first slug in sort
order. `bookADemo` is true for the ids in `config/lead-rules.json`
`mql.bookingLinkIds`.

Finding for 12536147, the `bookingLinkIds` page that `bookADemo` uses, from
the Oct 14 2026 sync: most contacts who booked through it have a meetings-link
conversion event naming the link whose slug ends in `website-book-a-demo`.
No other slug comes close. The few that differ name a sales rep's personal
link, which is expected because a later booking overwrites the recent event.
This matches the Oct 13 validation in `mql.bookingLinkEvidence`. The data the
sync already reads therefore supports 12536147 as the website book-a-demo
page, and every refresh re-checks it in `bookingPages`: the `bookADemo` page's
`slug` should end in `website-book-a-demo`. It is an inference from conversion
events, not a name HubSpot returns for the id. Confirming the name directly
would take the scheduler API, which needs another scope.

### `dealStageHistory`

This covers every deal in every pipeline. The data comes from HubSpot's
`propertiesWithHistory=dealstage`, which the sync stores in
`hubspot_deal_extras.stage_history`. `entered` lists the stages oldest first,
each with the time the deal entered it. A re-save in the same stage is not a
new entry. A deal that re-enters a stage shows that stage again. `entered` is
null until the sync has read the deal's history. Stage labels are in
`strategy.stages`.

`contactIds` lists the deal's contacts. It uses the same sources as
`contacts.rows` `dealIds`: `hubspot_associations` in both directions, plus
`hubspot_deal_extras.contact_ids`. It is on every deal, including when the
rows are trimmed to core contacts. A contact with a deal is always a core
contact. An empty list means the synced tables have no contact for the deal.

### Contact ↔ deal associations: what was missing (Oct 15 2026)

Strategy still reported that it was blocked on contact → deal associations
after `dealIds` shipped. The Oct 14 brain.db snapshot was checked against the
published payload built from it. None of the suspected causes held:

- **Associations not read:** no. Every deals ↔ contacts pair in
  `hubspot_associations` is in `dealIds`.
- **Ids dropped by a trim:** no. The file was well under its 25 MiB budget,
  with `contactsScope: all`. A contact with a deal is never trimmed.
- **Wrong file:** no, not any more, though it is the likely cause of the
  report. This is inferred from the reader's history, not observed in a run.
  Strategy's loader follows
  `published/LATEST.json` to `<prefix>strategy.json`. Its earlier reader took
  `strategy.contacts` from `workspace.json`. When the section moved to its
  own file (`strategy.json`, sync image `sync-only-a61606f`), that reader got
  only the pointer until it was switched over.
- **`hubspot_deal_extras` sparse:** `stage_history` is filled for every deal.
  `contact_ids` exists only on the live sync, where it adds to the pairs
  above.

What was actually missing:

1. **No deal side.** Associations existed only as `dealIds` on contact rows.
   To link a deal's dealstage history back to its contacts, the rows had to
   be inverted. A deal with no contact was indistinguishable from one whose
   contact had been dropped.
2. **Unlinked deals are real.** About one deal in five has no contact in the
   tables. Each of those deals was looked up in HubSpot on Oct 15, and every
   one has `num_associated_contacts` = 0. The analysis must treat them as
   having no contact, not as missing data.

`dealStageHistory.<deal>.contactIds` and `counts.dealsWithContacts` now give
the deal side, and `scripts/check_strategy_fields.py` reconciles all four of
Strategy's fields to the tables:

```
python3 scripts/check_strategy_fields.py --db brain.db --strategy strategy.json
```

It prints counts only, never ids, and exits 1 when a field has no coverage
or a count differs from its table. The fields it checks are associations
(both sides), lifecycle stage, dealstage entered-at, and the first
conversion / meeting source / booking.

## Version

A change that removes or re-types a field bumps `version`. Added fields do
not.

# `workspace.json` → `strategy` (contract, version 1)

Strategy's lifecycle and funnel analysis needs four things from HubSpot that
the rest of `workspace.json` does not carry at the contact level:

- contact → deal associations
- contact lifecycle stage and dates
- conversion events (lead → MQL)
- meeting-link bookings, with each deal's stage history

`scripts/workspace-data.py` writes them under the top-level key `strategy` on
every sync. It reads from brain.db, which `refresh/brain-sync/hubspot_sync.py`
fills.

The change is additive. `strategy` is the last key in the file, and it is
added after the budget check that can leave `fresh` out. Every other key is
the same with or without it. `scripts/tests/test_workspace_strategy.py`
checks this. The one-page workspace does not read `strategy`.

## Privacy

Only HubSpot ids appear. There are no contact names, emails, phone numbers or
job titles, and no deal or company names. Conversion event names are
HubSpot's: a form name plus a page title, or a meetings link. They pass
through the same scrub as the rest of the file. A section that still matches
a scrub pattern is left out.

## Shape

```
strategy: {
  version: 1, contract: "docs/workspace-strategy.md", available: true, about,
  contactsScope: "all" | "core: ...",
  stages: [{pipeline, pipelineLabel, id, label, order, closed}],     // every pipeline's stages
  contacts: {fields: [...], rows: [[...], ...]},                     // one row per contact, columns in `fields` order
  conversionEvents: [name, ...],                                     // contacts.rows firstConversion / recentConversion index this
  dealStageHistory: {<dealId>: {pipeline, stageId, created, entered: [[stageId, enteredAt], ...] | null}},
  synced: {lifecycleDates: [...], conversionEvents, conversionCount, meetingSource, schedulingPage,
           stageHistory, dealContactsReread},
  counts: {contacts, withDeals, contactDealPairs, withConversions, bookers, bookADemo,
           byLifecycle: {...}, byScope: {...}, deals, dealsWithHistory}
}
```

When the section cannot be built, or would not fit, it is
`{version, contract, available: false, reason}`.

Contacts are rows rather than objects to save space. Repeating the keys
would cost about 90 bytes per contact, and `workspace.json` has a 3 MiB
budget. To read a row: `Object.fromEntries(fields.map((f, i) => [f, row[i]]))`.

### `contacts.fields`

| Field | Source (HubSpot) | Notes |
|---|---|---|
| `id` | contact `hs_object_id` | |
| `lifecyclestage` | `lifecyclestage` | Current value |
| `leadAt`, `mqlAt`, `sqlAt`, `customerAt` | `hs_lifecyclestage_{lead,marketingqualifiedlead,salesqualifiedlead,customer}_date` | ISO UTC to the second. These are the four the sync fetches. Opportunity / subscriber / evangelist dates are not synced. |
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
- an MQL, SQL or customer date
- a lifecycle stage past lead

Contacts that are only leads are left out, which is most of the portal.

Over budget, the rows keep only the core contacts: those with a deal, a
booking, an MQL/SQL/customer date, or a stage past lead. `contactsScope`
then says `core: ...`. If even that does not fit, the section is left out.

### `dealStageHistory`

This covers every deal in every pipeline. The data comes from HubSpot's
`propertiesWithHistory=dealstage`, which the sync stores in
`hubspot_deal_extras.stage_history`. `entered` lists the stages oldest first,
each with the time the deal entered it. A re-save in the same stage is not a
new entry. A deal that re-enters a stage shows that stage again. `entered` is
null until the sync has read the deal's history. Stage labels are in
`strategy.stages`.

## Version

A change that removes or re-types a field bumps `version`. Added fields do
not.

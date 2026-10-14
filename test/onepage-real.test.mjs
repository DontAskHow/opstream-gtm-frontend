// Optional real-data run: the whole pipeline against the real brain.db and the
// Strategy / Pipeline files, each figure recomputed independently or checked as an invariant. Skipped when the files
// are absent (CI, other machines). Output goes to a temp dir, never the repo.
// Paths: BRAIN_DB, GTM_INSIGHTS_DIR, GTM_PRIOR_EXPORT, GTM_CURRENT_PAGE, GTM_REFRESH_JSON,
// GTM_INPUTS_DIR (the sync job's inputs: lead-sources.json, records.jsonl, …, scrub-patterns.txt), GTM_LEMLIST_SNAPSHOT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build, scrubPatterns } from '../onepage/build.mjs';
import { validateWorkspace, contentHash } from '../workspace/refresh/workspace-json.mjs';
import { checkBuild } from '../onepage/deploy-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = (k, d) => process.env[k] || d;
const DB = env('BRAIN_DB', '/workspace/numaudit/brain.db');
// The sync job's inputs directory (copied from s3://…/state/gtm-inputs/), incl. scrub-patterns.txt.
const INPUTS = env('GTM_INPUTS_DIR', '/workspace/gtm-redesign/gtm-inputs');
const PRIOR = env('GTM_PRIOR_EXPORT', '/workspace/gtm-data/live_deals.json');
const PAGE = env('GTM_CURRENT_PAGE', '/workspace/numaudit/data.json');
const REFRESH = env('GTM_REFRESH_JSON', '/workspace/numaudit/refresh.json');
const LEMLIST_SNAPSHOT = env('GTM_LEMLIST_SNAPSHOT', '/workspace/gtm-data/marketing.json');
const PATTERNS_FILE = env('WORKSPACE_SCRUB_PATTERNS_FILE', join(INPUTS, 'scrub-patterns.txt'));
const present = [DB, join(INPUTS, 'lead-sources.json'), join(INPUTS, 'records.jsonl'), join(INPUTS, 'lead-source-review.csv'), join(INPUTS, 'paid-deals.json'), PATTERNS_FILE].every(existsSync);
const RULES = JSON.parse(readFileSync(join(ROOT, 'config', 'lead-rules.json'), 'utf8'));

// No fixed figures: brain.db and the inputs move with every sync. Each figure is either
// recomputed here independently of scripts/workspace-data.py (straight from brain.db, the
// Lead Tracker rows, records.jsonl and the input files) or checked as an invariant
// (categories sum to totals, subsets stay subsets). Fixed values live in the synthetic tests.
const py = (code) => JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf8' }));

test('real data: figures equal independent computations and invariants, end to end', { skip: !present && `real inputs not present (${DB})` }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-real-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const asOf = existsSync(REFRESH) ? JSON.parse(readFileSync(REFRESH, 'utf8')).refreshedAt : new Date().toISOString();
  const opt = (flag, p) => (existsSync(p) ? [flag, p] : []);
  process.env.WORKSPACE_SCRUB_PATTERNS_FILE = PATTERNS_FILE;
  const pyEnv = { ...process.env, WORKSPACE_SCRUB_PATTERNS: '', CALL_CLASSIFICATION: '', LEAD_SOURCE_REVIEW: '', PAID_EXPORT: '' };
  // As the sync job runs it, plus --as-of (the audit time) and the current page for the cross-check.
  const dataStep = (out, extra = []) => execFileSync('python3', [join(ROOT, 'scripts', 'workspace-data.py'), '--db', DB, '--inputs-dir', INPUTS,
    '--portal-id', '12345', ...opt('--prior', PRIOR), '--out', out, '--quiet', ...extra], { env: pyEnv });
  dataStep(join(dir, 'workspace.json'), ['--as-of', asOf, ...opt('--current-page', PAGE)]);
  const { view, html } = build({ data: join(dir, 'workspace.json'), out: join(dir, 'out'), quiet: true });
  const text = readFileSync(join(dir, 'workspace.json'), 'utf8');
  const d = JSON.parse(text);
  const report = [];
  const check = (name, got, want) => {
    const ok = String(got) === String(want);
    report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got}${ok ? '' : ' (expected ' + want + ')'}`);
    assert.equal(String(got), String(want), name);
  };

  // Independent computations from brain.db and the inputs (no workspace-data.py code).
  const indep = py(`
import sqlite3, json, re, csv, os
c = sqlite3.connect('file:${DB}?mode=ro', uri=True)
INPUTS = ${JSON.stringify(INPUTS)}
st = {(p, s): (l, cl, pr) for p, s, l, cl, pr in c.execute('select pipeline_id, stage_id, stage_label, is_closed, probability from hubspot_pipelines')}
o = [0, 0.0, 0.0]; h = [0, 0.0]; lost = {}
for (pj,) in c.execute("select properties_json from hubspot_objects where object_type='deals'"):
    p = json.loads(pj)
    if p.get('pipeline') != 'default': continue
    l, cl, pr = st[('default', p['dealstage'])]
    a = float(p.get('amount') or 0)
    if cl:
        if float(pr or 0) < 1: lost[l] = lost.get(l, 0) + 1   # closed and not won
        continue
    if l == 'On Hold': h[0] += 1; h[1] += a; continue
    o[0] += 1; o[1] += a; o[2] += a * float(p.get('hs_deal_stage_probability') or 0)
camps = [json.loads(r).get('stats') or {} for (r,) in c.execute('select raw_json from lemlist_campaigns')]
failing = sorted(s for (s,) in c.execute('select source from sync_outcomes where not ok'))
synced = sorted(s for (s,) in c.execute('select source from sync_outcomes'))
# Calls: every Fathom recording, by Strategy's audience in records.jsonl (absent: unclassified).
aud = {}
for line in open(os.path.join(INPUTS, 'records.jsonl'), encoding='utf-8'):
    line = line.strip()
    if not line: continue
    try: r = json.loads(line)
    except ValueError: continue
    if r.get('call_id') is not None and r.get('audience'): aud[str(r['call_id'])] = r['audience']
calls = {}
for (rid,) in c.execute('select recording_id from meetings'):
    k = aud.get(str(rid), 'unclassified'); calls[k] = calls.get(k, 0) + 1
# Leads: distinct companies on the Lead Tracker tab (one lead per company, its rows grouped), and those with an MQL or SQL date.
ls = json.load(open(os.path.join(INPUTS, 'lead-sources.json'), encoding='utf-8'))
# lead-sources.json names it "<tab> (<spreadsheet>)".
m = re.match(r'^(.*?)\\s*\\((.+)\\)\\s*$', ls['sheet']['tab'])
tab, title = (m.group(1).strip(), m.group(2).strip()) if m else (ls['sheet']['tab'], None)
title = title or c.execute('select spreadsheet_title from sheets_data where tab=? limit 1', (tab,)).fetchone()[0]
rows = [json.loads(r) or [] for (r,) in c.execute('select row_json from sheets_data where spreadsheet_title=? and tab=? order by row_num', (title, tab))]
low = lambda v: ' '.join(str(v or '').split()).lower()
hi = next(i for i, r in enumerate(rows) if r and low(r[0]).startswith('company'))
head = [low(x) for x in rows[hi]]
ix = lambda name: next(j for j, x in enumerate(head) if x.startswith(name))
ci, mi, si = ix('company'), ix('mql date'), ix('sql date')
get = lambda r, j: str(r[j]).strip() if j < len(r) and r[j] is not None else ''
dated = lambda v: bool(re.fullmatch(r'\\d{4}-\\d\\d-\\d\\d.*|\\d{1,2}/\\d{1,2}/\\d{2,4}|\\d{12,13}', v))
companies = {}
for r in rows[hi + 1:]:
    name = get(r, ci).lower()
    if name: companies[name] = companies.get(name, False) or dated(get(r, mi)) or dated(get(r, si))
# Input files.
with open(os.path.join(INPUTS, 'lead-source-review.csv'), encoding='utf-8') as f: review = sum(1 for _ in csv.DictReader(f))
paid = [x for x in json.load(open(os.path.join(INPUTS, 'paid-deals.json'), encoding='utf-8')).get('deals') or [] if (x.get('derived') or {}).get('paid_platform')]
li = json.load(open(os.path.join(INPUTS, 'lead-insights.json'), encoding='utf-8')) if os.path.exists(os.path.join(INPUTS, 'lead-insights.json')) else None
lrows = (li or {}).get('leads') or {}
insights = sum(1 for k, v in (lrows.items() if isinstance(lrows, dict) else enumerate(lrows)) if isinstance(v, dict) and (isinstance(k, str) or v.get('contact_id') or v.get('hubspot_contact_id') or v.get('contactId')))
lr = os.path.join(INPUTS, 'lost-reasons.json')
lost_ids = sorted({str(x.get('deal_id')) for x in json.load(open(lr, encoding='utf-8')).get('deals') or []}) if os.path.exists(lr) else []
# The prior export's open Sales Pipeline totals (the "what changed" baseline).
prior = None
if os.path.exists(${JSON.stringify(PRIOR)}):
    e = json.load(open(${JSON.stringify(PRIOR)}, encoding='utf-8'))
    n, amt = 0, 0.0
    for dd in e.get('deals') or []:
        pp = dd.get('properties') or {}
        sg = (e.get('stages') or {}).get(str(pp.get('dealstage'))) or {}
        if pp.get('pipeline') != 'default' or sg.get('closed') or sg.get('label') == 'On Hold': continue
        n += 1; amt += float(pp.get('amount') or 0)
    prior = [n, round(amt)]
print(json.dumps({'open': [o[0], round(o[1]), round(o[2])], 'onHold': [h[0], round(h[1])], 'lost': lost,
                  'lemlist': [len(camps), sum(s.get('replied') or 0 for s in camps), sum(s.get('messagesSent') or 0 for s in camps)],
                  'failing': failing, 'synced': synced, 'calls': calls, 'leads': len(companies), 'sheetMql': sum(companies.values()),
                  'review': review, 'paid': len(paid), 'insights': insights, 'lostIds': lost_ids, 'prior': prior}))`);
  const open = [d.headline.open.count, Math.round(d.headline.open.amount), Math.round(d.headline.open.weighted)];
  check('open deals / amount / weighted = SQL over Sales Pipeline open, non-On-Hold deals', open.join(' / '), indep.open.join(' / '));
  check('On Hold = SQL', `${d.headline.onHold.count} / ${Math.round(d.headline.onHold.amount)}`, indep.onHold.join(' / '));
  // What changed: "to" is the headline; "from" is the prior export's open totals when they differ.
  const c = d.headline.change;
  if (c) {
    check('what changed: to = headline', `${c.to.count} / ${Math.round(c.to.amount)}`, `${open[0]} / ${open[1]}`);
    if (indep.prior && (indep.prior[0] !== open[0] || indep.prior[1] !== open[1])) check('what changed: from = prior export open totals', `${c.from.count} / ${Math.round(c.from.amount)}`, indep.prior.join(' / '));
  }
  // Closed: closed-and-not-won Sales Pipeline deals by stage, from SQL.
  const by = Object.fromEntries(d.closed.lostByStage.map((x) => [x.stage, x.count]));
  check('closed not won, by stage = SQL', JSON.stringify(Object.entries(by).sort()), JSON.stringify(Object.entries(indep.lost).sort()));
  check('closed lost list = sum of stage counts', d.closed.lost.length, Object.values(indep.lost).reduce((a, b) => a + b, 0));
  const nb = d.closed.lost.filter((x) => !x.postWin);
  const r = view.closed.reasons;
  check('lost reasons cover the new-business losses', r.count, nb.length);
  check('lost-reason categories sum to the total (count / amount)', `${r.rows.reduce((a, x) => a + x.count, 0)} / ${Math.round(r.rows.reduce((a, x) => a + (x.amount || 0), 0))}`,
    `${nb.length} / ${Math.round(nb.reduce((a, x) => a + (x.amount || 0), 0))}`);
  check('lost reasons from lost-reasons.json = its deals among the new-business losses', r.fromFile, nb.filter((x) => indep.lostIds.includes(String(x.id))).length);

  // Calls: Strategy's classification, exactly: every Fathom recording counted by its records.jsonl audience.
  const sc = d.calls.scope;
  const callKeys = [...new Set([...Object.keys(indep.calls), 'prospect', 'customer', 'internal', 'partner_other'])].sort();
  check('calls by audience = records.jsonl over brain.db recordings', callKeys.map((k) => `${k} ${sc[k] || 0}`).join(', '), callKeys.map((k) => `${k} ${indep.calls[k] || 0}`).join(', '));
  check('calls: audiences sum to the total', callKeys.reduce((a, k) => a + (sc[k] || 0), 0), sc.total);
  assert.equal(d.calls.classification, 'strategy');
  assert.ok(d.calls.items.length > 0 && d.calls.items.every((x) => x.strategy), 'listed calls are prospect calls from the classification');
  assert.ok(d.calls.items.length <= sc.prospect, 'listed calls are a subset of the prospect calls');

  // Leads: one per Lead Tracker company.
  check('leads = distinct companies on the Lead Tracker', d.leads.total, indep.leads);
  check('Sheet MQL (incl. SQL) = companies with an MQL or SQL date', d.leads.mql, indep.sheetMql);
  check('lead items = total; sources partition them', `${d.leads.items.length} / ${d.leads.sources.reduce((a, s) => a + d.leads.items.filter((l) => l.source === s).length, 0)}`, `${d.leads.total} / ${d.leads.total}`);
  check('Sheet MQL = MQL flags on lead items', d.leads.items.filter((l) => l.mql).length, d.leads.mql);
  check('new lead -> MQL (r12, 90 days proposed)', d.mqlFunnel.available ? 'shown' : 'hidden', RULES.mql.show === false ? 'hidden' : d.mqlFunnel.available ? 'shown' : 'hidden');
  if (!d.mqlFunnel.available) assert.ok(!html.includes(RULES.mql.label), 'hidden entirely: no tile, no placeholder');
  if (d.mqlFunnel.computed) {
    const f = d.mqlFunnel.computed;
    assert.ok(f.numerator <= f.denominator && f.formFillers <= f.denominator && f.denominator === f.formFillers + f.bookersWithoutForm, 'bookers are inside the denominator');
  }
  const oaL = d.leads.openai;
  assert.ok(oaL.trackerNamed <= oaL.trackerAtMost && oaL.confirmed <= oaL.atMost, 'OpenAI: named <= at most');
  console.log(`OpenAI leads: Lead Tracker notes ${oaL.trackerNamed} named / at most ${oaL.trackerAtMost}; HubSpot evidence ${oaL.confirmed} named, at most ${oaL.atMost}`);
  for (const p of d.leads.platforms) check(`${p.name}: named = leads resolved to it`, p.confirmed, d.leads.items.filter((l) => l.platform === p.name).length);
  check('review list rows = lead-source-review.csv rows', d.reviewList.rows.length, indep.review);
  // Each review row follows its status: resolved -> the MQL-touch channel; undetermined -> HubSpot-primary; on_hold* -> unchanged.
  const byRow = Object.fromEntries(d.leads.items.flatMap((l) => l.rows.map((r) => [String(r), l])));
  const statuses = {};
  for (const r of d.reviewList.rows) {
    const l = byRow[r.row];
    assert.ok(l, `review row ${r.row} is a lead`);
    statuses[r.status] = (statuses[r.status] || 0) + 1;
    if (r.status === 'resolved' && r.mql_channel && r.mql_channel !== 'undetermined') assert.equal(l.source, r.mql_channel, `row ${r.row}: MQL touch`);
    else if (String(r.status).startsWith('on_hold')) assert.equal(l.source, l.sheetSource, `row ${r.row}: held`);
    else {
      // Undetermined: the HubSpot-primary source stands. The CSV's hubspot_sources is Pipeline's snapshot of HubSpot
      // and may be older than brain.db (e.g. Lemlist lead emails synced since), so the rule is checked, not the value.
      assert.notEqual(l.rule, 'MQL touch (review list)', `row ${r.row}: not credited to an MQL touch`);
      if (l.sourceBasis !== 'hubspot') assert.equal(l.source, l.sheetSource, `row ${r.row}: no HubSpot evidence, Lead Tracker source`);
      if (l.source !== r.hubspot_sources.split(/[|/,;]/)[0].trim()) statuses.movedSinceCsv = (statuses.movedSinceCsv || 0) + 1;
    }
    if (r.different_first_touch) assert.equal(l.firstTouch, r.different_first_touch);
  }
  console.log(`review list statuses: ${JSON.stringify(statuses)}`);
  // Pipeline's paid leads and deals: the predates-spend-window flag shows.
  assert.ok(d.leads.items.some((l) => l.predatesSpendWindow && l.conversionDate), 'a paid lead before its spend window is flagged with its date');
  assert.ok(d.paidDeals.sales.some((x) => x.predatesSpendWindow && x.conversionDate), 'a paid deal before its spend window is flagged');
  check('lead-insights contacts loaded = lead-insights.json entries', d.meta.leadInsights, indep.insights);
  check('paid deals = paid-deals.json deals with a paid platform', d.paidDeals.total, indep.paid);
  check('paid deals: Sales Pipeline + other pipelines = total', d.paidDeals.sales.length + d.paidDeals.otherPipelines, d.paidDeals.total);
  console.log(`paid deals in the Sales Pipeline: ${d.paidDeals.sales.length} ${JSON.stringify(d.paidDeals.byPlatform)}; ${d.paidDeals.branded} branded; ${d.paidDeals.companyLevel} company-level`);

  // Outbound reply rate (r12): every campaign, any status. Asserted against brain.db's own sums.
  const o = d.outbound;
  check('outbound reply rate (all campaigns) = brain.db sums', `${o.replies}/${o.sends} over ${o.count}`, `${indep.lemlist[1]}/${indep.lemlist[2]} over ${indep.lemlist[0]}`);
  check('outbound campaigns listed = count', o.campaigns.length, o.count);
  if (existsSync(LEMLIST_SNAPSHOT)) {
    const cs = JSON.parse(readFileSync(LEMLIST_SNAPSHOT, 'utf8')).outbound.campaignStats;
    const sum = (xs, k) => xs.reduce((a, x) => a + (x[k] || 0), 0);
    const jc = cs.filter((x) => /^Customer company -> New Company/.test(x.name));
    console.log(`Lemlist snapshot (${LEMLIST_SNAPSHOT}): all ${cs.length} campaigns ${sum(cs, 'replied')}/${sum(cs, 'sent')}; without the ${jc.length} job-changer campaigns ${sum(cs, 'replied') - sum(jc, 'replied')}/${sum(cs, 'sent') - sum(jc, 'sent')}`);
  }

  // Meetings: the fixed tiles are the in-window items of this month / from now on, bucketed.
  const asOfT = Date.parse(asOf);
  const ym = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit' }).format(new Date(t));
  const inMonth = d.meetings.items.filter((m) => m.start && ym(Date.parse(m.start)) === ym(asOfT));
  const upcoming = d.meetings.items.filter((m) => m.start && Date.parse(m.start) >= asOfT);
  const buckets = (xs) => `${xs.filter((m) => m.matched).length} / ${xs.filter((m) => !m.matched && m.linked).length} / ${xs.filter((m) => !m.linked).length}`;
  check('meetings this month (matched / unmatched / no contact) = its items', `${d.meetings.thisMonth.matched} / ${d.meetings.thisMonth.unmatched} / ${d.meetings.thisMonth.noContact}`, buckets(inMonth));
  check('meetings upcoming (matched / unmatched / no contact) = its items', `${d.meetings.upcoming.matched} / ${d.meetings.upcoming.unmatched} / ${d.meetings.upcoming.noContact}`, buckets(upcoming));
  const cp = d.scope.currentPage;
  if (cp) {
    const pg = JSON.parse(readFileSync(PAGE, 'utf8'));
    check('current page: recordings total = its companies\' recordings', cp.recordingsTotal, (pg.companies || []).reduce((a, x) => a + (x.recordings || []).length, 0));
    assert.ok(cp.companies <= (pg.companies || []).length && cp.recordings <= cp.recordingsTotal, 'removed customers are a subset of the page');
  }
  // Ad platforms: platform-reported numbers hang together.
  for (const a of d.ads.filter((x) => x.connected)) {
    if (a.landingPages.length && a.conversions != null) assert.ok(a.landingPages.every((lp) => lp.conversions <= a.conversions), `${a.name}: a landing page never exceeds the total`);
    if (a.spendDays != null && a.window) assert.ok(a.spendDays <= (Date.parse(a.window.end) - Date.parse(a.window.start)) / 864e5 + 1, `${a.name}: spend days fit the window`);
    if (a.spend != null) assert.ok(Number.isFinite(a.spend) && a.spend >= 0, `${a.name}: spend is a number`);
  }
  // Flags follow their causes: every failing sync source (SQL) is "down", stale ad reports, missing spend actuals, GA4 Unassigned share.
  const flagKeys = d.flags.map((f) => f.key);
  check('sources flagged down = failing sync_outcomes rows', d.flags.filter((f) => f.level === 'alert' && indep.synced.includes(f.key)).map((f) => f.key).sort().join(', '), indep.failing.join(', '));
  for (const a of d.ads) assert.equal(flagKeys.includes('ads-' + a.key), !!(a.connected && a.stale), `${a.name}: stale flag iff stale`);
  assert.equal(flagKeys.includes('spend'), !!(d.spend && d.spend.missingMonths && d.spend.missingMonths.length), 'spend flag iff missing actuals');
  assert.equal(flagKeys.includes('ga4'), !!(d.ga4 && d.ga4.share != null && d.ga4.share >= 0.2), 'GA4 flag iff share >= 20%');
  assert.match(html, /provisional \(awaiting \w+\)/);
  for (const pat of scrubPatterns()) assert.ok(!html.toLowerCase().includes(pat) && !text.toLowerCase().includes(pat), 'scrubbed');
  assert.ok(!/HubSpot bridge|Sheet-active|recordsOpenCount|recordsDealCount|unmatchedRecordings|<h2[^>]*>This week/i.test(html), 'bridge, records counts and the This week section are dropped');
  // fresh (docs/workspace-fresh.md): the same rules as the counts next to it; ids, not people.
  const f = d.fresh;
  check('fresh.submissions = the counted form fills', f.submissions.count, d.forms.total);
  check('fresh.meetings = the counted bookings', f.meetings.count, d.meetings.bookings.counted);
  check('fresh.meetings.oct13.overall = bookings after the rules', f.meetings.oct13.overall, d.meetings.bookings.afterRules);
  check('fresh.won within the Sales wins', f.won.count <= d.closed.won.count, true);
  const listed = new Map(d.meetings.items.map((m) => [m.id, m.title]));
  check('fresh meeting titles only where the meetings list shows them', f.meetings.items.every((m) => !('hs_meeting_title' in m) || listed.get(m.id) === m.hs_meeting_title), true);
  const shownSteps = new Set(d.calls.items.flatMap((c) => (c.strategy && c.strategy.nextSteps) || []));
  check('fresh next steps only where the calls list shows them', Object.values(f.calls.dealActivity).every((a) => !a.nextStep || shownSteps.has(a.nextStep)), true);
  const ownText = JSON.stringify({ ...f, meetings: f.meetings.items.map(({ hs_meeting_title: _t, ...m }) => m), calls: Object.values(f.calls.dealActivity).map(({ nextStep: _s, ...a }) => a) });
  check('fresh carries no email address', /[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(ownText), false);
  // The published file: the Lambda's checks, the size budget, the deployable page, a stable content hash.
  const patterns = scrubPatterns();
  const v = validateWorkspace(text, patterns);
  assert.deepEqual(v.errors, [], 'the refresh Lambda accepts it');
  check('workspace.json under the 3 MB budget', Buffer.byteLength(text) < 3 * 1048576, true);
  console.log(`workspace.json: ${Math.round(Buffer.byteLength(text) / 1024)} KB`);
  build({ app: true, out: join(dir, 'app'), quiet: true });
  assert.equal(checkBuild(join(dir, 'app'), { app: true, patterns }).ok, true);
  assert.equal(checkBuild(join(dir, 'out'), { patterns }).ok, true);
  dataStep(join(dir, 'a.json'));
  dataStep(join(dir, 'b.json'));
  const [a, b] = ['a.json', 'b.json'].map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  assert.notEqual(a.meta.generatedAt, b.meta.generatedAt);
  check('same data, new run: same content hash (no spurious publish)', contentHash(a) === contentHash(b), true);
  console.log(report.join('\n'));
});

// The Oct 13 2026 reporting rules against the figures their owners expect on real data. The expected figures live
// outside this public repo: GTM_RULES_EXPECTED names a JSON file (forms, meetings, adLeads, tolerance). Figures that
// need fields only the new sync writes (dealstage history, hs_analytics_first_url) are checked once those are in
// brain.db; until then the test says so and checks what bounds them.
const EXPECTED = process.env.GTM_RULES_EXPECTED;
test('real data: Oct 13 reporting rules match the expected figures', { skip: (!present && `real inputs not present (${DB})`) || (!(EXPECTED && existsSync(EXPECTED)) && 'GTM_RULES_EXPECTED not set') }, (t) => {
  const exp = JSON.parse(readFileSync(EXPECTED, 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'onepage-real-rules-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'workspace.json');
  execFileSync('python3', [join(ROOT, 'scripts', 'workspace-data.py'), '--db', DB, '--inputs-dir', INPUTS, '--portal-id', '12345', '--out', out, '--quiet'],
    { env: { ...process.env, WORKSPACE_SCRUB_PATTERNS: '', WORKSPACE_SCRUB_PATTERNS_FILE: PATTERNS_FILE, CALL_CLASSIFICATION: '', LEAD_SOURCE_REVIEW: '', PAID_EXPORT: '' } });
  const d = JSON.parse(readFileSync(out, 'utf8'));
  const report = [];
  const near = (name, got, want) => {
    const ok = Math.abs(got - want) <= Math.max(exp.tolerance.abs, (want * exp.tolerance.pct) / 100);
    report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got} (expected ${want}, ${got - want >= 0 ? '+' : ''}${got - want})`);
    assert.ok(ok, `${name}: ${got}, expected ${want}`);
  };
  const later = (name, why) => { report.push(`AFTER-SYNC  ${name}: ${why}`); t.diagnostic(`${name}: verifiable after the next sync (${why})`); };

  // Forms: submissions of every lead-sources.json form, customers out (the stage the expected figures describe);
  // careers forms, free-mail and internal addresses come out after that, and the breakdown accounts for the gap.
  const f = d.forms;
  assert.equal(f.available, true);
  for (const [k, want] of Object.entries(exp.forms)) if (k !== 'stage') near(`forms ${k} (${exp.forms.stage})`, f.waterfall[exp.forms.stage][k] || 0, want);
  const sum = (o) => Object.values(o).reduce((a, x) => a + x, 0);
  assert.equal(sum(f.waterfall.afterCustomers) - sum(f.waterfall.counted), (f.excluded.careers || 0) + (f.excluded.freeMail || 0) + (f.excluded.internal || 0));
  assert.equal(sum(f.waterfall.all) - sum(f.waterfall.afterCustomers), f.excluded.customer || 0);
  report.push(`INFO  forms shown (customers, careers, free-mail, internal out): ${JSON.stringify(f.waterfall.counted)}; first conversion: ${JSON.stringify(f.firstConversion.afterCustomers)}`);

  // Meeting-link bookings.
  const b = d.meetings.bookings;
  const y = b.byYear['2026'] || {};
  near('bookings before the rules', b.total, exp.meetings.before);
  near('bookings 2026 before the rules', y.total || 0, exp.meetings.before2026);
  near('bookings excluded as customer', b.customer, exp.meetings.customer);
  if (b.stageHistorySynced) {
    near('bookings excluded as past-Discovery opportunities', b.opportunity, exp.meetings.opportunity);
    near('bookings after the rules', b.afterRules, exp.meetings.after);
    near('bookings 2026 after the rules', y.afterRules || 0, exp.meetings.after2026);
  } else {
    // Without stage history only customers are out, so the count is the expected one plus at most the opportunities.
    assert.equal(b.opportunity, 0);
    assert.ok(b.afterRules >= exp.meetings.after - exp.tolerance.abs && b.afterRules <= exp.meetings.after + exp.meetings.opportunity + exp.tolerance.abs, 'customers-only count bounds the final one');
    later('bookings after the rules', `dealstage history not in brain.db; customers out only: ${b.afterRules} (2026: ${y.afterRules})`);
  }

  // Ad platforms: HubSpot-sourced leads; organic ChatGPT referrals apart; platform figures are events, not leads.
  const a = d.adLeads;
  near('ChatGPT organic AI-referral leads', a.aiReferral.leads, exp.adLeads.chatgptOrganic);
  const oa = a.platforms.find((p) => p.key === 'openai');
  if (a.firstUrlSynced) {
    report.push(`${oa.leads >= exp.adLeads.openaiPaidMin && oa.leads <= exp.adLeads.openaiPaidMax ? 'PASS' : 'FAIL'}  OpenAI paid leads: ${oa.leads}`);
    assert.ok(oa.leads >= exp.adLeads.openaiPaidMin && oa.leads <= exp.adLeads.openaiPaidMax, `OpenAI paid leads ${oa.leads}`);
  } else later('OpenAI paid leads', `hs_analytics_first_url not in brain.db; ${oa.leads} today`);
  for (const x of d.ads.filter((x) => x.connected)) assert.equal(x.figureLabel, 'platform-reported events, not leads');
  console.log(report.join('\n'));
});

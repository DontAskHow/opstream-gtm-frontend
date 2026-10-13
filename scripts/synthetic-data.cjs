// Entirely invented records for the public UI demo. No production inputs are read.
const fs=require('node:fs');
function writeDemo(){
const owners=[{id:'alex',name:'Alex Morgan',email:'alex@example.com'},{id:'sam',name:'Sam Rivera',email:'sam@example.com'}];
const names=['Northstar Labs','Cedar Harbor','Juniper Works','Bluebird Systems'];
const evidence={},companies=[],opportunities=[],priorities=[],drafts=[];
for(let i=0;i<4;i++){
 const id='demo-'+i,name=names[i],owner=owners[i%2].name,ref='demo-evidence-'+i,amount=30000+i*15000;
 const note='Synthetic discovery: the team wants a simpler approval process. Agree on a small pilot and define measurable success criteria.';
 evidence[ref]={ref,nativeId:id,source:'Synthetic CRM',capturedAt:'2026-09-08',title:name+' — pilot discussion',content:note,fields:{owner,stage:'Discovery',amount}};
 const deal={id:'deal-'+id,name:name+' pilot',stage:'discovery',stageLabel:'Discovery/RFP received',amount,currency:'USD',probability:25,close:'2026-12-01',created:'2026-08-01',owner,closed:false,history:[{date:'2026-09-01',label:'Discovery'}],amountHistory:[],closeHistory:[],refs:[ref]};
 const recording={id:'recording-'+id,nativeId:'recording-'+id,title:name+' — Sample discovery',date:'2026-09-07T15:00:00Z',minutes:25,recordedBy:owner,invitees:[{name:'Taylor Example',email:'taylor@example.com'}],summary:[{t:'p',x:note}],actions:['Schedule a synthetic pilot review.'],hasTranscript:true,transcriptLines:2,refs:[ref]};
 companies.push({id,name,owner,domain:'example.com',industry:'Software',description:'Fictional company used to demonstrate the workspace.',employees:120,city:'Sample City',country:'Example',lifecycle:'opportunity',created:'2026-08-01',deals:[deal],contacts:[{name:'Taylor Example',email:'taylor@example.com',title:'Operations Lead',refs:[ref]}],notes:[{id:'note-'+id,date:'2026-09-07',text:note,owner,refs:[ref]}],meetings:[{id:'meeting-'+id,title:'Pilot review',start:'2026-09-15T15:00:00Z',outcome:'SCHEDULED'}],tasks:[],calls:[],recordings:[recording],related:[],refs:[ref],completedInteractions:[{date:'2026-09-07',source:'Synthetic discovery',refs:[ref]}],lastContact:'2026-09-07'});
 opportunities.push({id,companyId:'company:'+id,name,owner,stage:deal.stageLabel,amount,probability:.25,close:'2026-12-01',days:7+i,note,refs:[ref]});
 priorities.push({id:'priority-'+id,title:'Agree on the '+name+' pilot',why:'The fictional discovery is complete; scope and success measures are the next decisions.',next:'Review the sample account and prepare a concise follow-up.',caveat:'Synthetic data — no real customer or commitment.',accountIds:['company:'+id],refs:[ref],primary:{label:'Open account',target:{kind:'account',id:'company:'+id}},secondary:{label:'Review draft',target:{kind:'draft',id:'draft-'+id}}});
 drafts.push({id:'draft-'+id,purpose:i===3?'internal-note':'email',title:name+' — next steps',subject:name+' — next steps',text:'Hi Taylor,\n\nHere is a fictional follow-up for the demo. Shall we agree on one pilot workflow and its success criteria?\n\nThanks,\n'+owner,rationale:'Synthetic discovery follow-up.',recipients:'taylor@example.com',cc:'',bcc:'',internalNotes:'Demo only.',campaignSender:'',company:name,accountIds:['company:'+id],supportRefs:[ref],refs:[ref],status:'Draft',version:1,updatedAt:'2026-09-08T12:00:00Z',history:[],contentMode:'default'});
 fs.mkdirSync('out/data/transcripts',{recursive:true});fs.writeFileSync('out/data/transcripts/'+recording.id+'.json',JSON.stringify([{speaker:owner,timestamp:'00:00',text:'This is a synthetic demonstration transcript.'},{speaker:'Taylor Example',timestamp:'00:10',text:'Let us define the pilot and success criteria.'}]));
}
const leads=Array.from({length:24},(_,i)=>({id:'lead-'+i,name:names[i%4],source:['Inbound','Outbound','Webinar'][i%3],owner:owners[i%2].name,lead:'2026-08-'+String(1+i).padStart(2,'0'),mql:i%2?'2026-09-01':null,sql:i%4?'2026-09-05':null,note:'Fictional sample lead.'}));
const verified={snapshotId:'synthetic-v1',meta:{owners},opportunities,leads,drafts:drafts.map(draft=>({draft})),draftVersions:{},evidenceKeys:{},presentation:{priorities,priorityReview:{id:'synthetic-review',asOf:'2026-09-08',scope:'All records and metrics in this public demo are synthetic.'},suggestedDrafts:[],upcoming:companies.map(c=>({date:'2026-09-15',title:c.name+' pilot review',prep:'Review goals and next steps.',target:{kind:'account',id:'company:'+c.id}}))},quick:{leads:24,mql:12,sql:18},report:{meetings:{start:'2026-07-01',end:'2026-09-08',completed:12,recorded:4},pipeline:{weighted:{value:52500},stages:[{stage:'Discovery/RFP received',count:4,amount:210000}],scorecard:[{label:'Active deals',value:4},{label:'Discovery calls',value:12}]},spend:{months:['01','02','03','04','05','06','07','08','09'].map((m,i)=>({month:'2026-'+m,planned:5000+i*500,actual:i===8?null:4500+i*400})),channels:[{name:'Events',amount:12000},{name:'Paid',amount:8000}],campaigns:[{name:'Sample introduction',sent:100,replies:12,bounces:2,linkedinSent:25,linkedinReplies:3}],advertising:[]}},web:{start:'2026-07-01',end:'2026-09-08',sessions:1200,engaged:.6,engagedSessions:720,pageViews:2400,aiCited:.25,aiMentioned:.3,aiCount:100,aiEnd:'2026-09-08',visits:Array.from({length:8},(_,i)=>({date:'2026-08-'+String(i*3+1).padStart(2,'0'),value:100+i*20})),channels:[{name:'Organic search',sessions:700,engagedSessions:420,keyEvents:30},{name:'Direct',sessions:500,engagedSessions:300,keyEvents:20}],pages:[{name:'/',sessions:900,engagedSessions:540,keyEvents:35},{name:'/demo',sessions:300,engagedSessions:180,keyEvents:15}]}};
const records={verifiedSnapshotId:'synthetic-v1',generatedAt:'2026-09-08',companies,unmatchedRecordings:[],coverage:{foldedRelated:0,contacts:4,notes:4,fathomTotal:4,transcripts:4}};
for(const [name,value]of Object.entries({verified,records,evidence,'draft-seeds':drafts,'evidence-sheet-labels':{},bootstrap:{user:{id:'demo-user',name:'Demo User',email:'demo@example.com',owner:true},preferences:{mode:'cs',ratings:{},draftModes:{},priorityContext:{}},preferencesRevision:0,drafts,comments:[],connections:{google:{connected:false,configured:false},slack:{connected:false,configured:false}},imported:true,sends:[],campaignSenders:[]}}))fs.writeFileSync('out/data/'+name+'.json',JSON.stringify(value,null,2));
}

// ---------- synthetic brain for the one-page workspace (scripts/workspace-data.py) ----------
// Invented companies, people and figures only. brainFixture({synced}) returns the
// brain.db tables (scripts/fixture-db.py writes them to SQLite), the side inputs
// (lead-sources.json, lost-reasons.json, insights.json, lead-insights.json, a prior
// HubSpot export, a current-page data.json) and the figures the tests expect.
// synced: true adds the tables and contact fields the parallel sync change adds.
// The scrub pattern the synthetic data plants (tests pass it as WORKSPACE_SCRUB_PATTERNS).
const SYNTHETIC_SCRUB = 'quill';
// The book-a-demo scheduling page id the rules match (an id, not a name).
const BOOK_A_DEMO_PAGE = require('../config/lead-rules.json').mql.bookingLinkIds[0];
function brainFixture({ synced = false, scrub = SYNTHETIC_SCRUB } = {}) {
  const path = require('node:path');
  const scope = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'workspace-scope.json'), 'utf8'));
  const pat = scrub;
  const hiddenFirst = pat[0].toUpperCase() + pat.slice(1);
  const AS_OF = '2026-10-13T16:00:00Z';
  const DOM = 'opstream.example';
  const T = {};
  const table = (name, columns) => (T[name] = { columns, rows: [] });
  const add = (name, ...rows) => T[name].rows.push(...rows);

  table('hubspot_owners', ['id', 'first_name', 'last_name', 'email', 'archived']);
  add('hubspot_owners', ['101', 'Alex', 'Morgan', 'alex@' + DOM, 0], ['102', 'Sam', 'Rivera', 'sam@' + DOM, 0],
    ['103', hiddenFirst, 'Kay', pat + '@' + DOM, 0], ['76564046', 'Casey', 'One', 'cs1@' + DOM, 0], ['82316863', 'Drew', 'Two', 'cs2@' + DOM, 0]);

  table('hubspot_pipelines', ['pipeline_id', 'pipeline_label', 'stage_id', 'stage_label', 'display_order', 'is_closed', 'probability']);
  [['943743501', 'SQL', 0, 0, '0.05'], ['decisionmakerboughtin', 'Discovery/RFP received (Deal)', 1, 0, '0.1'], ['15879262', 'Demo meeting', 2, 0, '0.25'],
    ['34538004', 'Wider stakeholders', 3, 0, '0.4'], ['27052677', 'Decision', 4, 0, '0.7'], ['contractsent', 'Legal & Compliance', 5, 0, '0.9'],
    ['closedwon', 'Closed won', 6, 1, '1.0'], ['207126699', 'On Hold', 7, 0, '0.1'], ['closedlost', 'Closed lost', 8, 1, '0.0'], ['1270127483', 'Disqualified', 9, 1, '0.0']]
    .forEach(([id, l, o, c, p]) => add('hubspot_pipelines', ['default', 'Sales Pipeline', id, l, o, c, p]));
  add('hubspot_pipelines', ['686463412', 'Renewal Pipeline', '1005329279', 'Onboarding', 0, 0, '0.5'], ['686463412', 'Renewal Pipeline', '1005329284', 'Closed Won', 4, 1, '1.0'],
    ['686100770', 'Partnerships Pipeline', '1005341488', 'Nurturing', 2, 0, '0.5'], ['855205465', 'Customer Success Pipeline', '1275460022', 'Identified', 0, 0, '0.2']);

  table('hubspot_objects', ['object_type', 'hs_id', 'properties_json', 'fetched_at']);
  table('hubspot_associations', ['from_type', 'from_id', 'to_type', 'to_id']);
  const obj = (type, id, props) => add('hubspot_objects', [type, id, { hs_object_id: id, ...props }, AS_OF]);
  const link = (a, ai, b, bi) => add('hubspot_associations', [a, ai, b, bi], [b, bi, a, ai]);

  const companies = {
    north: ['9001', 'Northstar Labs', 'northstar.example', 'opportunity'], cedar: ['9002', 'Cedar Harbor', 'cedar.example', 'opportunity'],
    juniper: ['9003', 'Juniper Works', 'juniper.example', 'customer'], bluebird: ['9004', 'Bluebird Systems', 'bluebird.example', 'customer'],
    maple: ['9005', 'Maple Analytics', 'maple.example', 'lead'], orchid: ['9006', 'Orchid Retail', 'orchid.example', 'customer'],
    pine: ['9007', 'Pine Robotics', 'pine.example', 'opportunity'], willow: ['9008', 'Willow Health', 'willow.example', 'lead'],
  };
  const C = {};
  for (const [k, [id, name, domain, life]] of Object.entries(companies)) { C[k] = id; obj('companies', id, { name, domain, lifecyclestage: life, hubspot_owner_id: '101' }); }

  const deal = (id, name, pipeline, stage, amount, prob, company, extra = {}) => {
    obj('deals', id, { dealname: name, pipeline, dealstage: stage, amount: amount == null ? null : String(amount), hs_deal_stage_probability: prob == null ? null : String(prob),
      hubspot_owner_id: '101', createdate: '2026-09-01T15:00:00Z', closedate: '2026-12-15T15:00:00Z', hs_lastmodifieddate: '2026-10-12T15:00:00Z', ...extra });
    link('deals', id, 'companies', company);
  };
  deal('7001', 'Northstar pilot', 'default', '943743501', 100000, 0.05, C.north);
  deal('7002', 'Cedar expansion', 'default', '15879262', 200000, 0.25, C.cedar);
  deal('7003', 'Juniper new team', 'default', 'decisionmakerboughtin', 150000, 0.1, C.juniper, { createdate: '2026-10-13T10:00:00Z' });
  deal('7004', 'Northstar phase two', 'default', '207126699', 80000, 0.1, C.north);
  deal('7005', 'Cedar side project', 'default', '207126699', null, 0.1, C.cedar);
  deal('7006', 'Juniper first win', 'default', 'closedwon', 50000, 1, C.juniper, { hs_is_closed: 'true', hs_is_closed_won: 'true', closedate: '2026-03-01T17:00:00Z' });
  deal('7007', 'Pine first win', 'default', 'closedwon', 40000, 1, C.pine, { hs_is_closed: 'true', hs_is_closed_won: 'true', closedate: '2026-10-05T17:00:00Z' });
  deal('7008', 'Cedar old bid', 'default', 'closedlost', 30000, 0, C.cedar, { hs_is_closed: 'true', hs_is_closed_won: 'false', closed_lost_reason: 'ghosted' });
  deal('7009', 'Northstar old bid', 'default', 'closedlost', 20000, 0, C.north, { hs_is_closed: 'true', hs_is_closed_won: 'false', closed_lost_reason: 'went with another vendor' });
  deal('7010', 'Cedar trial', 'default', '1270127483', 10000, 0, C.cedar, { hs_is_closed: 'true', hs_is_closed_won: 'false', closed_lost_reason: 'irrelevant' });
  deal('7011', 'Northstar enterprise', 'default', 'contractsent', 300000, 0.9, C.north, { hubspot_owner_id: '103' });
  deal('7012', 'Juniper add-on', 'default', 'closedlost', 15000, 0, C.juniper, { hs_is_closed: 'true', hs_is_closed_won: 'false', createdate: '2026-05-01T15:00:00Z', closed_lost_reason: 'na' });
  deal('7101', 'Bluebird renewal', '686463412', '1005329279', 60000, 0.5, C.bluebird);
  deal('7102', 'Maple partnership', '686100770', '1005341488', null, 0.5, C.maple);
  deal('7103', 'Juniper success plan', '855205465', '1275460022', 20000, 0.2, C.juniper);

  const contacts = {
    ana: ['5001', 'Ana', 'Lopez', 'ana@northstar.example', 'north'], ben: ['5002', 'Ben', 'Okafor', 'ben@cedar.example', 'cedar'],
    cara: ['5003', 'Cara', 'Singh', 'cara@juniper.example', 'juniper'], dev: ['5004', 'Dev', 'Patel', 'dev@bluebird.example', 'bluebird'],
    eli: ['5005', 'Eli', 'Novak', 'eli@maple.example', 'maple'], fay: ['5006', 'Fay', 'Moreau', 'fay@pine.example', 'pine'],
    gus: ['5007', 'Gus', 'Ito', 'gus@orchid.example', 'orchid'], hal: ['5008', 'Hal', 'Berg', 'hal@nocompany.example', null],
    ivy: ['5009', 'Ivy', 'Team', 'ivy@' + DOM, null], wes: ['5010', 'Wes', 'Grant', 'wes@willow.example', 'willow'],
  };
  const K = {};
  for (const [k, [id, first, last, email, co]] of Object.entries(contacts)) {
    K[k] = id;
    const props = { email, firstname: first, lastname: last, jobtitle: 'Procurement Lead', lifecyclestage: 'opportunity', hubspot_owner_id: '101', createdate: '2026-06-01T15:00:00Z' };
    if (synced) Object.assign(props, { hs_analytics_source: 'DIRECT_TRAFFIC', hs_object_source: 'FORM' });
    if (synced && k === 'fay') Object.assign(props, { paid_touch_campaign: 'OpenAI ChatGPT Q3', hs_analytics_source: 'PAID_SEARCH' });
    if (synced && k === 'ana') Object.assign(props, { utm_source: 'google', utm_medium: 'cpc', utm_term: 'example brand' });
    obj('contacts', id, props);
    if (co) link('contacts', id, 'companies', C[co]);
  }

  const mtg = (id, start, owner, title, contactKeys = [], extra = {}) => {
    // A scheduling-page booking: extra.booking is the page id (config/lead-rules.json mql.bookingLinkIds is the book-a-demo page).
    const booking = synced && extra.booking ? { hs_meeting_source: 'MEETINGS_PUBLIC', hs_created_by_scheduling_page: extra.booking, hs_createdate: '2026-10-01T15:00:00Z' } : {};
    obj('meetings', id, { hs_meeting_title: title, hs_meeting_start_time: start, hs_timestamp: start, hs_meeting_outcome: 'SCHEDULED', hubspot_owner_id: owner, ...booking });
    for (const k of contactKeys) link('meetings', id, 'contacts', K[k]);
    if (extra.deal) link('meetings', id, 'deals', extra.deal);
  };
  mtg('8001', '2026-10-05T17:00:00Z', '101', `Northstar intro with ${hiddenFirst}`, ['ana']);
  mtg('8002', '2026-10-20T17:00:00Z', '102', 'Cedar demo', ['ben'], { booking: BOOK_A_DEMO_PAGE });
  mtg('8003', '2026-10-21T17:00:00Z', '103', 'Northstar security review', ['ana']);
  mtg('8004', '2026-10-06T17:00:00Z', '76564046', 'Northstar CS check-in', ['ana']);
  mtg('8005', '2026-10-07T17:00:00Z', '101', 'Juniper QBR', ['cara']);
  mtg('8006', '2026-10-08T17:00:00Z', '101', 'Bluebird onboarding call', ['dev']);
  mtg('8007', '2026-10-09T17:00:00Z', '101', 'Orchid check-in', ['gus']);
  mtg('8008', '2026-10-02T17:00:00Z', '101', 'Pine evaluation', ['fay']);
  mtg('8009', '2026-10-08T18:00:00Z', '101', 'Pine kickoff', ['fay']);
  mtg('8010', '2026-10-10T17:00:00Z', '102', 'Maple intro', ['eli'], { booking: '1000001' });
  if (synced) link('deals', '7001', 'contacts', K.ana);
  mtg('8011', '2026-10-11T17:00:00Z', '102', 'Weekly sync');
  mtg('8012', '2026-10-12T17:00:00Z', '102', 'Bluebird Systems onboarding session');
  mtg('8013', '2026-10-03T17:00:00Z', '101', 'Internal planning', ['ivy']);
  mtg('8014', '2026-11-02T17:00:00Z', '101', 'Cedar follow-up', ['ben']);
  mtg('8015', '2026-09-20T17:00:00Z', '102', 'Hal coffee chat', ['hal']);
  mtg('8016', '2026-10-14T17:00:00Z', '101', 'Renewal review', ['hal'], { deal: '7101' });

  table('hubspot_deal_extras', ['deal_id', 'company_ids', 'owner_history', 'refreshed_at']);
  add('hubspot_deal_extras', ['7001', JSON.stringify([C.north]), '[]', AS_OF]);

  table('meetings', ['recording_id', 'title', 'meeting_type', 'url', 'share_url', 'created_at', 'scheduled_start_time', 'scheduled_end_time', 'recording_start_time',
    'recording_end_time', 'transcript_language', 'recorded_by_name', 'recorded_by_email', 'invitees_json', 'summary_markdown', 'action_items_json', 'highlights_json', 'fetched_at']);
  const inv = (email, external = true) => ({ name: email.split('@')[0], email, email_domain: email.split('@')[1], is_external: external });
  const rec = (id, start, byName, byEmail, invitees, summary) => add('meetings', [id, `Recording ${id}`, '', null, null, start, start, null, start, null, 'en', byName, byEmail,
    JSON.stringify([inv(byEmail, false), ...invitees]), summary || null, '[]', '[]', AS_OF]);
  rec(1001, '2026-10-05T17:00:00Z', 'alex morgan', 'alex@' + DOM, [inv('ana@northstar.example')], '## Summary\nSynthetic discovery: approvals are slow. [Link](https://example.com)');
  rec(1002, '2026-10-06T17:00:00Z', 'casey one', 'cs1@' + DOM, [inv('ben@cedar.example')]);
  rec(1003, '2026-10-07T17:00:00Z', 'alex morgan', 'alex@' + DOM, [inv('cara@juniper.example')]);
  rec(1004, '2026-10-02T17:00:00Z', 'alex morgan', 'alex@' + DOM, [inv('fay@pine.example')], 'Pine evaluation summary.');
  rec(1005, '2026-10-08T18:00:00Z', 'alex morgan', 'alex@' + DOM, [inv('fay@pine.example')]);
  rec(1006, '2026-10-09T17:00:00Z', 'sam rivera', 'sam@' + DOM, [inv('ivy@' + DOM, false)]);
  rec(1007, '2026-10-10T17:00:00Z', `${pat} kay`, pat + '@' + DOM, [inv('someone@unknownco.example')]);
  rec(1008, '2026-01-10T17:00:00Z', 'alex morgan', 'alex@' + DOM, [inv('ana@northstar.example')]);
  table('transcripts', ['recording_id', 'turns_json', 'n_turns', 'n_chars']);
  add('transcripts', [1001, '[]', 10, 500]);

  table('sheets_data', ['spreadsheet_id', 'spreadsheet_title', 'tab', 'row_num', 'row_json']);
  const sheet = (title, tab, rows) => rows.forEach((r, i) => add('sheets_data', ['sheet-' + title.length, title, tab, i + 1, r]));
  const TRACKER = 'Synthetic Pipeline Sheet';
  const lt = (company, source, owner, lead, mql, sql, notes, first, hsid, domain) => [company, source, owner, lead, mql, sql, notes, first, hsid || '', domain || ''];
  sheet(TRACKER, 'Lead Tracker', [
    ['LEAD TRACKER (synthetic)'], [],
    ['Company', 'Source', 'Owner', 'Lead Date', 'MQL Date', 'SQL Date', 'Deal / Notes', 'First Touch (auto)', 'HubSpot Company ID', 'Company Domain'],
    lt('Northstar Labs', 'Inbound', 'Alex', '10/01/2026', '10/05/2026', '', 'Demo request form', '', C.north),
    lt('Cedar Harbor', 'Events', 'Sam', '09/15/2026', '', '', 'Met at the booth', '', '', 'cedar.example'),
    lt('northstar labs', 'Inbound', 'Alex', '08/01/2026', '', '', 'Earlier row for the same company', ''),
    lt('Maple Analytics', 'Paid', hiddenFirst, '07/27/2026', '', '', 'Paid ad conversion. Vendor onboarding checklist download.', ''),
    lt('Pine Robotics', 'Paid', 'Sam', '08/04/2026', '08/10/2026', '08/20/2026', 'ChatGPT ad lead', ''),
    lt('Orchid Retail', 'Inbound', 'Sam', '09/01/2026', '', '', 'OpenAI ads lead', ''),
    lt('Quartz Media', 'Paid', 'Alex', '09/20/2026', '', '', `Google paid ad lead. Booked by ${hiddenFirst}.`, ''),
    lt('Spruce Labs', 'Inbound', 'Sam', '07/01/2026', '07/01/2026', '', 'Reddit ad lead', ''),
    lt('Willow Health', 'Outbound', 'Alex', '', '', '', '', '10/2/2026'),
    lt('Birch Co', 'Webinar', 'Sam', '06/01/2026', '06/05/2026', '', '', ''),
    lt('Birch Co', 'Events', 'Sam', '06/03/2026', '', '', '', ''),
    lt('Elm Partners', 'RFP', 'not assigned', '05/01/2026', '', '05/10/2026', '', ''),
    [], ['', '', '', '', '', '', '', '', 'Rule (synthetic legend)'],
  ]);
  sheet('OpenAI - Day-of-Week & Hour-of-Day - Synthetic', 'Day Of Week', [
    ['OpenAI Ads — Day-of-Week Performance'], ['Window: 2025-10-13 to 2026-10-12'], [],
    ['Day of Week', 'Days', 'Spend', 'Impressions', 'Clicks', 'CTR', 'Avg CPC', 'CPM', 'Conversions', 'Cost / Conv'],
    ['Monday', '6', '$600.00', '6,000', '60', '1%', '$10', '$100', '4', '$150'], ['Tuesday', '6', '$400.00', '4,000', '40', '1%', '$10', '$100', '3', '$133'],
    ['TOTAL', '12', '$1,000.00', '10,000', '100', '1%', '$10', '$100', '7', '$142.86'],
  ]);
  sheet('OpenAI - Day-of-Week & Hour-of-Day - Synthetic', 'Settings', [
    ['Settings'], ['Automation Run Log'], ['Setting', 'Value'], ['Conversion Type', 'All Conversions', 'The platform reports one account total'], [],
    ['Conversion Events Configured'], ['Name', 'Event Type', 'Custom Event Name'], ['Vendor Onboarding Checklist', 'registration_completed'], ['Lead Created - 6/23/26 - IT', 'lead_created'],
  ]);
  sheet('OpenAI - Ad Copy - Synthetic', 'By Landing Page', [
    ['Landing Page', '# Ads', 'Spend ($)', 'Impressions', 'Clicks', 'CTR (%)', 'CPC ($)', 'CPM ($)', 'Conversions', 'CPA ($)'],
    ['https://www.example.com/checklist/', '5', '$800', '8,000', '80', '1%', '$10', '$100', '6', '$133'], ['https://www.example.com/', '2', '$200', '2,000', '20', '1%', '$10', '$100', '1', '$200'],
  ]);
  sheet('Google - Day-of-Week & Hour-of-Day - Synthetic', 'Summary - Day Of Week', [
    ['Day Of Week', 'Spend', 'Impressions', 'Clicks', 'Avg Cpc', 'CTR', 'Conversions', 'CPA', 'Conversion Rate', 'All Conversions'],
    ['1. Monday', '$2,000.00', '5000', '200', '$10', '4%', '5', '$400', '2.5%', '$30.00'], ['Grand Total', '$2,000.00', '5000', '200', '$10', '4%', '5', '$400', '2.5%', '$30.00'],
  ]);
  sheet('Google - Day-of-Week & Hour-of-Day - Synthetic', 'Report', [
    ['Date Range', 'Sep 1 - Oct 11, 2026'], ['Date', 'Campaign Name', 'Campaign Status', 'Day Of Week', 'Hour', 'Spend'],
    ['2026-09-01', 'Search A', 'ENABLED', '2. Tuesday', '9', '$10.00'], ['2026-09-01', 'Search A', 'ENABLED', '2. Tuesday', '10', '$5.00'],
    ['2026-09-02', 'Search A', 'ENABLED', '3. Wednesday', '9', '$0.00'], ['2026-10-11', 'Search A', 'ENABLED', '7. Sunday', '9', '$20.00'],
  ]);
  sheet('Reddit - Account Performance - Synthetic', 'Summary - Day Of Week', [
    ['Day Of Week', 'Spend', 'Impressions', 'Reach', 'CPM', 'Clicks', 'CPC', 'CTR', 'Conversions'], ['Grand Total', '$500.00', '20,000', '18,000', '$25', '50', '$10', '0.25%', '1'],
  ]);
  sheet('Reddit - Account Performance - Synthetic', 'Report', [
    ['Date', 'Campaign Name', 'Campaign Status', 'Day Of Week', 'Hour', 'Spend'], ['2026-09-20', 'RTG', 'PAUSED', '7. Sunday', '8', '$300.00'], ['2026-09-28', 'RTG', 'PAUSED', '1. Monday', '8', '$200.00'],
  ]);
  sheet('Reddit - Account Performance - Synthetic', 'Conversions Breakdown', [['Conversion Name', 'Conversions'], ['Page Visit', '50'], ['VendorOnboardingChecklist', '1'], ['Lead', '1'], ['Sign Up', '0']]);
  sheet('Synthetic Marketing Budget', 'Actuals', [
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'TOTAL'],
    ['', 'Planned', '', ...Array(12).fill(' 1,000 '), '12,000'], ['', 'Actual', '', ...Array(7).fill(' 900 '), ...Array(5).fill(' - '), '6,300'], [],
    ['Account', 'Vendor', 'Channel', ...Array.from({ length: 12 }, (_, i) => `${i + 1}/28/2026`)],
  ]);

  table('lemlist_campaigns', ['campaign_id', 'name', 'status', 'raw_json', 'fetched_at']);
  const camp = (id, name, status, delivered, replied, inviteReplied) => add('lemlist_campaigns', [id, name, status, {
    _id: id, name, status, stats: { messagesSent: delivered, delivered, replied, opened: 0, meetingBooked: 0,
      steps: [{ taskType: 'linkedinInvite', replied: inviteReplied }, { taskType: 'linkedinSend', replied: replied - inviteReplied }] } }, AS_OF]);
  camp('cam_out1', 'Synthetic Outbound A', 'running', 100, 10, 2);
  camp('cam_event', 'Synthetic Event Outreach', 'paused', 50, 20, 15);
  camp('cam_cust', 'Customer company -> New Company', 'running', 10, 1, 0);
  camp('cam_bad', 'Customer company -> New Company (Bad ICP)', 'running', 31, 7, 0);
  camp('cam_draft', 'Hiring draft', 'draft', 0, 0, 0);

  table('sync_outcomes', ['source', 'at', 'ok', 'route', 'http', 'detail', 'last_ok_at']);
  add('sync_outcomes', ['hubspot', '2026-10-13T15:50:00Z', 1, null, null, 'synthetic', '2026-10-13T15:50:00Z'], ['sheets', '2026-10-13T15:45:00Z', 1, null, null, 'synthetic', '2026-10-13T15:45:00Z'],
    ['fathom', '2026-10-13T15:40:00Z', 1, null, null, 'synthetic', '2026-10-13T15:40:00Z'], ['lemlist', '2026-10-13T15:41:00Z', 1, null, null, 'synthetic', '2026-10-13T15:41:00Z'],
    ['ga4', '2026-10-13T15:30:00Z', 1, null, null, 'synthetic', '2026-10-13T15:30:00Z'], ['otterly', '2026-10-13T13:19:05Z', 0, null, null, 'skipped: quota', '2026-10-03T13:18:31Z'],
    // Internal sync steps: no chip of their own, they roll up into HubSpot / Lemlist (config/freshness-sources.json).
    ['hubspot_contact_backfill', '2026-10-13T14:10:00Z', 1, null, null, 'synthetic', '2026-10-13T14:10:00Z'], ['hubspot_forms', '2026-10-13T15:49:00Z', 1, null, null, 'synthetic', '2026-10-13T15:49:00Z'],
    ['lemlist_leads', '2026-10-13T15:41:00Z', 1, null, null, 'synthetic', '2026-10-13T15:41:00Z']);
  table('ga4_reports', ['report_key', 'property_id', 'params_json', 'result_json', 'fetched_at']);
  add('ga4_reports', ['channels_90d', 'p1', '{}', { metricHeaders: [{ name: 'sessions' }], rows: [{ dimensionValues: [{ value: 'Unassigned' }], metricValues: [{ value: '400' }] }, { dimensionValues: [{ value: 'Direct' }], metricValues: [{ value: '600' }] }] }, '2026-10-13T15:30:00Z']);

  if (synced) {
    table('hubspot_forms', ['form_id', 'name', 'form_type', 'created_at', 'updated_at', 'archived', 'raw_json', 'fetched_at']);
    add('hubspot_forms', ['f-demo', 'Demo Request', 'hubspot', AS_OF, AS_OF, 0, '{}', AS_OF], ['f-pricing', 'Pricing form', 'hubspot', AS_OF, AS_OF, 0, '{}', AS_OF]);
    table('hubspot_form_submissions', ['form_id', 'conversion_id', 'submitted_at', 'contact_email', 'page_url', 'page_title', 'values_json', 'fetched_at']);
    add('hubspot_form_submissions', ['f-demo', 'c1', '2026-09-30T15:00:00Z', 'ana@northstar.example', 'https://www.example.com/demo', 'Demo', [{ name: 'email', value: 'ana@northstar.example' }], AS_OF],
      ['f-pricing', 'c2', '2026-08-30T15:00:00Z', 'gus@orchid.example', 'https://www.example.com/pricing', 'Pricing', { email: 'gus@orchid.example' }, AS_OF]);
    table('hubspot_lists', ['list_id', 'name', 'processing_type', 'object_type', 'size', 'created_at', 'updated_at', 'raw_json', 'fetched_at']);
    add('hubspot_lists', ['884', 'Synthetic East 2026 - event attendees', 'SNAPSHOT', '0-1', 1, AS_OF, AS_OF, '{}', AS_OF], ['692', 'Synthetic pre-show list', 'SNAPSHOT', '0-1', 1, AS_OF, AS_OF, '{}', AS_OF]);
    table('hubspot_list_memberships', ['list_id', 'record_id', 'added_at']);
    add('hubspot_list_memberships', ['692', K.ben, '2026-09-01T15:00:00Z'], ['884', K.ben, '2026-09-14T15:00:00Z']);
    table('hubspot_imports', ['import_id', 'name', 'state', 'created_at', 'raw_json', 'fetched_at']);
    add('hubspot_imports', ['i1', 'Synthetic East 2026 - event attendees', 'DONE', AS_OF, '{}', AS_OF]);
    table('lemlist_leads', ['campaign_id', 'lead_id', 'email', 'company_domain', 'state', 'status', 'email_status', 'contacted_at', 'replied_at', 'opened_at', 'clicked_at', 'meeting_booked_at', 'raw_json', 'fetched_at']);
    const ll = (cid, id, email, replied, raw) => add('lemlist_leads', [cid, id, email, email.split('@')[1], 'replied', null, null, '2026-09-01T15:00:00Z', replied, null, null, null, raw || {}, AS_OF]);
    ll('cam_out1', 'l1', 'p1@prospect-a.example', '2026-09-02T15:00:00Z');
    ll('cam_out1', 'l2', 'p2@prospect-b.example', '2026-09-03T15:00:00Z');
    ll('cam_out1', 'l3', 'p3@prospect-c.example', '2026-09-04T15:00:00Z', { replyText: 'Out of office until Monday' });
    ll('cam_cust', 'l4', 'wes@willow.example', '2026-10-01T15:00:00Z');
  }

  const leadSources = {
    generated_at: '2026-10-13T09:00:00-07:00', owner: 'synthetic', needs_reviewer: ['1. Which forms count?'],
    ads: { platforms: ['Google Ads', 'LinkedIn Ads', 'Reddit Ads', 'OpenAI (ChatGPT) Ads'],
      checks_2026_10_13: { quartz: 'Paid Google, confirmed: synthetic contact with gclid and utm_medium=cpc.', reddit: '0 traceable HubSpot leads, confirmed (synthetic).',
        spruce: 'Not Reddit. Synthetic contact arrived from branded search with a click id. Verdict: paid Google branded search; Sheet note left as entered.' },
      paid_leads: [{ company: 'Elm Partners', platform: 'LinkedIn', conversion_date: '2026-01-17', predates_spend_window: true, counts_in_roi: true, note: 'Synthetic: counts in ROI; predates the spend window.' }] },
    forms: [{ id: 'f-demo', name: 'Demo Request', bucket: 'demo_request', detail: 'demo', counts_as_lead_source: true, uncertain: false },
      { id: 'f-pricing', name: 'Pricing form', bucket: 'contact', detail: 'pricing', counts_as_lead_source: true, uncertain: true },
      { id: 'f-jobs', name: 'Job application', bucket: 'not_a_lead_source', detail: 'jobs', counts_as_lead_source: false, uncertain: false }],
    list_uploads: [
      { id: 159, name: 'Purchased list.csv', kind: 'purchased/prospect list', counts_as_lead_source: false },
      { id: 692, name: 'Synthetic pre-show list', kind: 'event', show: 'Pre-show', counts_as_lead_source: true },
      { id: 694, name: 'Synthetic West 2026', kind: 'event', show: 'Synthetic West 2026', counts_as_lead_source: true },
      { id: 867, name: 'Synthetic sponsor outbound', kind: 'event', show: 'Sponsor outbound', counts_as_lead_source: true },
      { id: 884, name: 'Synthetic East 2026 - event attendees', kind: 'event', show: 'Synthetic East 2026', counts_as_lead_source: true }],
    lemlist: { campaigns: [
      { id: 'cam_out1', name: 'Synthetic Outbound A', bucket: 'sales_outbound' },
      { id: 'cam_event', name: 'Synthetic Event Outreach', bucket: 'sales_outbound (event/webinar pre/post-show)' },
      { id: 'cam_cust', name: 'Customer company -> New Company', bucket: 'sales_outbound (separate sub-source recommended)' },
      { id: 'cam_bad', name: 'Customer company -> New Company (Bad ICP)', bucket: 'sales_outbound (separate sub-source recommended)' },
      { id: 'cam_draft', name: 'Hiring draft', bucket: 'exclude' }] },
    sheet: { tab: `Lead Tracker (${TRACKER})` },
    customer_success: { owners: { 'CS owner one': ['76564046'], 'CS owner two': ['82316863'] } },
  };
  const lostReasons = { generated_at: '2026-10-13T08:00:00-07:00', deals: [{ deal_id: '7008', category: 'went_dark', inferred: false, basis: 'No reply after the demo' }] };
  const insights = { generated_at: '2026-10-13T08:00:00-07:00', headline: 'Synthetic analysis headline.', insights: [
    { title: 'Synthetic insight', evidence: 'Synthetic evidence.', why_it_matters: 'Synthetic reason.', recommended_play: 'Synthetic play.', owner: `${hiddenFirst} / Alex Morgan`, confidence: 'medium' }],
    data_quality_flags: [], changed_since_last: 'Synthetic.' };
  const leadInsights = { generated_at: '2026-10-13T09:00:00-07:00', leads: { [K.ana]: { contact_id: K.ana, company: 'Northstar Labs', last_call_date: '2026-10-05', call_count: 1,
    themes: { pains: ['Manual approvals', '//fathom.video/share/x)'], objections: ['price_budget'], competitors: ['Zip'] }, next_step: 'Send the pilot plan', risk: ['1 call day(s)'], basis: '1 prospect call' } } };
  const stagesExport = {};
  for (const r of T.hubspot_pipelines.rows.filter((r) => r[0] === 'default')) stagesExport[r[2]] = { pipe: 'Sales Pipeline', label: r[3], closed: !!r[5], prob: r[6] };
  const prior = { fetchedAt: '2026-10-13T08:00:00+00:00', pipes: { default: 'Sales Pipeline' }, stages: stagesExport, deals: [
    { id: '7001', properties: { dealname: 'Northstar pilot', pipeline: 'default', dealstage: '943743501', amount: '100000', hs_deal_stage_probability: '0.05' } },
    { id: '7002', properties: { dealname: 'Cedar expansion', pipeline: 'default', dealstage: '943743501', amount: '200000', hs_deal_stage_probability: '0.05' } },
    { id: '7011', properties: { dealname: 'Northstar enterprise', pipeline: 'default', dealstage: 'contractsent', amount: '300000', hs_deal_stage_probability: '0.9' } },
    { id: '7004', properties: { dealname: 'Northstar phase two', pipeline: 'default', dealstage: '207126699', amount: '80000', hs_deal_stage_probability: '0.1' } }] };
  const currentPage = { builtAt: '2026-10-13T08:00:00Z', deals: [{ id: 'deal-w1', won: true }, { id: 'deal-r1', pipelineId: '686463412' }, { id: 'deal-o1', pipelineId: 'default' }],
    companies: [
      { lifecycle: 'customer', dealIds: [], meetings: [{}, {}, {}], recordings: [{}, {}] },
      { lifecycle: 'lead', dealIds: ['deal-w1'], meetings: [{}], recordings: [{}] },
      { lifecycle: 'opportunity', dealIds: ['deal-r1'], meetings: [{}, {}], recordings: [] },
      { lifecycle: 'opportunity', dealIds: ['deal-o1'], meetings: [{}], recordings: [{}, {}] }] };

  const crec = (id, audience, extra = {}) => ({ call_id: id, audience, audience_reason: audience === 'prospect' ? 'default_prospect' : audience + '_rule', ...extra });
  const callClassification = [
    crec(1001, 'prospect', { hubspot_company_id: C.north, deal: { id: '7001', name: 'Northstar pilot', stage: 'SQL' }, call_type: 'discovery', buyer_roles: ['procurement'],
      objections: [{ category: 'price_budget', quote: 'Synthetic budget worry.' }], competitors: { Zip: 2 }, next_steps: ['Send the pilot plan.'] }),
    crec(1002, 'customer'), crec(1003, 'customer'), crec(1004, 'prospect', { deal: null }), crec(1005, 'customer'), crec(1006, 'internal'),
    crec(1007, 'prospect', { deal: null }), crec(1008, 'partner_other')].map((r) => JSON.stringify(r)).join('\n') + '\n';
  const reviewList = 'row,company,sheet_source,hubspot_sources,evidence,sheet_note,action,status,mql_channel,different_first_touch,attribution_evidence\n' +
    '9,Orchid Retail,Inbound,Paid,gus@orchid.example: OpenAI via utm,OpenAI ads lead,Analysis only,undetermined,undetermined,,no MQL booking yet\n' +
    '5,Cedar Harbor,Events,Outbound,ben@cedar.example: Lemlist reply,Met at the booth,Analysis only,resolved,Outbound,Events (Synthetic show),meeting booked after a Lemlist reply\n' +
    '13,Birch Co,Webinar,Events,synthetic contact: Event Attendee,,Held for review,on_hold_pending_reviewer,,,\n';
  const paidExport = { generated_at: '2026-10-13T16:30:00+00:00', stages: {}, deals: [
    { id: '7002', properties: { dealname: 'Cedar expansion', pipeline: 'default' }, derived: { pipelineId: 'default', stageLabel: 'Demo meeting', paid_platform: 'Google', paid_evidence: { via: 'utm', level: 'deal' }, google_branded: true, conversion_date: '2026-08-18', predates_spend_window: false } },
    { id: '7011', properties: { dealname: 'Northstar enterprise', pipeline: 'default' }, derived: { pipelineId: 'default', stageLabel: 'Legal & Compliance', paid_platform: 'LinkedIn', paid_evidence: { via: 'form (company contact)', level: 'company' }, google_branded: false, conversion_date: '2026-02-20', predates_spend_window: true } },
    { id: '7101', properties: { dealname: 'Bluebird renewal', pipeline: '686463412' }, derived: { pipelineId: '686463412', paid_platform: 'Google', paid_evidence: { via: 'utm', level: 'deal' }, google_branded: false } },
    { id: '7001', properties: { dealname: 'Northstar pilot', pipeline: 'default' }, derived: { pipelineId: 'default', paid_platform: null } }] };

  const expect = {
    asOf: AS_OF, hidden: pat,
    headline: { count: 4, amount: 750000, weighted: 340000, onHoldCount: 2, onHoldAmount: 80000 },
    change: { fromCount: 3, fromAmount: 600000, toCount: 4, toAmount: 750000, newIds: ['7003'], stageIds: ['7002'] },
    closed: { lost: 3, lostAmount: 65000, dq: 1, dqAmount: 10000, won: 2, reasons: 3, postWin: ['7012'] },
    leads: { total: 10, mql: 5, sql: 2, openaiConfirmed: 2, openaiAtMost: 3 },
    meetings: { thisMonth: { matched: 4, unmatched: 1, noContact: 1 }, upcoming: { matched: 3, unmatched: 0, noContact: 0 },
      scope: { total: 16, cs: 1, customer: 6, internal: 1, inScope: 8 } },
    callsFallback: { total: 8, internal: 1, cs: 1, customer: 2, prospect: 4, listed: 3 },
    outbound: { sends: 191, replies: 38, count: 5 },
    calls: { strategy: { total: 8, prospect: 3, customer: 3, internal: 1, partner_other: 1, listed: 3 } },
    paid: { total: 3, sales: 2 },
    currentPage: { companies: 3, meetings: 6, recordings: 3, recordingsTotal: 5 },
  };
  return { tables: T, inputs: { leadSources, lostReasons, insights, leadInsights, prior, currentPage, paidExport }, text: { 'records.jsonl': callClassification, 'review.csv': reviewList }, expect };
}

module.exports = { writeDemo, brainFixture, SYNTHETIC_SCRUB };
if (require.main === module) {
  const i = process.argv.indexOf('--brain');
  if (i === -1) writeDemo();
  else {
    const dir = process.argv[i + 1];
    const fx = brainFixture({ synced: process.argv.includes('--synced') });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + '/fixture.json', JSON.stringify(fx));
    for (const [k, v] of Object.entries(fx.inputs)) fs.writeFileSync(`${dir}/${k}.json`, JSON.stringify(v, null, 1));
    for (const [k, v] of Object.entries(fx.text)) fs.writeFileSync(`${dir}/${k}`, v);
    console.log('synthetic brain fixture written to ' + dir);
  }
}

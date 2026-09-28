// Values come from the retained source collection. The original beta owns the UI.
const verifiedFormat = {
  number:n=>n==null?'—':Math.round(n).toLocaleString('en-US'),
  date:d=>workspaceModel.formatDate(d),
  percent:n=>n==null?'—':(n*100).toLocaleString('en-US',{maximumFractionDigits:1})+'%',
  add:(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10)
};
// Field values as people read them: Phoenix times and words instead of CRM enums.
const readableValue=value=>{if(value==null||value==='')return '—';if(typeof value==='object')return JSON.stringify(value);const t=String(value);if(/^[A-Z][A-Z0-9_]+$/.test(t)&&t.includes('_'))return t.charAt(0)+t.slice(1).toLowerCase().replace(/_/g,' ');return workspaceModel.phoenixProse(t);};
const verifiedEvidenceText=e=>[workspaceModel.phoenixProse(e.content||''),e.fields&&Object.keys(e.fields).length?Object.entries(e.fields).map(([key,value])=>key+': '+readableValue(value)).join('\n'):null].filter(Boolean).join('\n\n');
Component.prototype._loadVerified = async function () {
  // A brief server or network hiccup is retried three times before the page says so.
  const read=async name=>{let last;for(let attempt=0;attempt<4;attempt++){try{const r=await fetch('data/'+name+'.json',{cache:'no-store'});if(r.ok)return r.json();last=new Error(r.status===404?'Collection unavailable':'The workspace did not answer (HTTP '+r.status+'). It will keep trying.');if(r.status===404)break;}catch{last=new Error('The workspace did not answer. Check your connection; it will keep trying.');}await new Promise(res=>setTimeout(res,600*(attempt+1)));}throw last;};
  try {
    const [verified,records,evidence,draftSeeds,sheetLabels]=await Promise.all(['verified','records','evidence','draft-seeds','evidence-sheet-labels'].map(read));
    if(verified.snapshotId!==records.verifiedSnapshotId)throw new Error('Collection versions differ');
    if(records.owners)workspaceModel.ownerCatalog=records.owners;
    workspaceModel.people=(verified.meta&&verified.meta.owners)||[];
    let hollie=null;try{hollie=await read('hollie');}catch{}
    let agentBrief=null;try{agentBrief=await read('agent-brief');}catch{}
    let heartbeat=null;try{heartbeat=await read('heartbeat');}catch{}
    let heartbeatFixes=null;try{heartbeatFixes=await read('heartbeat-fixes');}catch{}
    let proposals=[];try{const pr=await fetch('data/crm-proposals.json',{cache:'no-store'});if(pr.ok){const pj=await pr.json();proposals=Array.isArray(pj)?pj:[];}}catch{}
    let sheetReview=null;try{sheetReview=await read('sheet-review');}catch{}
    this.setState({verified,records,verifiedEvidence:evidence,draftSeeds,sheetLabels,hollie,agentBrief,heartbeat,heartbeatFixes,proposals,sheetReview,verifiedError:null,checking:false,checkedAt:workspaceModel.formatTime(new Date().toISOString())});
    const banner=typeof document!=='undefined'&&document.getElementById('topBanner');
    if(banner){const cDate=records.generatedAt?workspaceModel.formatDateTime(records.generatedAt):'';banner.textContent='Company data · HubSpot, Fathom, Sheets, GA4, LemList, Otterly'+(cDate?' · collected '+cDate:'')+' · Drafts stay in your browser · Nothing is sent without approval';}
  } catch {this.setState({checking:false,verifiedError:'The collected data could not be loaded. Reload the page to try again.'});}
};
Component.prototype._verifiedRange = function () {
  const s=this.state,asOf=workspaceModel.asOf(s.records&&s.records.generatedAt);
  const b=workspaceModel.periodBounds(s.period,s.start,s.end,asOf);
  return [b.start,b.end];
};
Component.prototype._verifiedAccount = function (idOrName) {
  const data=this.state.records,verified=this.state.verified;if(!data||!idOrName)return null;
  const id=String(idOrName).replace(/^company:/,'');
  const exact=data.companies.find(c=>c.id===id||c.name===idOrName||(c.mergedIds||[]).includes(id));if(exact)return exact;
  const alias=verified?.opportunities.find(o=>o.name===idOrName);
  const linked=alias?.companyId?.replace(/^company:/,'');
  return data.companies.find(c=>c.id===linked||(c.related||[]).some(r=>r.id===id||r.id===linked))||null;
};
Component.prototype._verifiedOpportunityRows = function () {
  const today=workspaceModel.asOf(this.state.records&&this.state.records.generatedAt);
  const opportunities=workspaceModel.dealsWithSheet(workspaceModel.annotateOpportunities(this.state.verified?.opportunities,this.state.records),this.state.sheetReview);
  return opportunities.filter(o=>workspaceModel.isOpenPipeline(o,today)).map(o=>{
    const company=workspaceModel.companyForOpportunity(o,this.state.records);
    const name=workspaceModel.pipelineCompanyName(company&&company.name,o.dealName,o.name);
    const passed=workspaceModel.closeDatePassed(o,today)?'close date passed':'';
    const note=[passed,String(o.note||'').trim()].filter(Boolean).join(' · ');
    return [name,o.owner||'—',workspaceModel.stageDisplay(o.stage),o.amount,o.probability==null?null:Math.round(workspaceModel.probabilityFraction(o.probability)*100),workspaceModel.dateOnly(o.close),o.days,note];
  }).filter(Boolean);
};
Component.prototype._verifiedLeadRows = function () {
  const sheet=(this.state.sheetReview&&this.state.sheetReview.leads)||[];
  const rows=sheet.length?sheet.map(r=>[r.company||r.name,r.source||'—',r.owner||'—',verifiedFormat.date(r.lead||r.leadDate),r.note||'',verifiedFormat.date(r.mql),verifiedFormat.date(r.sql)])
    :(this.state.verified?.leads||[]).filter(r=>{
      const note=String(r.note||'').toLowerCase();
      const name=String(r.name||'');
      if(note==='subscriber'||note.includes('newsletter'))return false;
      if(name.includes('@'))return false;
      return true;
    }).map(r=>[r.name,r.source,r.owner||'—',verifiedFormat.date(r.lead),r.note,verifiedFormat.date(r.mql),verifiedFormat.date(r.sql)]);
  return rows;
};
Component.prototype.loadTranscript = async function (id) {
  if(!id||this.state.transcripts?.[id]!==undefined)return;
  try{const response=await fetch('data/transcripts/'+encodeURIComponent(id)+'.json');if(!response.ok)throw new Error();const raw=await response.json();const lines=(Array.isArray(raw)?raw:[]).map(l=>({t:String(l.timestamp??l.t??''),s:String(l.speaker??l.s??''),x:String(l.text??l.x??'')})).filter(l=>l.x);this.setState({transcripts:{...this.state.transcripts,[id]:lines},transcriptError:null});}
  catch{this.setState({transcriptError:'The transcript could not be loaded. Close it and try again.'});}
};
Component.prototype._verifiedOpenRefs = function (refs,title) {
  this.setState({evidence:'verified-refs',verifiedRefs:refs,verifiedTitle:title});
};
Component.prototype._verifiedTarget = function (target) {
  return ()=>{
    const d=this.state.verified;
    if(target.kind==='view'){
      this.go(target.view,{...(target.tab?{[target.view==='pipeline'?'perf':target.view]:target.tab}:{}),search:target.search||'',owner:'Everyone',contributor:null,leadStage:null,leadSource:null,leadFlag:null,closeOn:null})();
      if(target.anchor)setTimeout(()=>document.getElementById(target.anchor)?.scrollIntoView({block:'start'}),0);
      return;
    }
    if(target.kind==='leads')return this.go('accounts',{accounts:'leads',search:target.search||'',owner:target.owner||'Everyone',leadStage:target.stage||null,leadSource:target.source||null,leadFlag:target.flag||null,contributor:null})();
    if(target.kind==='url')return window.open(target.href,'_blank','noopener');
    if(target.kind==='account'){const c=this._verifiedAccount(target.id);if(c)return this.go('account',{accountId:c.id})();const o=d.opportunities.find(o=>o.companyId===target.id);return this._verifiedOpenRefs(o?.refs||[],'Account supporting records');}
    if(target.kind==='meeting'){const r=[...this.state.records.companies.flatMap(c=>c.recordings),...this.state.records.unmatchedRecordings].find(r=>r.nativeId===target.id||r.id===target.id);return this.go('meeting',{meetingId:r?.id||target.id})();}
    if(target.kind==='evidence')return this._verifiedOpenRefs([target.ref],'Supporting record');
    if(target.kind==='draft'){const account=target.id.replace(/^follow-up:/,''),index=d.drafts.findIndex(({draft})=>draft.id===target.id||draft.accountIds.includes(account));if(index>=0)return this.go('drafts',{draft:index,draftId:null,draftPurpose:null})();return this._verifiedOpenRefs([],'Draft unavailable');}
  };
};
const verifiedRender=Component.prototype.renderVals;
Component.prototype.renderVals = function () {
  const v=verifiedRender.call(this),s=this.state,d=s.verified,f=verifiedFormat;
  try{
    const gen=s.records&&s.records.generatedAt?s.records.generatedAt:(d&&d.meta&&d.meta.generatedAt)||'';
    const cdt=gen?new Date(gen):null;
    v.collectedShort=gen?workspaceModel.formatDateTime(gen):'';
    v.collectedLong=v.collectedShort;
    const runId=String((s.records&&s.records.runId)||''),rm=runId.match(/^run-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})$/);
    v.runIdLabel=runId?'Run '+runId:'';
    const runAt=rm?workspaceModel.formatDateTime(rm[1]+'T'+rm[2]+':'+rm[3]+':'+rm[4]+'Z'):'';
    // The run time only adds something when it differs from the collection time.
    v.runTimeLabel=runAt&&runAt!==v.collectedShort?runAt.replace(/^[A-Z][a-z]{2} \d+, \d{4} · /,'').replace(/ Phoenix$/,''):'';
    const todayPhx=workspaceModel.asOf(s.records&&s.records.generatedAt);
    const weekStart=workspaceModel.addDays(todayPhx,-((new Date(todayPhx+'T12:00:00Z').getUTCDay()+6)%7));
    const ageH=workspaceModel.snapshotAge(gen);
    v.snapshotAgeHours=ageH==null?null:Math.round(ageH*10)/10;
    v.dataAgeDays=ageH==null?null:Math.floor(ageH/24);
    v.dataStale=ageH!=null&&ageH>24;
    v.dataAgeLabel=ageH==null?'':(v.dataAgeDays>=1?('Data is '+v.dataAgeDays+' day'+(v.dataAgeDays===1?'':'s')+' old'):('Collected '+Math.max(0,Math.round(ageH))+' hours ago'));
    v.weekOf='Week of '+workspaceModel.formatDate(weekStart);
    v.priorityIntro='The deals and follow-ups most at risk, from the collected record.';
    v.priorityNotice='Drafts stay in this browser until you approve them \u2014 nothing is sent automatically.';
  }catch{}
  if(!d){v.isLoading=!s.verifiedError;v.notLoading=false;if(s.verifiedError){v.bannerShown=true;v.banner={bg:'var(--color-surface)',fg:'var(--color-text)',btnBg:'transparent',title:'Collection unavailable',text:s.verifiedError,action:'Try again',go:()=>this._loadVerified()};}return v;}
  const invalidAccount=s.screen==='account'&&s.accountId&&!this._verifiedAccount(s.accountId);
  const invalidMeeting=s.screen==='meeting'&&s.meetingId&&![...s.records.companies.flatMap(c=>c.recordings),...s.records.unmatchedRecordings].some(r=>r.id===s.meetingId);
  if(invalidAccount||invalidMeeting){v.notLoading=false;v.isLoading=false;v.bannerShown=true;v.banner={bg:'var(--color-surface)',fg:'var(--color-text)',btnBg:'transparent',title:'Record unavailable',text:'This record is not in the collected data.',action:'Back to '+(invalidAccount?'accounts':'meetings'),go:this.go(invalidAccount?'accounts':'meetings')};return v;}
  v.priorities=d.presentation.priorities.map((p,i)=>({n:String(i+1),title:p.title,why:p.why,next:p.next,caveat:p.caveat,primary:p.primary.label,primaryGo:this._verifiedTarget(p.primary.target),secondary:p.secondary?.label||'',secondaryGo:p.secondary?this._verifiedTarget(p.secondary.target):()=>{}}));
  v.upcoming=d.presentation.upcoming.map(item=>({when:workspaceModel.formatDate(item.date),title:item.title,prep:item.prep,go:this._verifiedTarget(item.target)}));
  const [start,end]=this._verifiedRange(),inRange=date=>workspaceModel.inRange(date,start,end);
  const trackerRows=workspaceModel.trackerRows(s.sheetReview,d.leads);
  const funnelCounts=workspaceModel.leadCounts(trackerRows,start,end);
  const trackerLabel=(s.sheetReview&&(s.sheetReview.leads||[]).length)?'Lead Tracker':'HubSpot contacts';
  const period=f.date(start)+' – '+f.date(end);
  const goLeads=contributor=>this.go('accounts',{accounts:'leads',contributor,search:'',owner:'Everyone',leadStage:null,leadSource:null});
  const headline=[
    ['New leads',funnelCounts.leads,trackerLabel+' · first stage date'],
    ['Marketing qualified',funnelCounts.mql,trackerLabel+' · MQL date'],
    ['Sales qualified',funnelCounts.sql,trackerLabel+' · SQL date']
  ];
  v.demandMetrics.slice(0,3).forEach((m,i)=>{m.value=f.number(headline[i][1]);m.delta=period;m.note=headline[i][2];m.label=headline[i][0];m.go=goLeads(['lead','mql','sql'][i]);});
  const activity=workspaceModel.activityFromRecords(s.records);
  const completedMeetings=activity.meetings.filter(m=>inRange(m.start)&&/complete|held|completed/i.test(m.outcome||'')).length;
  const recordedMeetings=activity.recordings.filter(r=>inRange(r.date)).length;
  v.demandMetrics[3].value=f.number(completedMeetings);v.demandMetrics[4].value=f.number(recordedMeetings);
  v.demandMetrics[3].delta=period;v.demandMetrics[3].note='CRM meetings marked completed. Not the same as sales qualified, which also counts a recording.';v.demandMetrics[3].label='Meetings completed';v.demandMetrics[3].go=this.go('meetings',{meetings:'past',meetingKind:'completed',meetingSearch:'',meetingOwner:'Everyone'});
  v.demandMetrics[4].delta=period;v.demandMetrics[4].note='Fathom recordings, counted on their own';v.demandMetrics[4].go=this.go('meetings',{meetings:'past',meetingKind:'recordings',meetingSearch:'',meetingOwner:'Everyone'});
  const meetingKindName={completed:'completed CRM meetings',recordings:'recordings'}[s.meetingKind];
  v.hasMeetingKind=!!meetingKindName&&s.meetings==='past';
  v.meetingKindLine=v.hasMeetingKind?f.number(s.meetingKind==='completed'?completedMeetings:recordedMeetings)+' '+meetingKindName+' · '+period:'';
  v.clearMeetingKind=()=>this.setState({meetingKind:null});
  v.meetingScopeLine=s.meetings==='upcoming'?(s.meetingScope==='all'?'Showing every upcoming meeting, including customer success.':'Showing meetings with accounts that have an open new-business deal. Holds and placeholders are hidden.'):'';
  v.meetingScopeLabel=s.meetingScope==='all'?'Show sales and marketing only':'Show all meetings';
  v.toggleMeetingScope=()=>this.setState({meetingScope:s.meetingScope==='all'?null:'all'});
  v.hasMeetingScope=s.meetings==='upcoming';
  v.meetingTabs.forEach(t=>{const go=t.go;t.go=()=>{this.setState({meetingKind:null});go();};});
  const prepCount=((s.hollie||{}).prep||[]).length;
  v.hasPrepBriefs=prepCount>0;v.prepBriefsLabel='See '+prepCount+' meeting prep brief'+(prepCount===1?'':'s')+' (Today › Sales & CS) →';
  v.goPrepBriefs=()=>{this.setState({screen:'briefing',briefAudience:'sales',evidence:false});setTimeout(()=>document.getElementById('meeting-prep')?.scrollIntoView({block:'start'}),0);};
  v.periodRange=period;
  const monthly=s.period==='year'||(Date.parse(end)-Date.parse(start))/86400000>120;
  let at=monthly?start.slice(0,7)+'-01':s.period==='custom'?start:f.add(start,-((new Date(start+'T12:00:00Z').getUTCDay()+6)%7));
  const bars=[];
  while(at<=end){const next=monthly?new Date(Date.UTC(+at.slice(0,4),+at.slice(5,7),1,12)).toISOString().slice(0,10):f.add(at,7);const last=f.add(next,-1);const leads=trackerRows.filter(r=>{const ft=workspaceModel.firstTouch(r);return inRange(ft)&&ft>=at&&ft<=last;}).length;bars.push({date:at,label:monthly?new Date(at+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',timeZone:'UTC'}):f.date(at),leads});at=next;}
  const max=Math.max(1,...bars.map(b=>b.leads));v.weeks=bars.map(b=>({...b,title:(monthly?'':'Week of ')+b.label+': '+b.leads+' new leads',leadH:Math.round(b.leads/max*100)+'%'}));v.barCols=bars.length;v.barsTitle=monthly?'New leads by month':'New leads by week';
  const firstLead=trackerRows.map(r=>workspaceModel.firstTouch(r)).filter(Boolean).sort()[0];
  v.barsNote=firstLead&&firstLead>start?'The Lead Tracker starts on '+f.date(firstLead)+'; earlier '+(monthly?'months':'weeks')+' show 0 because there is no tracker data for them.':'';
  v.channels=funnelCounts.sources.map(r=>({channel:r.channel,leads:r.leads,mql:r.mql,sql:r.sql,rate:r.leads?Math.round(r.sql/r.leads*100)+'%':'—'}));
  v.showChannelLinkNote=false;v.channelLinkNote='';
  v.channelFoot=trackerLabel+', each stage counted on its own date, so a source can have more MQLs or SQLs than leads in a short period. The rows add up to the cards above.';
  const asOf=workspaceModel.asOf(s.records&&s.records.generatedAt);
  const marketing=workspaceModel.marketingView(trackerRows,asOf);
  const spendMonths=(s.marketing&&s.marketing.spend&&s.marketing.spend.months)||[];
  v.marketingIntervals=marketing.intervals.map(m=>({...m,...workspaceModel.costPerLead(spendMonths,m.start,m.end,m.leadTotal)}));
  v.marketingSources=marketing.sources;
  v.marketingEmpty=marketing.sources.length===0;
  v.marketingEmptyNote=v.marketingEmpty?'No leads in the last 7 days, the last six weeks, or the quarter.':'';
  v.unworkedCount=workspaceModel.unworkedRows(trackerRows).length;
  if(s.period==='six'){for(const m of v.demandMetrics.slice(0,3))m.note=(m.note?m.note+' · ':'')+'Six-week total. The weekly average is in the marketing table.';}
  v.quickNumbers[0].value=f.number(funnelCounts.leads);v.quickNumbers[1].value=f.number(funnelCounts.mql);v.quickNumbers[2].value=f.number(funnelCounts.sql);
  v.quickNumbers[0].delta=period;v.quickNumbers[1].delta=period;v.quickNumbers[2].delta=period;
  v.quickNumbers[1].label='Marketing qualified';v.quickNumbers[2].label='Sales qualified';
  v.quickNumbers[3].value=f.number(completedMeetings);v.quickNumbers[3].delta=period+' · '+f.number(recordedMeetings)+' recordings separately';
  const opportunities=workspaceModel.dealsWithSheet(workspaceModel.annotateOpportunities(d.opportunities,s.records),s.sheetReview);
  const pipe=workspaceModel.pipelineTotals(opportunities,asOf);
  const moneyShort=n=>n==null?'—':'$'+f.number(n);
  v.quickNumbers[4].value=pipe.weighted==null?'—':moneyShort(pipe.weighted);
  v.quickNumbers[4].delta=moneyShort(pipe.openAmount)+' open · same deals';
  const stageMax=Math.max(1,...pipe.stages.map(g=>g.amount));
  v.stages=pipe.stages.map(g=>({stage:g.stage,count:g.count,amount:'$'+f.number(g.amount/1000)+'K',w:Math.round(g.amount/stageMax*100)+'%'}));
  v.scorecard=[
    {label:'Open pipeline',value:moneyShort(pipe.openAmount)},
    {label:'Weighted pipeline',value:moneyShort(pipe.weighted)},
    {label:'Active deals',value:f.number(pipe.count)}
  ];
  const renewals=workspaceModel.renewalBook(opportunities,asOf);
  const renewalCompany=o=>{
    const company=workspaceModel.companyForOpportunity(o,s.records);
    return workspaceModel.pipelineCompanyName(company&&company.name,o.dealName,o.name);
  };
  const renewalRow=(o,duplicate)=>({
    company:renewalCompany(o),
    amount:duplicate?'Not added':(o.amount==null?'—':moneyShort(o.amount)),
    line:[o.dealName||o.name||'Untitled deal',workspaceModel.renewalStage(o),duplicate?'same company as a current Renewal Agreement':''].filter(Boolean).join(' · ')
  });
  v.renewals=[...renewals.deals.map(o=>renewalRow(o,false)),...renewals.duplicates.map(o=>renewalRow(o,true))];
  v.renewalsValue=f.number(renewals.count)+' · '+moneyShort(renewals.amount);
  v.renewalsToggle='Show the '+f.number(renewals.deals.length)+' renewals'+(renewals.duplicates.length?' (and '+f.number(renewals.duplicates.length)+' placeholders)':'');
  v.renewalsNote='Customer renewals, not new business. The total counts '+f.number(renewals.count)+' renewals. Also listed but not counted: '+f.number(renewals.duplicates.length)+' legacy Renewal placeholder'+(renewals.duplicates.length===1?'':'s')+' for a company that already has a current Renewal Agreement. Not listed: '+f.number(renewals.pastClose)+' renewal'+(renewals.pastClose===1?'':'s')+' past the close date.';
  const held=workspaceModel.onHoldBook(opportunities);
  const unlisted=workspaceModel.hubspotOnlyBook(opportunities,asOf);
  const sideRow=o=>({
    company:renewalCompany(o),
    dealName:o.dealName||o.name||'Untitled deal',
    stage:workspaceModel.stageDisplay(o.stage),
    amount:o.amount==null?'—':moneyShort(o.amount),
    note:workspaceModel.closeDatePassed(o,asOf)?'close date passed':''
  });
  v.onHold=held.deals.map(sideRow);
  v.onHoldValue=f.number(held.count)+' · '+moneyShort(held.amount);
  v.onHoldNote='On Hold stays out of the open pipeline.';
  v.hubspotOnly=unlisted.deals.map(sideRow);
  v.hubspotOnlyValue=f.number(unlisted.count)+' · '+moneyShort(unlisted.amount);
  v.hubspotOnlyNote='In HubSpot, not on the Sheet. Shown for review. Not included in the open pipeline total.';
  v.showHubspotOnly=unlisted.count>0;
  const mkRule=workspaceModel.moneyK.bind(workspaceModel);
  const excluded=[renewals.count?f.number(renewals.count)+' renewals and customer expansions ('+mkRule(renewals.amount)+', renewal and customer-success pipelines)':'',held.count?f.number(held.count)+' On Hold ('+mkRule(held.amount)+')':'',unlisted.count?f.number(unlisted.count)+' HubSpot '+(unlisted.count===1?'deal':'deals')+' not on the Sheet ('+mkRule(unlisted.amount)+')':''].filter(Boolean);
  v.bookRuleLine='Open pipeline is the '+f.number(pipe.count)+' active new-business rows on the master Sheet, '+moneyShort(pipe.openAmount)+'. A past close date stays in. Not included: '+(excluded.length?excluded.join('; '):'nothing else')+'. Closed and Disqualified rows are not pipeline.';
  const mk=workspaceModel.moneyK.bind(workspaceModel);
  const mkt=s.marketing||{},budget=mkt.spend||{};
  const budgetMonths=budget.connected?budget.months:(d.report.spend.months||[]);
  const budgetChannels=budget.connected?budget.channels:(d.report.spend.channels||[]);
  v.spendMonths=budgetMonths.filter(m=>m.planned!=null||m.actual!=null).map(m=>({month:new Date(m.month+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'long',timeZone:'UTC'}),budget:mk(m.planned),actual:mk(m.actual),diff:m.actual==null?'Not comparable':(m.actual>=m.planned?'+':'−')+mk(Math.abs(m.actual-m.planned)).replace('-',''),tag:m.actual==null?'Not entered':'',tagDisplay:m.actual==null?'inline-flex':'none'}));
  const spendMax=Math.max(1,...budgetChannels.map(c=>c.amount));v.spendChannels=budgetChannels.map(c=>({name:c.name,amount:mk(c.amount),w:Math.round(c.amount/spendMax*100)+'%'}));
  const entered=budgetMonths.filter(m=>m.actual!=null);
  v.spendChannelRange=entered.length?'Recorded '+new Date(entered[0].month+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'short',timeZone:'UTC'})+' – '+new Date(entered[entered.length-1].month+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'short',timeZone:'UTC'})+' · by channel':'By channel';
  v.spendTotals=budget.connected?workspaceModel.spendVersusPlan(budget)+' Budget workbook, Actuals tab.':'';
  v.eventPayments=((mkt.shows||{}).unattributed||[]).map(u=>({vendor:u.vendor,amount:mk(u.amount)}));
  v.hasEventPayments=v.eventPayments.length>0;
  const outbound=mkt.outbound||{};
  // LemList does not track meetings, and a campaign with no sends is a draft, not a result.
  const sentCampaigns=(outbound.campaignStats||[]).filter(c=>c.sent);
  const idleCampaigns=(outbound.campaignStats||[]).filter(c=>!c.sent);
  v.ads=sentCampaigns.map(c=>({name:c.name+' · LemList',sent:f.number(c.sent),replies:f.number(c.replied),bounces:f.number(c.bounced),note:[c.opened?f.number(c.opened)+' opened':'opens not tracked',c.delivered!=null?f.number(c.delivered)+' delivered':'','meetings not tracked in LemList',c.status||''].filter(Boolean).join(' · ')+'. LemList, collected '+v.collectedShort+'.'}));
  v.idleCampaignsLine=idleCampaigns.length?'Drafts ('+idleCampaigns.length+') with no sends yet: '+idleCampaigns.map(c=>c.name).join(', ')+'.':'';
  v.hasIdleCampaigns=!!v.idleCampaignsLine;
  const adWindow=w=>{const m=String(w||'').match(/(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/);return m?f.date(m[1])+' – '+f.date(m[2])+' (the platform report’s own window, not calendar 2026)':'';};
  for(const a of mkt.ads||[])v.ads.push({name:a.name,sent:f.number(a.impressions),replies:f.number(a.conversions),bounces:'—',note:(a.window?adWindow(a.window)+' · ':'')+mk(a.spend)+' spend · '+f.number(a.clicks)+' clicks. Platform conversions, not qualified leads.'});
  v.outboundNote=outbound.connected?'':(outbound.reason||'LemList is not connected yet.');
  v.hasOutboundNote=!!v.outboundNote;
  const web=d.web||{},webRange=f.date(web.start)+' – '+f.date(web.end),webVisits=web.visits||[],webChannels=web.channels||[],webPages=web.pages||[];
  v.webMetrics=[{label:'Website visits',value:f.number(web.sessions),note:webRange+' · www.opstream.ai'},{label:'Page views',value:f.number(web.pageViews),note:'Same period'}];
  if(typeof web.engaged==='number')v.webMetrics.splice(1,0,{label:'Engaged visits',value:f.percent(web.engaged),note:f.number(web.engagedSessions)+' engaged sessions'});
  const ai=mkt.ai||{};
  if(ai.connected)v.webMetrics.push({label:'AI answers linking to opstream.ai',value:ai.domainCoverage==null?'—':ai.domainCoverage+'%',note:f.number(ai.prompts)+' monitored prompts · Otterly, collected '+f.date(ai.fetchedAt)},{label:'AI answers mentioning Opstream',value:ai.brandCoverage==null?'—':ai.brandCoverage+'%',note:'Same prompts · share of voice '+(ai.shareOfVoice==null?'—':ai.shareOfVoice+'%')});
  const webMax=Math.max(1,...webVisits.map(w=>w.value));v.webWeeks=webVisits.map(w=>({label:f.date(w.date),title:'Week of '+f.date(w.date)+': '+f.number(w.value)+' visits',h:Math.round(w.value/webMax*100)+'%'}));
  v.webCols=v.webWeeks.length;
  const gaChannels=(mkt.web&&mkt.web.channels&&mkt.web.channels.length)?mkt.web.channels:webChannels;
  v.webSources=gaChannels.map(c=>({name:c.name,visits:f.number(c.sessions),engaged:f.percent(c.sessions?c.engagedSessions/c.sessions:null),ke:c.keyEvents==null?'—':f.number(c.keyEvents)}));
  const spendMonthsHave=budgetMonths.some(m=>m.planned!=null||m.actual!=null);
  const spendChannelsHave=budgetChannels.some(c=>c.amount!=null);
  v.spendConnected=spendMonthsHave||spendChannelsHave;
  v.showSpend=v.spendConnected;
  v.adsConnected=(v.ads||[]).length>0;
  v.webConnected=typeof web.sessions==='number'&&web.sessions>0;
  v.showWeb=v.webConnected;
  v.showSpendMonths=spendMonthsHave;
  v.showWebWeeks=(v.webWeeks||[]).length>0;
  v.showWebSources=(v.webSources||[]).length>0;
  v.showAi=!!ai.connected;
  v.showDecisions=s.perf!=='spend'&&s.perf!=='web'&&(v.briefingDecisions||[]).length>0;
  v.webRangeLabel=webRange;
  const cw=(mkt.web&&mkt.web.channelsWindow)||null;
  const chFetched=workspaceModel.dateOnly(mkt.web&&mkt.web.channelsFetchedAt),collectedDay=workspaceModel.dateOnly(s.records&&s.records.generatedAt);
  v.webChannelsRangeLabel=(cw?'last '+cw.days+' days, '+f.date(cw.start)+' – '+f.date(cw.end):webRange)+(chFetched&&collectedDay&&chFetched<collectedDay?' · GA4 channel data from '+f.date(chFetched)+'; the latest refresh did not return a newer report':'');
  const untagged=(mkt.web&&mkt.web.untaggedSessions)||0;
  v.webNoiseNote=untagged?f.number(untagged)+' of these sessions are “Unassigned” or “(not set)” in GA4: usually bots, redirects or missing tags, not real visitors from a channel.':'';
  v.hasWebNoiseNote=!!v.webNoiseNote;
  const runId=s.hollie&&s.hollie.runId;
  v.runMismatch=!!(runId&&((s.agentBrief&&s.agentBrief.runId&&s.agentBrief.runId!==runId)||(s.heartbeat&&s.heartbeat.runId&&s.heartbeat.runId!==runId)||(s.heartbeatFixes&&s.heartbeatFixes.runId&&s.heartbeatFixes.runId!==runId)));
  v.runMismatchNote=v.runMismatch?'This section is from a different run than the queue. It is hidden so the page shows one set of numbers.':'';
  if(v.runMismatch){v.hasAgentBrief=false;v.hasHeartbeat=false;v.hasHeartbeatFixes=false;v.agentBriefParas=[];v.heartbeatInsights=[];v.heartbeatSummary='';v.heartbeatFixes=[];}
  if(!v.showWeb&&v.perfTabs)v.perfTabs=v.perfTabs.filter(t=>t.id!=='web');
  if(!v.showSpend&&v.perfTabs)v.perfTabs=v.perfTabs.filter(t=>t.id!=='spend');
  const gaPages=(mkt.web&&mkt.web.pages&&mkt.web.pages.length)?mkt.web.pages:webPages;
  v.landing=gaPages.slice(0,10).map(p=>({page:(p.display||p.name)+(p.strayHtml?' — the link ends in stray HTML “'+p.strayHtml+'”':''),visits:f.number(p.sessions),engaged:f.number(p.engagedSessions),ke:p.keyEvents==null?'—':f.number(p.keyEvents)}));
  v.webGapNote=(mkt.web&&!mkt.web.connected)?mkt.web.reason:'';v.hasWebGapNote=!!v.webGapNote;
  v.showLanding=(v.landing||[]).length>0;
  v.showWebBlock=v.showWebWeeks||v.showWebSources||v.showLanding;
  // The Data view's source table: describe what is actually in this extract.
  const tracker=workspaceModel.trackerRows(s.sheetReview,[]);
  const shows=(mkt.shows&&mkt.shows.items)||[];
  const ok='var(--color-text)',gap='var(--color-accent-700)';
  const masterId=((s.sheetReview?.leads||[]).find(l=>l.sheetRow?.spreadsheetId)||{}).sheetRow?.spreadsheetId;
  v.sources=[
    {url:'https://app.hubspot.com/contacts/'+workspaceModel.HUBSPOT_PORTAL,name:'HubSpot CRM',used:'Accounts, deals, contacts, notes, calls, meetings',updated:v.collectedShort,color:ok,count:f.number(s.records.companies.length)+' companies',gaps:'Email bodies are not included. The master Sheet overrides HubSpot deal amount, stage, close date and owner.'},
    {url:'https://fathom.video/home',name:'Fathom',used:'Recordings, summaries, action items',updated:v.collectedShort,color:ok,count:s.records.coverage.fathomTotal+' recordings',gaps:s.records.coverage.transcripts+' recordings include full transcripts.'},
    {url:masterId?'https://docs.google.com/spreadsheets/d/'+masterId+'/edit':'',name:'Master Sheet (pipeline_meeting1_v2)',used:'Open book, forecast, Lead Tracker',updated:v.collectedShort,color:tracker.length?ok:gap,count:f.number(tracker.length)+' Lead Tracker rows',gaps:'Owner-entered dates and probabilities.'},
    {url:budget.sheet?.url||'',name:'Marketing budget workbook',used:'Plan, actuals and the show calendar',updated:budget.connected?f.date(mkt.asOf):'Not connected yet',color:budget.connected?ok:gap,count:budget.connected?(f.number((budget.vendors||[]).length)+' vendor rows · '+shows.length+' shows'):'—',gaps:budget.connected?workspaceModel.missingSpendText(budget):'Connect the Sheets refresh token to read this workbook.'},
    {url:'https://analytics.google.com/analytics/web/#/p304508954/reports/intelligenthome',name:'GA4 · www.opstream.ai',used:'Website sessions, channels, landing pages',updated:v.collectedShort,color:(mkt.web&&mkt.web.connected)?ok:gap,count:f.number(web.sessions)+' sessions',gaps:(mkt.web&&mkt.web.connected)?'Visits cover '+webRange+'. Channels and landing pages cover the last 90 days'+((mkt.web.channelsWindow)?' ('+f.date(mkt.web.channelsWindow.start)+' – '+f.date(mkt.web.channelsWindow.end)+')':'')+'.':'Channels and landing pages are added on the next refresh.'},
    {url:'https://app.otterly.ai',name:'Otterly · AI answers',used:'Share of AI answers mentioning or linking to Opstream',updated:ai.connected?f.date(ai.fetchedAt):'Not connected yet',color:ai.connected?ok:gap,count:ai.connected?f.number(ai.prompts)+' prompts':'—',gaps:ai.connected?'Brand coverage and domain coverage from the latest report.':'No Otterly report is in this collection.'},
    {url:'https://app.lemlist.com',name:'LemList',used:'Outbound campaigns',updated:v.collectedShort,color:outbound.connected?ok:gap,count:f.number(outbound.campaigns||0)+' campaigns',gaps:outbound.connected?'Sent, reply and bounce counts per campaign.':'Sent and reply counts are not collected yet.'},
    {name:'Ad platforms (report sheets)',used:'Google, Reddit and OpenAI ads',updated:v.collectedShort,color:(mkt.ads||[]).length?ok:gap,count:(mkt.ads||[]).length+' platforms',gaps:'Platform conversions follow each platform’s definition, not the Lead Tracker.'}
  ];
  if(s.perf==='web')v.scopeNote='Website: '+webRange+' · www.opstream.ai only.'+(typeof web.aiCount==='number'?' AI: '+f.number(web.aiCount)+' completed monitored answers'+(web.aiEnd?' through '+f.date(web.aiEnd):'')+'.':'')+' No period filter applies.';
  else if(s.perf==='spend')v.scopeNote='Spend: Jan – Dec 2026, as entered in the workbook. Campaign counts use the '+v.collectedShort+' collection; advertising dates are shown per source.';
  else v.scopeNote='The period '+period+' applies to leads, MQLs and SQLs (Lead Tracker dates) and to completed meetings. The pipeline figures are today\'s totals, not the period. All dates are America/Phoenix.';
  const query=(s.search||'').trim().toLowerCase(),owner=s.owner||'Everyone',todayPhx=workspaceModel.phoenixToday();
  const quietIds=new Set(workspaceModel.quietDeals(opportunities,s.records,asOf).map(o=>o.id));
  const prelim=opportunities.map(o=>{
    const company=workspaceModel.companyForOpportunity(o,s.records);
    return {o,company,rawOwner:o.owner||company?.owner||''};
  }).filter(x=>workspaceModel.listStatus(x.o,asOf)!=='excluded');
  const resolved=workspaceModel.resolveOwners([...prelim.map(x=>x.rawOwner),...trackerRows.map(r=>r.owner)]);
  const infoFor=raw=>resolved.get(String(raw??''))||workspaceModel.ownerInfo(raw);
  const accountRows=prelim.map(({o,company,rawOwner})=>{
    const info=infoFor(rawOwner);
    const last=company?workspaceModel.lastEngagement(company,todayPhx):null;
    const quietDays=company?workspaceModel.daysQuiet(company,todayPhx):null;
    const liveQuiet=company?workspaceModel.relativeDays(last,workspaceModel.phoenixToday()):null;
    return {...o,owner:info.label,ownerKey:info.key,ownerTitle:info.title,lastEngagement:last,quietDays:liveQuiet!=null?liveQuiet:quietDays,companyRecord:company};
  }).filter(o=>(owner==='Everyone'||o.owner===owner)&&(!query||[o.name,o.note,o.stage,o.owner].join(' ').toLowerCase().includes(query))&&(!s.closeOn||(workspaceModel.dateOnly(o.close)===s.closeOn&&workspaceModel.isOpenPipeline(o,asOf)))&&(s.dealFilter!=='quiet'||quietIds.has(o.id)));
  const deduped=new Map();
  for(const o of accountRows){
    // One row per account, except when listing the deals that share a close date.
    const key=(s.closeOn||s.dealFilter)?String(o.id||o.name):String(o.companyId||o.name).replace(/^company:/,'');
    const prev=deduped.get(key);
    if(!prev){deduped.set(key,o);continue;}
    const better=workspaceModel.listStatus(o,todayPhx)!=='past'&&workspaceModel.listStatus(prev,todayPhx)==='past'
      ||(workspaceModel.listStatus(o,todayPhx)===workspaceModel.listStatus(prev,todayPhx)&&(Number(o.amount)||0)>(Number(prev.amount)||0));
    if(better)deduped.set(key,o);
  }
  const selected=[...deduped.values()].sort((a,b)=>workspaceModel.compare(a,b,s.sort||'amount',todayPhx));
  const optionRows=[...prelim.map(({rawOwner})=>infoFor(rawOwner)),...trackerRows.map(r=>infoFor(r.owner))].filter(info=>info.label&&info.label!=='Unassigned');
  v.ownerOptions=[...new Map(optionRows.map(info=>[info.label,info])).values()].sort((a,b)=>a.label.localeCompare(b.label)).map(info=>({name:info.label,title:info.title||''}));
  v.peopleNote=v.ownerOptions.length?('Owners in the collected record: '+v.ownerOptions.map(o=>o.name).join(' · ')+'. The owner filter uses these values.'):'Owner information was not in the collected record.';
  if(s.accounts==='leads')v.ownerOptions.push({name:'Unassigned',title:'No owner on the Lead Tracker'});
  v.showLastNote=selected.some(o=>String(o.note||'').trim()||(o.hubspotDiffers&&o.hubspotDiffers.length));
  v.lastNoteDisplay=v.showLastNote?'table-cell':'none';
  const closeCounts=new Map();
  for(const o of opportunities.filter(o=>workspaceModel.isOpenPipeline(o,asOf))){const c=workspaceModel.dateOnly(o.close);if(c)closeCounts.set(c,(closeCounts.get(c)||0)+1);}
  const placeholderDates=new Set([...closeCounts].filter(([,n])=>n>=5).map(([d])=>d));
  const openTotal=[...closeCounts.values()].reduce((a,b)=>a+b,0);
  const shared=[...placeholderDates].sort((a,b)=>closeCounts.get(b)-closeCounts.get(a)).map(d=>closeCounts.get(d)+' share '+workspaceModel.formatDate(d));
  v.placeholderNote=shared.length?'Of '+openTotal+' open deals, '+shared.join(' and ')+'. '+(shared.length>1?'These are':'This is')+' probably a placeholder close date, not a forecast. Dates are shown as entered.':'';
  v.hasPlaceholderNote=!!v.placeholderNote;
  const diffText=o=>(o.hubspotDiffers||[]).map(k=>k==='amount'?'HubSpot amount '+moneyShort(o.hubspotAmount):k==='close'?'HubSpot close '+workspaceModel.formatDate(o.hubspotClose):k==='stage'?'HubSpot stage '+workspaceModel.stageDisplay(o.hubspotStage):k==='owner'?'HubSpot owner '+workspaceModel.displayOwner(o.hubspotOwner):k==='probability'?'HubSpot probability '+f.percent(workspaceModel.probabilityFraction(o.hubspotProbability)):'').filter(Boolean).join(' · ');
  const dealFlags=o=>[diffText(o),placeholderDates.has(workspaceModel.dateOnly(o.close))?'likely placeholder close date':'',workspaceModel.closeDatePassed(o,asOf)?'close date passed':'',String(o.note||'').trim()].filter(Boolean).join(' · ');
  v.deals=selected.map(o=>{
    const companyName=workspaceModel.pipelineCompanyName(o.companyRecord&&o.companyRecord.name,o.dealName||o.name,o.name);
    const note=dealFlags(o);
    return {company:companyName,owner:o.owner,ownerTitle:o.ownerTitle||'',stage:workspaceModel.stageDisplay(o.stage),arr:o.amount==null?'—':'$'+f.number(o.amount),prob:workspaceModel.probabilityFraction(o.probability)==null?'—':f.percent(workspaceModel.probabilityFraction(o.probability)),weighted:workspaceModel.weighted(o)==null?'—':'$'+f.number(workspaceModel.weighted(o)),close:workspaceModel.closeLabel(o.close),days:o.days??'—',daysColor:o.days>120?'var(--color-accent-700)':'var(--color-text)',note,lastInteraction:o.lastEngagement?workspaceModel.formatDate(o.lastEngagement)+(o.quietDays!=null?' · '+workspaceModel.relativeLabel(o.lastEngagement,workspaceModel.phoenixToday()):''):'—',go:()=>{const c=o.companyRecord;if(c)this.go('account',{accountId:c.id,timelineAll:false,peopleAll:false})();else this._verifiedOpenRefs(o.refs,'Deal record · '+o.name);}};
  }).filter(Boolean);
  v.dealsCount=selected.length+' accounts · '+pipe.count+' open deals';
  v.hasCloseOn=(!!s.closeOn||s.dealFilter==='quiet')&&s.accounts==='deals';
  v.closeOnLine=!v.hasCloseOn?'':s.dealFilter==='quiet'?f.number(selected.length)+' open deals with no engagement in '+workspaceModel.QUIET_DAYS+'+ days':f.number(selected.length)+' open deals closing '+workspaceModel.formatDate(s.closeOn);
  const leadBase=trackerRows;
  v.leadTrackerNote='';
  const stageNames={'mql-no-sql':'MQL, no SQL yet','no-mql':'No MQL date'};
  const leadRows=leadBase.map(r=>{const info=infoFor(r.owner);return {...r,owner:info.label,ownerTitle:info.title};}).filter(r=>(owner==='Everyone'||r.owner===owner)&&(!s.leadStage||workspaceModel.leadStage(r)===s.leadStage)&&(!s.leadSource||workspaceModel.sourceLabel(r.source)===s.leadSource)&&(!s.leadFlag||(s.leadFlag==='hot'?r.flags?.hot:!r.flags?.dead))&&(!query||[r.name,r.source,r.note,r.owner,r.contact?.name,r.contact?.title].join(' ').toLowerCase().includes(query))&&(s.contributor?inRange(s.contributor==='lead'?workspaceModel.firstTouch(r):r[s.contributor]):true)).sort((a,b)=>workspaceModel.compareLeads(a,b));
  const personKey=r=>r.contact?.email?String(r.contact.email).toLowerCase():r.contact?.name?(r.name+'|'+r.contact.name).toLowerCase():'';
  const seenPeople=new Set();
  v.leads=leadRows.map(r=>{const key=personKey(r),dup=!!key&&seenPeople.has(key);if(key)seenPeople.add(key);return {company:r.name,isHot:!!r.flags?.hot,isDead:!!r.flags?.dead,isDuplicate:dup,noContact:!key,contact:r.contact?.name||'—',contactTitle:r.contact?.title||'',email:r.contact?.email||'',hasEmail:!!r.contact?.email,mailto:r.contact?.email?'mailto:'+r.contact.email:'',source:workspaceModel.sourceLabel(r.source),owner:r.owner||'—',ownerTitle:r.ownerTitle||'',date:f.date(workspaceModel.firstTouch(r)),note:r.note,mql:f.date(r.mql),sql:f.date(r.sql),sheetUrl:r.sheetRow?.url||'',sheetLabel:r.sheetRow?.row?'Row '+r.sheetRow.row:'',sheetTitle:r.sheetRow?.label||''};});
  const people=new Set(leadRows.map(personKey).filter(Boolean)).size,contactless=leadRows.filter(r=>!personKey(r)).length;
  v.leadsPeopleLine=people+' unique '+(people===1?'person':'people')+(contactless?' · '+contactless+' without a contact':'')+(leadRows.length-contactless>people?' · '+(leadRows.length-contactless-people)+' repeat'+(leadRows.length-contactless-people===1?'':'s'):'');
  v.leadsEmpty=leadRows.length===0;v.dealsEmpty=selected.length===0;
  v.leadsCount=leadRows.length+' '+trackerLabel+' rows'+(s.contributor?' · '+s.contributor.toUpperCase()+' date '+period:'');
  v.leadSourceOptions=[...new Set(trackerRows.map(r=>workspaceModel.sourceLabel(r.source)).filter(Boolean))].sort().map(name=>({name}));
  v.leadStageValue=s.leadStage||'';v.leadSourceValue=s.leadSource||'';
  v.setLeadStage=e=>this.setState({leadStage:e.target.value||null});v.setLeadSource=e=>this.setState({leadSource:e.target.value||null});
  v.leadFilterLine=[s.leadSource?'Source: '+s.leadSource:'',owner!=='Everyone'?'Owner: '+owner:'',s.leadStage?stageNames[s.leadStage]:'',s.leadFlag==='hot'?'Buying intent in the note':s.leadFlag==='live'?'Dead or disqualified notes left out':'',query?'Search: “'+(s.search||'').trim()+'”':''].filter(Boolean).join(' · ');
  v.hasLeadFilters=!!v.leadFilterLine;v.leadsShown=f.number(leadRows.length)+' lead'+(leadRows.length===1?'':'s');
  v.clearSearch=()=>this.setState({search:'',owner:'Everyone',contributor:null,leadStage:null,leadSource:null,leadFlag:null,closeOn:null,dealFilter:null});
  v.accountTabs.forEach(t=>{const go=t.go;t.go=()=>{this.setState({contributor:null,leadStage:null,leadSource:null,leadFlag:null,closeOn:null,dealFilter:null});go();};});
  v.exportLabel=s.accounts==='leads'?'Export '+leadRows.length+' leads':s.accounts==='follow'?'Export follow-ups':'Export '+selected.length+' opportunities';
  if(s.accounts==='leads')v.exportAccounts=()=>this.csv('leads.csv',['Company','Contact','Title','Email','Source','Owner','Lead date','Notes','MQL date','SQL date','Lead Tracker row'],leadRows.map(r=>[r.name,r.contact?.name||'',r.contact?.title||'',r.contact?.email||'',r.source,r.owner,r.lead,r.note,r.mql,r.sql,r.sheetRow?.url||'']));
  else if(s.accounts==='deals')v.exportAccounts=()=>this.csv('opportunities.csv',['Company','Owner','Stage','Amount','Probability','Weighted','Close','Days in stage'].concat(v.showLastNote?['Flags']:[]),selected.map(o=>[workspaceModel.companyName(o.name),o.owner,o.stage,o.amount,workspaceModel.probabilityFraction(o.probability),workspaceModel.weighted(o),workspaceModel.closeLabel(o.close),o.days].concat(v.showLastNote?[dealFlags(o)]:[])));
  v.exportSources=()=>this.csv('leads-by-source.csv',['Source','This week','6-week average','Quarter to date','Quarter cost per lead'],(v.marketingSources||[]).map(r=>[r.channel,r.week,r.six,r.quarter,r.cpl]));
  v.exportSpend=()=>this.csv('spend-2026.csv',['Month','Planned','Recorded','Note'],budgetMonths.map(m=>[m.month,m.planned,m.actual,m.actual==null?'Not entered':'']));
  // The newest CRM notes on accounts with an open deal: text, date and who wrote it.
  const openCompanies=new Map();for(const o of opportunities.filter(o=>workspaceModel.isOpenPipeline(o,asOf))){const c=workspaceModel.companyForOpportunity(o,s.records);if(c&&!openCompanies.has(c.id))openCompanies.set(c.id,c);}
  v.movements=[...openCompanies.values()].flatMap(c=>(c.notes||[]).filter(n=>n.date&&workspaceModel.plainNote(n.text)).map(n=>({c,n}))).sort((a,b)=>String(b.n.date).localeCompare(String(a.n.date))).slice(0,6).map(({c,n})=>{const text=workspaceModel.plainNote(n.text);return {name:workspaceModel.companyName(c.name),meta:workspaceModel.formatDate(n.date)+' · '+workspaceModel.displayOwner(n.owner),change:text.length>180?text.slice(0,177).replace(/\s+\S*$/,'')+'…':text,go:this.go('account',{accountId:c.id})};});
  v.showOwnerNotes=v.movements.length>0;
  v.checkUpdates=()=>{this.setState({checking:true});return this._loadVerified();};v.checkNote=s.verifiedError||('Verified collection · '+v.collectedShort+(s.checkedAt?' · last checked '+s.checkedAt:''));
  v.coverageNote=s.records.companies.length+' account pages; '+f.number(s.records.coverage.contacts)+' linked contacts, '+f.number(s.records.coverage.notes)+' notes, '+s.records.coverage.fathomTotal+' unique recordings and '+s.records.coverage.transcripts+' complete transcripts. The open deals list covers companies with open deals in HubSpot; lead numbers use '+f.number(trackerRows.length)+' '+trackerLabel+' rows with lead, MQL and SQL dates where recorded.';
  if(v.readingRules[4])v.readingRules[4].text='The workspace uses the retained '+v.collectedShort+' collection. Website reports cover '+webRange+'.';
  if(s.transcriptError&&v.mtg)v.mtg.transcriptNote=s.transcriptError;
  const attachToNew=(action,refs)=>()=>{const before=(this.state.newDrafts||[]).length;action();if((this.state.newDrafts||[]).length>before){const additions=[...this.state.newDrafts];additions[before]={...additions[before],supportRefs:refs,refs:refs.length};this.setState({newDrafts:additions});}};
  const selectedCompany=this._verifiedAccount(s.accountId);
  if(selectedCompany)v.acct.draftGo=attachToNew(v.acct.draftGo,selectedCompany.refs||[]);
  const selectedRecording=[...s.records.companies.flatMap(c=>c.recordings),...s.records.unmatchedRecordings].find(r=>r.id===s.meetingId);
  if(selectedRecording)v.mtg.draftGo=attachToNew(v.mtg.draftGo,selectedRecording.refs||[]);
  if(s.evidence && !v.ev?.operational){
    let refs=s.evidence==='verified-refs'?s.verifiedRefs:[];
    const [kind,id,...tail]=String(s.evidence).split(':'),detail=tail.join(':');
    const c=s.records.companies.find(c=>c.id===id||c.deals.some(d=>d.id===id));
    if(kind==='note')refs=c?.notes.find(n=>n.id===detail)?.refs;
    if(kind==='call')refs=c?.calls?.find(n=>n.id===detail)?.refs;
    if(kind==='company')refs=c?.refs;
    if(kind==='deal')refs=c?.deals.find(d=>d.id===id)?.refs;
    if(kind==='contact')refs=c?.contacts.find(p=>(p.email||p.name)===detail)?.refs;
    if(kind==='crm-meeting')refs=c?.meetings.find(m=>m.id===detail)?.refs;
    if(kind==='recording')refs=['evidence:'+id];
    if(!refs?.length&&d.evidenceKeys[s.evidence])refs=d.evidenceKeys[s.evidence];
    if(!refs?.length&&String(s.evidence).startsWith('sheet:'))refs=d.opportunities.find(o=>o.name===s.evidence.slice(6))?.refs;
    if(!refs?.length)refs=String(v.ev?.ids||'').match(/evidence:[a-f0-9-]{36}/g)||[];
    const found=(refs||[]).map(ref=>s.verifiedEvidence[ref]).filter(Boolean);
    if(found.length)v.ev={kicker:'Original collected record',title:s.evidence==='verified-refs'?s.verifiedTitle:v.ev.title,meta:found.map(e=>e.source+' · collected '+workspaceModel.formatDateTime(e.capturedAt)).filter((x,i,a)=>a.indexOf(x)===i).join(' · '),rows:found.map(e=>({label:e.title,value:verifiedEvidenceText(e)})),note:'Exact retained source text and fields. Dates and forecasts remain as recorded.',ids:found.map(e=>e.ref+' · '+e.nativeId).join(' · '),missing:found.length!==refs.length,hasRows:true};
    if(s.evidence==='draft-refs'){
      const addition=s.newDrafts?.[s.draft-d.drafts.length-(d.presentation.suggestedDrafts?.length||0)];
      const source=addition?{refs:addition.supportRefs||[]}:d.drafts[s.draft]?.draft||d.presentation.suggestedDrafts?.[s.draft-d.drafts.length];
      const items=(source?.refs||[]).map(ref=>s.verifiedEvidence[ref]).filter(Boolean);
      v.ev={kicker:'Supporting material',title:'Records behind this draft',meta:'',rows:items.map(e=>({label:e.title,value:verifiedEvidenceText(e)})),note:items.length?'':'No supporting records are attached to this new draft.',missing:false,hasRows:items.length>0};
    }
    v.exportEvidence=()=>this.csv('collected-record.csv',['Field','Value'],v.ev.rows.map(r=>[r.label,r.value]));
  }
  return v;
};

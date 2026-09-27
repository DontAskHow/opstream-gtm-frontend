// Values come from the retained source collection. The original beta owns the UI.
const verifiedFormat = {
  number:n=>n==null?'—':Math.round(n).toLocaleString('en-US'),
  date:d=>workspaceModel.formatDate(d),
  percent:n=>n==null?'—':(n*100).toLocaleString('en-US',{maximumFractionDigits:1})+'%',
  add:(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10)
};
const verifiedEvidenceText=e=>[e.content,e.fields&&Object.keys(e.fields).length?Object.entries(e.fields).map(([key,value])=>key+': '+(typeof value==='object'?JSON.stringify(value):value)).join('\n'):null].filter(Boolean).join('\n\n');
Component.prototype._loadVerified = async function () {
  const read=async name=>{const r=await fetch('data/'+name+'.json',{cache:'no-store'});if(!r.ok)throw new Error('Collection unavailable');return r.json();};
  try {
    const [verified,records,evidence,draftSeeds,sheetLabels]=await Promise.all(['verified','records','evidence','draft-seeds','evidence-sheet-labels'].map(read));
    if(verified.snapshotId!==records.verifiedSnapshotId)throw new Error('Collection versions differ');
    let hollie=null;try{hollie=await read('hollie');}catch{}
    let agentBrief=null;try{agentBrief=await read('agent-brief');}catch{}
    let heartbeat=null;try{heartbeat=await read('heartbeat');}catch{}
    let heartbeatFixes=null;try{heartbeatFixes=await read('heartbeat-fixes');}catch{}
    let proposals=[];try{const pr=await fetch('data/crm-proposals.json',{cache:'no-store'});if(pr.ok){const pj=await pr.json();proposals=Array.isArray(pj)?pj:[];}}catch{}
    let sheetReview=null;try{sheetReview=await read('sheet-review');}catch{}
    this.setState({verified,records,verifiedEvidence:evidence,draftSeeds,sheetLabels,hollie,agentBrief,heartbeat,heartbeatFixes,proposals,sheetReview,verifiedError:null,checking:false,checkedAt:workspaceModel.formatTime(new Date().toISOString())});
    try{
      const banner=document.getElementById('topBanner');
      if(banner){
        const isDemo=/synthetic|demo/i.test(verified.snapshotId||'');
        const cDate=records.generatedAt?workspaceModel.formatDateTime(records.generatedAt):'';
        banner.textContent=isDemo
          ? 'PUBLIC DEMO · All data is synthetic · Changes stay in your browser · Email and Slack are disabled'
          : 'Company data · HubSpot, Fathom, Sheets, GA4'+(cDate?' · collected '+cDate:'')+' · Drafts stay in your browser · Nothing is sent without approval';
      }
    }catch{}
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
  const exact=data.companies.find(c=>c.id===id||c.name===idOrName);if(exact)return exact;
  const alias=verified?.opportunities.find(o=>o.name===idOrName);
  const linked=alias?.companyId?.replace(/^company:/,'');
  return data.companies.find(c=>c.id===linked||(c.related||[]).some(r=>r.id===id||r.id===linked))||null;
};
Component.prototype._verifiedOpportunityRows = function () {
  const today=workspaceModel.asOf(this.state.records&&this.state.records.generatedAt);
  const overrides=workspaceModel.sheetOverrides(this.state.sheetReview);
  const opportunities=workspaceModel.annotateOpportunities(this.state.verified?.opportunities,this.state.records).map(o=>workspaceModel.applySheetDeal(o,overrides));
  return opportunities.filter(o=>workspaceModel.isOpenPipeline(o,today)&&!workspaceModel.isJunkName(o.name)&&!workspaceModel.isJunkName(o.dealName)).map(o=>{
    const company=workspaceModel.companyForOpportunity(o,this.state.records);
    const name=workspaceModel.pipelineCompanyName(company&&company.name,o.dealName,o.name);
    return [name,o.owner||'—',workspaceModel.stageDisplay(o.stage),o.amount,o.probability==null?null:Math.round(workspaceModel.probabilityFraction(o.probability)*100),workspaceModel.dateOnly(o.close),o.days,o.note||''];
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
  try{const response=await fetch('data/transcripts/'+encodeURIComponent(id)+'.json');if(!response.ok)throw new Error();const lines=await response.json();this.setState({transcripts:{...this.state.transcripts,[id]:lines},transcriptError:null});}
  catch{this.setState({transcriptError:'The transcript could not be loaded. Close it and try again.'});}
};
Component.prototype._verifiedOpenRefs = function (refs,title) {
  this.setState({evidence:'verified-refs',verifiedRefs:refs,verifiedTitle:title});
};
Component.prototype._verifiedTarget = function (target) {
  return ()=>{
    const d=this.state.verified;
    if(target.kind==='view')return this.go(target.view,{...(target.tab?{[target.view==='pipeline'?'perf':target.view]:target.tab}:{}),search:target.search||'',owner:'Everyone',contributor:null})();
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
  const funnelCounts=workspaceModel.funnel(d.leads,s.records,start,end);
  const period=f.date(start)+' – '+f.date(end);
  const goLeads=contributor=>this.go('accounts',{accounts:'leads',contributor,search:'',owner:'Everyone'});
  const headline=[
    ['New leads',funnelCounts.leads,'By lead date'],
    ['Marketing qualified',funnelCounts.mql,'Meetings booked'],
    ['Sales qualified',funnelCounts.sql,'Meetings held (recording or CRM marked held)']
  ];
  v.demandMetrics.slice(0,3).forEach((m,i)=>{m.value=f.number(headline[i][1]);m.delta=period;m.note=headline[i][2];m.label=headline[i][0];m.go=goLeads(['lead','mql','sql'][i]);});
  const activity=workspaceModel.activityFromRecords(s.records);
  const completedMeetings=activity.meetings.filter(m=>inRange(m.start)&&/complete|held|completed/i.test(m.outcome||'')).length;
  const recordedMeetings=activity.recordings.filter(r=>inRange(r.date)).length;
  v.demandMetrics[3].value=f.number(completedMeetings);v.demandMetrics[4].value=f.number(recordedMeetings);
  const goPastMeetings=this.go('meetings',{meetings:'past'});
  v.demandMetrics[3].delta=period;v.demandMetrics[3].note='CRM meetings marked completed. Not the same as sales qualified, which also counts a recording.';v.demandMetrics[3].label='Meetings completed';v.demandMetrics[3].go=goPastMeetings;
  v.demandMetrics[4].delta=period;v.demandMetrics[4].note='Fathom recordings, counted on their own';v.demandMetrics[4].go=goPastMeetings;
  v.periodRange=period;
  const monthly=s.period==='year'||(Date.parse(end)-Date.parse(start))/86400000>120;
  let at=monthly?start.slice(0,7)+'-01':s.period==='custom'?start:f.add(start,-((new Date(start+'T12:00:00Z').getUTCDay()+6)%7));
  const bars=[];
  while(at<=end){const next=monthly?new Date(Date.UTC(+at.slice(0,4),+at.slice(5,7),1,12)).toISOString().slice(0,10):f.add(at,7);const last=f.add(next,-1);const leads=d.leads.filter(r=>inRange(r.lead)&&r.lead>=at&&r.lead<=last).length;bars.push({date:at,label:monthly?new Date(at+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',timeZone:'UTC'}):f.date(at),leads});at=next;}
  const max=Math.max(1,...bars.map(b=>b.leads));v.weeks=bars.map(b=>({...b,title:(monthly?'':'Week of ')+b.label+': '+b.leads+' new leads',leadH:Math.round(b.leads/max*100)+'%'}));v.barCols=bars.length;v.barsTitle=monthly?'New leads by month':'New leads by week';
  v.channels=workspaceModel.channels(d.leads,s.records,start,end).map(r=>{
    const unlinked=r.channel==='Unattributed'&&!r.leads&&(r.mql||r.sql);
    return {channel:unlinked?'Meetings not linked to a lead':r.channel,leads:r.leads,mql:r.mql,sql:r.sql,rate:r.leads?Math.round(r.sql/r.leads*100)+'%':'—'};
  });
  v.showChannelLinkNote=v.channels.some(c=>c.channel==='Meetings not linked to a lead');
  v.channelLinkNote=v.showChannelLinkNote?"Meetings aren't linked to leads in this extract, so booked and held meetings are listed on their own row.":'';
  v.channelFoot=v.showChannelLinkNote
    ?'Same definitions as the cards: leads by lead date, MQL by meetings booked, SQL by meetings held. These rows are not a conversion funnel.'
    :'Same definitions as the cards: leads by lead date, MQL by meetings booked, SQL by meetings held. A meeting with no lead source is listed as Unattributed so the columns add up to the cards.';
  const asOf=workspaceModel.asOf(s.records&&s.records.generatedAt);
  const marketing=workspaceModel.marketingView(d.leads,s.records,d.report&&d.report.spend,asOf);
  v.marketingIntervals=marketing.intervals;
  v.marketingSources=marketing.sources;
  v.marketingEmpty=marketing.sources.length===0;
  v.marketingEmptyNote=v.marketingEmpty?'No leads in this week, the last six weeks, or the quarter.':'';
  if(s.period==='six'){for(const m of v.demandMetrics.slice(0,3))m.note=(m.note?m.note+' · ':'')+'Six-week total. The weekly average is in the marketing table.';}
  v.quickNumbers[0].value=f.number(funnelCounts.leads);v.quickNumbers[1].value=f.number(funnelCounts.mql);v.quickNumbers[2].value=f.number(funnelCounts.sql);
  v.quickNumbers[0].delta=period;v.quickNumbers[1].delta=period;v.quickNumbers[2].delta=period;
  v.quickNumbers[1].label='Marketing qualified';v.quickNumbers[2].label='Sales qualified';
  v.quickNumbers[3].value=f.number(completedMeetings);v.quickNumbers[3].delta=period+' · '+f.number(recordedMeetings)+' recordings separately';
  const overrides=workspaceModel.sheetOverrides(s.sheetReview);
  const opportunities=workspaceModel.annotateOpportunities(d.opportunities,s.records).map(o=>workspaceModel.applySheetDeal(o,overrides));
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
    dealName:o.dealName||o.name||'Untitled deal',
    stage:workspaceModel.renewalStage(o),
    amount:duplicate?'Not added':(o.amount==null?'—':moneyShort(o.amount)),
    note:duplicate?'Same company as a current Renewal Agreement':''
  });
  v.renewals=[...renewals.deals.map(o=>renewalRow(o,false)),...renewals.duplicates.map(o=>renewalRow(o,true))];
  v.renewalsValue=f.number(renewals.count)+' · '+moneyShort(renewals.amount);
  v.renewalsNote='Customer renewals, not new business. '+f.number(renewals.duplicates.length)+' legacy Renewal placeholders are not added because that company already has a current Renewal Agreement. '+f.number(renewals.pastClose)+' more are past their close date and are not in this total. A missing stage name has not been synced from the pipeline catalog yet.';
  const moneyCell=n=>n==null?'—':'$'+f.number(n);
  v.spendMonths=(d.report.spend.months||[]).map(m=>({month:new Date(m.month+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'long',timeZone:'UTC'}),budget:moneyCell(m.planned),actual:moneyCell(m.actual),diff:m.actual==null||m.partial?'Not comparable':(m.actual>=m.planned?'+':'−')+moneyCell(Math.abs(m.actual-m.planned)),tag:m.actual==null?'Not entered':m.partial?'Partly entered':'',tagDisplay:m.actual==null||m.partial?'inline-flex':'none'}));
  const spendMax=Math.max(1,...d.report.spend.channels.map(c=>c.amount));v.spendChannels=d.report.spend.channels.map(c=>({name:c.name,amount:moneyCell(c.amount),w:Math.round(c.amount/spendMax*100)+'%'}));
  v.ads=d.report.spend.campaigns.filter(c=>c.sent||c.replies||c.bounces||c.linkedinSent).map(c=>({name:c.name+' · email',sent:f.number(c.sent),replies:f.number(c.replies),bounces:f.number(c.bounces),note:'Collected '+v.collectedShort+'. LinkedIn separately: '+f.number(c.linkedinSent)+' sent, '+f.number(c.linkedinReplies)+' replies.'}));
  for(const report of d.report.spend.advertising){const sum=k=>report.rows.reduce((n,r)=>n+(r[k]||0),0);v.ads.push({name:report.name,sent:f.number(sum('impressions')),replies:f.number(sum('conversions')),bounces:'—',note:report.period+' Platform conversions, not qualified leads.'});}
  const web=d.web||{},webRange=f.date(web.start)+' – '+f.date(web.end),webVisits=web.visits||[],webChannels=web.channels||[],webPages=web.pages||[];
  v.webMetrics=[{label:'Website visits',value:f.number(web.sessions),note:webRange+' · www.opstream.ai'},{label:'Page views',value:f.number(web.pageViews),note:'Same period'}];
  if(typeof web.engaged==='number')v.webMetrics.splice(1,0,{label:'Engaged visits',value:f.percent(web.engaged),note:f.number(web.engagedSessions)+' engaged sessions'});
  if(typeof web.aiCount==='number')v.webMetrics.push({label:'AI answers linking to Opstream',value:f.percent(web.aiCited),note:f.number(web.aiCount)+' completed answers · through '+f.date(web.aiEnd)},{label:'AI answers mentioning Opstream',value:f.percent(web.aiMentioned),note:'Same completed answers'});
  const webMax=Math.max(1,...webVisits.map(w=>w.value));v.webWeeks=webVisits.map(w=>({label:f.date(w.date),title:'Week of '+f.date(w.date)+': '+f.number(w.value)+' visits',h:Math.round(w.value/webMax*100)+'%'}));
  v.webCols=v.webWeeks.length;
  v.webSources=webChannels.map(c=>({name:c.name,visits:f.number(c.sessions),engaged:f.percent(c.sessions?c.engagedSessions/c.sessions:null),ke:c.keyEvents}));
  const spendMonthsHave=(d.report.spend.months||[]).some(m=>m.planned!=null||m.actual!=null);
  const spendChannelsHave=(d.report.spend.channels||[]).some(c=>c.amount!=null);
  v.spendConnected=spendMonthsHave||spendChannelsHave;
  v.showSpend=v.spendConnected;
  v.adsConnected=(v.ads||[]).length>0;
  v.webConnected=typeof web.sessions==='number'&&web.sessions>0;
  v.showWeb=v.webConnected;
  v.showSpendMonths=(d.report.spend.months||[]).some(m=>m.planned!=null||m.actual!=null);
  v.showWebWeeks=(v.webWeeks||[]).length>0;
  v.showWebSources=(v.webSources||[]).length>0;
  v.showAi=typeof web.aiCount==='number';
  v.webRangeLabel=webRange;
  v.showOwnerNotes=!(v.movementsEmpty);
  v.connectionLines=[
    {name:'Spend',line:spendMonthsHave?'Spend is connected for the months with actuals.':spendChannelsHave?'Monthly spend is not connected. Channel totals are recorded without a month.':'Spend: not connected'},
    {name:'Ads',line:v.adsConnected?'Ads are connected.':'Ads: not connected'},
    {name:'Website & AI',line:v.webConnected?(typeof web.aiCount==='number'?'Website and AI figures are in this collection.':'Website sessions are in this collection. AI answers: not connected.'):'Website & AI: not connected'}
  ];
  const runId=s.hollie&&s.hollie.runId;
  v.runMismatch=!!(runId&&((s.agentBrief&&s.agentBrief.runId&&s.agentBrief.runId!==runId)||(s.heartbeat&&s.heartbeat.runId&&s.heartbeat.runId!==runId)||(s.heartbeatFixes&&s.heartbeatFixes.runId&&s.heartbeatFixes.runId!==runId)));
  v.runMismatchNote=v.runMismatch?'This section is from a different run than the queue. It is hidden so the page shows one set of numbers.':'';
  if(v.runMismatch){v.hasAgentBrief=false;v.hasHeartbeat=false;v.hasHeartbeatFixes=false;v.agentBriefParas=[];v.heartbeatInsights=[];v.heartbeatSummary='';v.heartbeatFixes=[];}
  if(!v.showWeb&&v.perfTabs)v.perfTabs=v.perfTabs.filter(t=>t.id!=='web');
  if(!v.showSpend&&v.perfTabs)v.perfTabs=v.perfTabs.filter(t=>t.id!=='spend');
  v.landing=webPages.slice(0,10).map(p=>({page:p.name,visits:f.number(p.sessions),engaged:f.number(p.engagedSessions),ke:p.keyEvents}));
  v.showLanding=(v.landing||[]).length>0;
  // The Data view's source table: describe what is actually in this extract.
  v.sources=[
    {name:'HubSpot CRM',used:'Accounts, deals, contacts, notes, calls, calendar',updated:v.collectedShort,color:'var(--color-text)',count:f.number(s.records.companies.length)+' companies',gaps:'Email counts are shown; email bodies are not included.'},
    {name:'Fathom',used:'Recordings, summaries, action items',updated:v.collectedShort,color:'var(--color-text)',count:s.records.coverage.fathomTotal+' recordings',gaps:s.records.coverage.transcripts+' recordings include full transcripts.'},
    {name:'Owner pipeline sheets',used:'Stage labels, ARR, probability, days in stage, last notes',updated:v.collectedShort,color:'var(--color-text)',count:f.number(d.opportunities.length)+' opportunities',gaps:'Only opportunities on the owner sheets carry stage age and notes; the CRM may differ.'},
    {name:'GA4 · www.opstream.ai',used:'Website sessions and page views',updated:v.collectedShort,color:'var(--color-text)',count:f.number(web.sessions)+' sessions',gaps:'Engagement breakdowns were not available.'},
    {name:'Lemlist',used:'Outbound campaigns',updated:v.collectedShort,color:'var(--color-text)',count:d.report.spend.campaigns.length+' campaigns',gaps:'Send and reply statistics were not available.'}
  ];
  if(s.perf==='web')v.scopeNote='Website: '+webRange+' · www.opstream.ai only. AI: '+f.number(web.aiCount)+' completed monitored answers through '+f.date(web.aiEnd)+'. No period filter applies.';
  else if(s.perf==='spend')v.scopeNote='Spend: Jan – Dec 2026, as entered in the workbook. Campaign counts use the '+v.collectedShort+' collection; advertising dates are shown per source.';
  else v.scopeNote='The period '+period+' applies to new leads, meetings booked and meetings held. Open pipeline is the current book. All dates are America/Phoenix.';
  const query=(s.search||'').trim().toLowerCase(),owner=s.owner||'Everyone',todayPhx=workspaceModel.phoenixToday();
  const prelim=opportunities.map(o=>{
    const company=workspaceModel.companyForOpportunity(o,s.records);
    return {o,company,rawOwner:o.owner||company?.owner||''};
  }).filter(x=>workspaceModel.listStatus(x.o,asOf)!=='excluded'&&!workspaceModel.isJunkName(x.o.name)&&!workspaceModel.isJunkName(x.o.dealName)&&!workspaceModel.isJunkName(x.company&&x.company.name));
  const resolved=workspaceModel.resolveOwners([...prelim.map(x=>x.rawOwner),...d.leads.map(r=>r.owner)]);
  const infoFor=raw=>resolved.get(String(raw??''))||workspaceModel.ownerInfo(raw);
  const accountRows=prelim.map(({o,company,rawOwner})=>{
    const info=infoFor(rawOwner);
    const last=company?workspaceModel.lastEngagement(company,todayPhx):null;
    const quietDays=company?workspaceModel.daysQuiet(company,todayPhx):null;
    const liveQuiet=company?workspaceModel.relativeDays(last,workspaceModel.phoenixToday()):null;
    return {...o,owner:info.label,ownerKey:info.key,ownerTitle:info.title,lastEngagement:last,quietDays:liveQuiet!=null?liveQuiet:quietDays,companyRecord:company};
  }).filter(o=>(owner==='Everyone'||o.owner===owner)&&(!query||[o.name,o.note,o.stage,o.owner].join(' ').toLowerCase().includes(query)));
  const deduped=new Map();
  for(const o of accountRows){
    const key=String(o.companyId||o.name).replace(/^company:/,'');
    const prev=deduped.get(key);
    if(!prev){deduped.set(key,o);continue;}
    const better=workspaceModel.listStatus(o,todayPhx)!=='past'&&workspaceModel.listStatus(prev,todayPhx)==='past'
      ||(workspaceModel.listStatus(o,todayPhx)===workspaceModel.listStatus(prev,todayPhx)&&(Number(o.amount)||0)>(Number(prev.amount)||0));
    if(better)deduped.set(key,o);
  }
  const selected=[...deduped.values()].sort((a,b)=>workspaceModel.compare(a,b,s.sort||'amount',todayPhx));
  const optionRows=[...prelim.map(({rawOwner})=>infoFor(rawOwner)),...d.leads.map(r=>infoFor(r.owner))].filter(info=>info.label&&info.label!=='Unassigned');
  v.ownerOptions=[...new Map(optionRows.map(info=>[info.label,info])).values()].sort((a,b)=>a.label.localeCompare(b.label)).map(info=>({name:info.label,title:info.title||''}));
  v.peopleNote=v.ownerOptions.length?('Owners in the collected record: '+v.ownerOptions.map(o=>o.name).join(' · ')+'. The owner filter uses these values.'):'Owner information was not in the collected record.';
  v.showLastNote=selected.some(o=>String(o.note||'').trim()||(o.hubspotDiffers&&o.hubspotDiffers.length));
  v.lastNoteDisplay=v.showLastNote?'table-cell':'none';
  v.deals=selected.map(o=>{
    const companyName=workspaceModel.pipelineCompanyName(o.companyRecord&&o.companyRecord.name,o.dealName||o.name,o.name);
    const flag=o.hubspotDiffers&&o.hubspotDiffers.length?'HubSpot differs':'';
    const note=[flag,String(o.note||'').trim()].filter(Boolean).join(' · ');
    return {company:companyName,owner:o.owner,ownerTitle:o.ownerTitle||'',stage:workspaceModel.stageDisplay(o.stage),arr:o.amount==null?'—':'$'+f.number(o.amount),prob:workspaceModel.probabilityFraction(o.probability)==null?'—':f.percent(workspaceModel.probabilityFraction(o.probability)),weighted:workspaceModel.weighted(o)==null?'—':'$'+f.number(workspaceModel.weighted(o)),close:workspaceModel.closeLabel(o.close),days:o.days??'—',daysColor:o.days>120?'var(--color-accent-700)':'var(--color-text)',note,lastInteraction:o.lastEngagement?workspaceModel.formatDate(o.lastEngagement)+(o.quietDays!=null?' · '+workspaceModel.relativeLabel(o.lastEngagement,workspaceModel.phoenixToday()):''):'—',go:()=>{const c=o.companyRecord;if(c)this.go('account',{accountId:c.id,timelineAll:false,peopleAll:false})();else this._verifiedOpenRefs(o.refs,'Owner worksheet · '+o.name);}};
  }).filter(Boolean);
  v.dealsCount=selected.length+' accounts · '+pipe.count+' open deals';
  const sheetLeadRows=(s.sheetReview&&s.sheetReview.leads)||[];
  const tracker=s.sheetReview&&s.sheetReview.leadTracker;
  const notSubscriber=r=>{const note=String(r.note||'').toLowerCase();const name=String(r.company||r.name||'');return note!=='subscriber'&&!note.includes('newsletter')&&!name.includes('@');};
  let leadBase;
  if(sheetLeadRows.length){
    leadBase=sheetLeadRows.filter(notSubscriber).map(r=>({...r,name:r.company||r.name,lead:r.lead||r.leadDate||null}));
    v.leadTrackerNote='';
  }else if(tracker&&tracker.total){
    leadBase=(tracker.recentMqlNoSql||[]).filter(notSubscriber).map(r=>({name:r.company,source:r.source,owner:r.owner,lead:null,mql:r.mqlDate||null,sql:null,note:'Recent MQL on the Lead Tracker'}));
    v.leadTrackerNote='Lead Tracker has '+tracker.total+' companies ('+tracker.unworked+' unworked). Full rows are not in this collection, so only the recent MQL rows on file are listed. Newsletter subscribers are not listed.';
    v.marketingSources=[];
    v.marketingEmpty=true;
    v.marketingEmptyNote='Lead source breakdown is not in this collection. The Lead Tracker has '+tracker.total+' companies. Full rows were not extracted, so HubSpot contacts are not shown as sources.';
  }else{
    leadBase=(d.leads||[]).filter(notSubscriber);
    v.leadTrackerNote='';
  }
  const leadRows=leadBase.map(r=>{const info=infoFor(r.owner);return {...r,owner:info.label,ownerTitle:info.title};}).filter(r=>(owner==='Everyone'||r.owner===owner)&&(!query||[r.name,r.source,r.note,r.owner].join(' ').toLowerCase().includes(query))&&(s.contributor?inRange(r[s.contributor]||r.lead||r.mql):true)).sort((a,b)=>workspaceModel.compareLeads(a,b));
  v.leads=leadRows.map(r=>({company:r.name,source:workspaceModel.sourceLabel(r.source),owner:r.owner||'—',ownerTitle:r.ownerTitle||'',date:f.date(r.lead||r.mql),note:r.note,mql:f.date(r.mql),sql:f.date(r.sql)}));
  v.leadsEmpty=leadRows.length===0;v.dealsEmpty=selected.length===0;
  v.leadsCount=sheetLeadRows.length?(leadRows.length+' Lead Tracker rows'):(tracker&&tracker.total?(leadRows.length+' recent MQL rows from the Lead Tracker'):(leadRows.length+' tracker records'+(s.contributor?' · '+s.contributor.toUpperCase()+' date '+period:' with a lead date')));
  if(sheetLeadRows.length){
    const sheetView=workspaceModel.marketingView(leadBase,s.records,d.report&&d.report.spend,asOf);
    v.marketingSources=sheetView.sources;
    v.marketingEmpty=sheetView.sources.length===0;
    v.marketingEmptyNote=v.marketingEmpty?'No Lead Tracker rows in this week, the last six weeks, or the quarter.':'';
  }
  v.accountTabs.forEach(t=>{const go=t.go;t.go=()=>{this.setState({contributor:null});go();};});
  v.exportLabel=s.accounts==='leads'?'Export '+leadRows.length+' leads':s.accounts==='follow'?'Export follow-ups':'Export '+selected.length+' opportunities';
  if(s.accounts==='leads')v.exportAccounts=()=>this.csv('leads.csv',['Company','Source','Owner','Lead date','Notes','MQL date','SQL date'],leadRows.map(r=>[r.name,r.source,r.owner,r.lead,r.note,r.mql,r.sql]));
  else if(s.accounts==='deals')v.exportAccounts=()=>this.csv('opportunities.csv',['Company','Owner','Stage','ARR','Probability','Weighted ARR','Close','Days in stage'].concat(v.showLastNote?['Last note']:[]),selected.map(o=>[workspaceModel.companyName(o.name),o.owner,o.stage,o.amount,o.probability,workspaceModel.weighted(o),workspaceModel.closeLabel(o.close),o.days].concat(v.showLastNote?[o.note]:[])));
  v.exportSources=()=>this.csv('leads-by-source.csv',['Source','This week','6-week average','Quarter to date','Quarter cost per lead'],(v.marketingSources||[]).map(r=>[r.channel,r.week,r.six,r.quarter,r.cpl]));
  v.exportSpend=()=>this.csv('spend-2026.csv',['Month','Planned','Recorded','Note'],d.report.spend.months.map(m=>[m.month,m.planned,m.actual,m.partial?'Partly entered':m.actual==null?'Not entered':'']));
  v.movements=v.movements.map(shown=>{const o=d.opportunities.find(o=>o.name===shown.name);return o?{name:workspaceModel.companyName(o.name),meta:workspaceModel.displayOwner(o.owner)+' · '+workspaceModel.stageDisplay(o.stage),change:o.note,go:()=>this._verifiedOpenRefs(o.refs,'Owner worksheet · '+o.name)}:shown;});
  v.checkUpdates=()=>{this.setState({checking:true});return this._loadVerified();};v.checkNote=s.verifiedError||('Verified collection · '+v.collectedShort+(s.checkedAt?' · last checked '+s.checkedAt:''));
  v.coverageNote=s.records.companies.length+' account pages; '+f.number(s.records.coverage.contacts)+' linked contacts, '+f.number(s.records.coverage.notes)+' notes, '+s.records.coverage.fathomTotal+' unique recordings and '+s.records.coverage.transcripts+' complete transcripts. The opportunity list covers companies with open deals in the CRM extract; the Lead Tracker holds '+d.leads.length+' HubSpot contact rows with lead, MQL and SQL dates where recorded.';
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
    if(found.length)v.ev={kicker:'Original collected record',title:s.evidence==='verified-refs'?s.verifiedTitle:v.ev.title,meta:found.map(e=>e.source+' · '+e.capturedAt).filter((x,i,a)=>a.indexOf(x)===i).join(' · '),rows:found.map(e=>({label:e.title,value:verifiedEvidenceText(e)})),note:'Exact retained source text and fields. Dates and forecasts remain as recorded.',ids:found.map(e=>e.ref+' · '+e.nativeId).join(' · '),missing:found.length!==refs.length,hasRows:true};
    if(s.evidence==='draft-refs'){
      const addition=s.newDrafts?.[s.draft-d.drafts.length-(d.presentation.suggestedDrafts?.length||0)];
      const source=addition?{refs:addition.supportRefs||[]}:d.drafts[s.draft]?.draft||d.presentation.suggestedDrafts?.[s.draft-d.drafts.length];
      const items=(source?.refs||[]).map(ref=>s.verifiedEvidence[ref]).filter(Boolean);
      v.ev={kicker:'Supporting material',title:'Records behind this draft',meta:'',rows:items.map(e=>({label:e.title,value:verifiedEvidenceText(e)})),note:items.length?'':'No supporting records are attached to this new draft.',missing:false,hasRows:items.length>0};
    }
    v.proposeCorrection=()=>{const sourceRefs=(refs||[]).filter(ref=>s.verifiedEvidence[ref]);const draft={kind:'Proposed correction',title:'Correction: '+v.ev.title,company:c?.name||'Not linked',text:'Describe the correction to '+v.ev.title+'. Original records remain unchanged.',rationale:v.ev.ids,refs:sourceRefs.length,supportRefs:sourceRefs,version:0,type:'Proposed correction',status:'Draft',recipients:'',saved:false};this.setState({newDrafts:[...s.newDrafts||[],draft],draft:v.saved.length+v.suggested.length,screen:'drafts',evidence:false});};
    v.exportEvidence=()=>this.csv('collected-record.csv',['Field','Value'],v.ev.rows.map(r=>[r.label,r.value]));
  }
  return v;
};

// Values come from the retained source collection. The original beta owns the UI.
const verifiedFormat = {
  number:n=>n==null?'—':Math.round(n).toLocaleString('en-US'),
  date:d=>d?new Date(d.slice(0,10)+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}):'—',
  percent:n=>n==null?'—':(n*100).toLocaleString('en-US',{maximumFractionDigits:1})+'%',
  add:(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10)
};
const verifiedEvidenceText=e=>[e.content,e.fields&&Object.keys(e.fields).length?Object.entries(e.fields).map(([key,value])=>key+': '+(typeof value==='object'?JSON.stringify(value):value)).join('\n'):null].filter(Boolean).join('\n\n');
Component.prototype._loadVerified = async function () {
  const read=async name=>{const r=await fetch('data/'+name+'.json',{cache:'no-store'});if(!r.ok)throw new Error('Collection unavailable');return r.json();};
  try {
    const [verified,records,evidence,draftSeeds,sheetLabels]=await Promise.all(['verified','records','evidence','draft-seeds','evidence-sheet-labels'].map(read));
    if(verified.snapshotId!==records.verifiedSnapshotId)throw new Error('Collection versions differ');
    this.setState({verified,records,verifiedEvidence:evidence,draftSeeds,sheetLabels,verifiedError:null,checking:false});
  } catch {this.setState({checking:false,verifiedError:'The collected data could not be loaded. Reload the page to try again.'});}
};
Component.prototype._verifiedRange = function () {
  const s=this.state;
  if(s.period==='six')return ['2026-07-20','2026-08-30'];
  if(s.period==='year')return ['2026-01-01','2026-09-08'];
  if(s.period==='custom')return [s.start||'2026-08-01',s.end||'2026-09-08'].sort();
  return ['2026-07-01','2026-09-08'];
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
  return (this.state.verified?.opportunities||[]).map(o=>[o.name,o.owner||'—',o.stage,o.amount,o.probability==null?null:o.probability*100,o.close,o.days,o.note]);
};
Component.prototype._verifiedLeadRows = function () {
  return (this.state.verified?.leads||[]).map(r=>[r.name,r.source,r.owner||'—',verifiedFormat.date(r.lead),r.note,verifiedFormat.date(r.mql),verifiedFormat.date(r.sql)]);
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
    if(target.kind==='view')return this.go(target.view,{...(target.tab?{[target.view==='performance'?'perf':target.view]:target.tab}:{}),search:target.search||'',owner:'Everyone',contributor:null})();
    if(target.kind==='account'){const c=this._verifiedAccount(target.id);if(c)return this.go('account',{accountId:c.id})();const o=d.opportunities.find(o=>o.companyId===target.id);return this._verifiedOpenRefs(o?.refs||[],'Account supporting records');}
    if(target.kind==='meeting'){const r=[...this.state.records.companies.flatMap(c=>c.recordings),...this.state.records.unmatchedRecordings].find(r=>r.nativeId===target.id||r.id===target.id);return this.go('meeting',{meetingId:r?.id||target.id})();}
    if(target.kind==='evidence')return this._verifiedOpenRefs([target.ref],'Supporting record');
    if(target.kind==='draft'){const account=target.id.replace(/^follow-up:/,''),index=d.drafts.findIndex(({draft})=>draft.id===target.id||draft.accountIds.includes(account));if(index>=0)return this.go('drafts',{draft:index,draftId:null,draftPurpose:null})();return this._verifiedOpenRefs([],'Draft unavailable');}
  };
};
const verifiedRender=Component.prototype.renderVals;
Component.prototype.renderVals = function () {
  const v=verifiedRender.call(this),s=this.state,d=s.verified,f=verifiedFormat;
  if(!d){v.isLoading=!s.verifiedError;v.notLoading=false;if(s.verifiedError){v.bannerShown=true;v.banner={bg:'var(--color-surface)',fg:'var(--color-text)',btnBg:'transparent',title:'Collection unavailable',text:s.verifiedError,action:'Try again',go:()=>this._loadVerified()};}return v;}
  const invalidAccount=s.screen==='account'&&s.accountId&&!this._verifiedAccount(s.accountId);
  const invalidMeeting=s.screen==='meeting'&&s.meetingId&&![...s.records.companies.flatMap(c=>c.recordings),...s.records.unmatchedRecordings].some(r=>r.id===s.meetingId);
  if(invalidAccount||invalidMeeting){v.notLoading=false;v.isLoading=false;v.bannerShown=true;v.banner={bg:'var(--color-surface)',fg:'var(--color-text)',btnBg:'transparent',title:'Record unavailable',text:'This record is not included in the showcase collection.',action:'Back to '+(invalidAccount?'accounts':'meetings'),go:this.go(invalidAccount?'accounts':'meetings')};return v;}
  v.priorities=d.presentation.priorities.map((p,i)=>({n:String(i+1),title:p.title,why:p.why,next:p.next,caveat:p.caveat,primary:p.primary.label,primaryGo:this._verifiedTarget(p.primary.target),secondary:p.secondary?.label||'',secondaryGo:p.secondary?this._verifiedTarget(p.secondary.target):()=>{}}));
  v.upcoming=d.presentation.upcoming.map(item=>({when:new Date(item.date+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}),title:item.title,prep:item.prep,go:this._verifiedTarget(item.target)}));
  const [start,end]=this._verifiedRange(),inRange=date=>!!date&&date>=start&&date<=end;
  const count=key=>d.leads.filter(r=>inRange(r[key])).length;
  const period=f.date(start)+' – '+f.date(end)+(s.period==='year'?' (tracker starts in April)':'');
  const goLeads=contributor=>this.go('accounts',{accounts:'leads',contributor,search:'',owner:'Everyone'});
  v.demandMetrics.slice(0,3).forEach((m,i)=>{const key=['lead','mql','sql'][i];m.value=f.number(count(key));m.delta=period;m.note=i===0?f.number(d.leads.filter(r=>r.source==='Webinar'&&inRange(r.lead)).length)+' webinar registrants · Lead Tracker':'By '+key.toUpperCase()+' date';m.go=goLeads(key);});
  const meetingRange=f.date(d.report.meetings.start)+' – '+f.date(d.report.meetings.end);
  v.demandMetrics[3].value=f.number(d.report.meetings.completed);v.demandMetrics[4].value=f.number(d.report.meetings.recorded);
  for(const m of v.demandMetrics.slice(3)){m.delta=meetingRange;m.note=m.label==='Recordings'?'Fathom · counted separately':'HubSpot completed outcomes';}
  v.periodRange=period;
  const monthly=s.period==='year'||(Date.parse(end)-Date.parse(start))/86400000>120;
  let at=monthly?start.slice(0,7)+'-01':s.period==='custom'?start:f.add(start,-((new Date(start+'T12:00:00Z').getUTCDay()+6)%7));
  const bars=[];
  while(at<=end){const next=monthly?new Date(Date.UTC(+at.slice(0,4),+at.slice(5,7),1,12)).toISOString().slice(0,10):f.add(at,7);const last=f.add(next,-1);const leads=d.leads.filter(r=>inRange(r.lead)&&r.lead>=at&&r.lead<=last).length;bars.push({date:at,label:monthly?new Date(at+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',timeZone:'UTC'}):f.date(at),leads});at=next;}
  const max=Math.max(1,...bars.map(b=>b.leads));v.weeks=bars.map(b=>({...b,title:(monthly?'':'Week of ')+b.label+': '+b.leads+' new leads',leadH:Math.round(b.leads/max*100)+'%'}));v.barCols=bars.length;v.barsTitle=monthly?'New leads by month':'New leads by week';
  v.channels=[...new Set(d.leads.map(r=>r.source))].map(channel=>{const rows=d.leads.filter(r=>r.source===channel),n=k=>rows.filter(r=>inRange(r[k])).length;const leads=n('lead'),mql=n('mql'),sql=n('sql');return{channel,leads,mql,sql,rate:leads?Math.round(sql/leads*100)+'%':'—'};}).filter(r=>r.leads||r.mql||r.sql).sort((a,b)=>b.leads-a.leads||a.channel.localeCompare(b.channel));
  v.quickNumbers[0].value=f.number(d.quick.leads);v.quickNumbers[1].value=f.number(d.quick.mql);v.quickNumbers[2].value=f.number(d.quick.sql);
  v.quickNumbers[3].value=f.number(d.report.meetings.completed);v.quickNumbers[3].delta='CRM through '+f.date(d.report.meetings.end)+' · '+d.report.meetings.recorded+' recordings separately';
  v.quickNumbers[4].value=d.report.pipeline.weighted.value==null?'—':'$'+(d.report.pipeline.weighted.value/1e6).toFixed(2)+'M';
  const grouped=new Map();for(const stage of d.report.pipeline.stages){const g=grouped.get(stage.stage)||{stage:stage.stage,count:0,amount:0};g.count+=stage.count;g.amount+=stage.amount;grouped.set(g.stage,g);}
  const stageOrder=v.stages.map(g=>g.stage),shortStage=stage=>stage.replace(/ \(Deal\)$/,'');
  const stageMax=Math.max(1,...[...grouped.values()].map(g=>g.amount));v.stages=[...grouped.values()].sort((a,b)=>stageOrder.indexOf(shortStage(a.stage))-stageOrder.indexOf(shortStage(b.stage))).map(g=>({...g,stage:shortStage(g.stage),amount:'$'+f.number(g.amount/1000)+'K',w:Math.round(g.amount/stageMax*100)+'%'}));
  v.scorecard=d.report.pipeline.scorecard.map(r=>({label:r.label,value:f.number(r.value)}));
  v.spendMonths=d.report.spend.months.map(m=>({month:new Date(m.month+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'long',timeZone:'UTC'}),budget:f.number(m.planned),actual:f.number(m.actual),diff:m.actual==null||m.partial?'Not comparable':(m.actual>=m.planned?'+':'−')+f.number(Math.abs(m.actual-m.planned)),tag:m.actual==null?'Not entered':m.partial?'Partly entered':'',tagDisplay:m.actual==null||m.partial?'inline-flex':'none'}));
  const spendMax=Math.max(1,...d.report.spend.channels.map(c=>c.amount));v.spendChannels=d.report.spend.channels.map(c=>({name:c.name,amount:f.number(c.amount),w:Math.round(c.amount/spendMax*100)+'%'}));
  v.ads=d.report.spend.campaigns.filter(c=>c.sent||c.replies||c.bounces||c.linkedinSent).map(c=>({name:c.name+' · email',sent:f.number(c.sent),replies:f.number(c.replies),bounces:f.number(c.bounces),note:'Collected Sep 8. LinkedIn separately: '+f.number(c.linkedinSent)+' sent, '+f.number(c.linkedinReplies)+' replies.'}));
  for(const report of d.report.spend.advertising){const sum=k=>report.rows.reduce((n,r)=>n+(r[k]||0),0);v.ads.push({name:report.name,sent:f.number(sum('impressions')),replies:f.number(sum('conversions')),bounces:'—',note:report.period+' Platform conversions, not qualified leads.'});}
  const web=d.web,webRange=f.date(web.start)+' – '+f.date(web.end);
  v.webMetrics=[{label:'Website visits',value:f.number(web.sessions),note:webRange+' · www.opstream.ai'},{label:'Engaged visits',value:f.percent(web.engaged),note:f.number(web.engagedSessions)+' engaged sessions'},{label:'Page views',value:f.number(web.pageViews),note:'Same period'},{label:'AI answers linking to Opstream',value:f.percent(web.aiCited),note:f.number(web.aiCount)+' completed answers · through '+f.date(web.aiEnd)},{label:'AI answers mentioning Opstream',value:f.percent(web.aiMentioned),note:'Same completed answers'}];
  const webMax=Math.max(1,...web.visits.map(w=>w.value));v.webWeeks=web.visits.map(w=>({label:f.date(w.date),title:'Week of '+f.date(w.date)+': '+f.number(w.value)+' visits',h:Math.round(w.value/webMax*100)+'%'}));
  v.webCols=v.webWeeks.length;
  v.webSources=web.channels.map(c=>({name:c.name,visits:f.number(c.sessions),engaged:f.percent(c.sessions?c.engagedSessions/c.sessions:null),ke:c.keyEvents}));
  v.landing=web.pages.slice(0,10).map(p=>({page:p.name,visits:f.number(p.sessions),engaged:f.number(p.engagedSessions),ke:p.keyEvents}));
  if(s.perf==='web')v.scopeNote='Website: '+webRange+' · www.opstream.ai only. AI: '+f.number(web.aiCount)+' completed monitored answers through '+f.date(web.aiEnd)+'. No period filter applies.';
  if(s.perf==='spend')v.scopeNote='Spend: Jan – Sep 2026, as entered in the workbook. Campaign counts use the Sep 8 collection; advertising dates are shown per source.';
  const query=(s.search||'').trim().toLowerCase(),owner=s.owner||'Everyone';
  const selected=d.opportunities.filter(o=>(owner==='Everyone'||o.owner===owner)&&(!query||[o.name,o.note,o.stage].join(' ').toLowerCase().includes(query)));
  selected.sort((a,b)=>workspaceModel.compare(a,b,s.sort||'weighted'));
  v.deals=selected.map(o=>({company:o.name,owner:o.owner||'—',stage:o.stage,arr:o.amount==null?'—':'$'+f.number(o.amount),prob:f.percent(o.probability),weighted:workspaceModel.weighted(o)==null?'—':'$'+f.number(workspaceModel.weighted(o)),close:workspaceModel.closeLabel(o.close),days:o.days??'—',daysColor:o.days>120?'var(--color-accent-700)':'var(--color-text)',note:o.note,go:()=>{const c=this._verifiedAccount(o.companyId)||this._verifiedAccount(o.name);if(c)this.go('account',{accountId:c.id,timelineAll:false,peopleAll:false})();else this._verifiedOpenRefs(o.refs,'Owner worksheet · '+o.name);}}));
  v.dealsCount=selected.length+' of '+d.opportunities.length+' showcased opportunities';
  const leadRows=d.leads.filter(r=>(owner==='Everyone'||r.owner===owner)&&(!query||[r.name,r.source,r.note].join(' ').toLowerCase().includes(query))&&(s.contributor?inRange(r[s.contributor]):!!r.lead)).sort((a,b)=>workspaceModel.compareLeads(a,b));
  v.leads=leadRows.map(r=>({company:r.name,source:r.source,owner:r.owner||'—',date:f.date(r.lead),note:r.note,mql:f.date(r.mql),sql:f.date(r.sql)}));
  v.leadsEmpty=leadRows.length===0;v.dealsEmpty=selected.length===0;
  v.leadsCount=leadRows.length+' tracker records'+(s.contributor?' · '+s.contributor.toUpperCase()+' date '+period:' with a lead date');
  v.accountTabs.forEach(t=>{const go=t.go;t.go=()=>{this.setState({contributor:null});go();};});
  v.exportLabel=s.accounts==='leads'?'Export '+leadRows.length+' leads':s.accounts==='follow'?'Export follow-ups':'Export '+selected.length+' opportunities';
  if(s.accounts==='leads')v.exportAccounts=()=>this.csv('leads.csv',['Company','Source','Owner','Lead date','Notes','MQL date','SQL date'],leadRows.map(r=>[r.name,r.source,r.owner,r.lead,r.note,r.mql,r.sql]));
  else if(s.accounts==='deals')v.exportAccounts=()=>this.csv('opportunities.csv',['Company','Owner','Stage','ARR','Probability','Weighted ARR','Close','Days in stage','Last note'],selected.map(o=>[o.name,o.owner,o.stage,o.amount,o.probability,workspaceModel.weighted(o),workspaceModel.closeLabel(o.close),o.days,o.note]));
  v.exportSources=()=>this.csv('leads-by-source.csv',['Source','Leads','MQL','SQL','Period'],v.channels.map(r=>[r.channel,r.leads,r.mql,r.sql,period]));
  v.exportSpend=()=>this.csv('spend-2026.csv',['Month','Planned','Recorded','Note'],d.report.spend.months.map(m=>[m.month,m.planned,m.actual,m.partial?'Partly entered':m.actual==null?'Not entered':'']));
  v.movements=v.movements.map(shown=>{const o=d.opportunities.find(o=>o.name===shown.name);return o?{name:o.name,meta:o.owner+' · '+o.stage,change:o.note,go:()=>this._verifiedOpenRefs(o.refs,'Owner worksheet · '+o.name)}:shown;});
  v.checkUpdates=()=>{this.setState({checking:true});return this._loadVerified();};v.checkNote=s.verifiedError||'Verified collection · Sep 8, 2026';
  v.coverageNote=s.records.companies.length+' account pages, including '+s.records.coverage.foldedRelated+' related company records; '+f.number(s.records.coverage.contacts)+' linked contacts, '+f.number(s.records.coverage.notes)+' notes, '+s.records.coverage.fathomTotal+' unique recordings and '+s.records.coverage.transcripts+' complete transcripts. The opportunity list is the supplied showcase selection; the Lead Tracker contains '+d.leads.length+' rows, including rows with qualification dates but no lead date.';
  if(v.sources[0])v.sources[0].gaps='Selected account pages include contacts and full notes. Email counts are shown; email bodies are not part of this showcase.';
  if(v.sources[1]){v.sources[1].count=s.records.coverage.fathomTotal+' recordings';v.sources[1].gaps='Full transcripts for all '+s.records.coverage.transcripts+' showcased recordings.';}
  if(v.sources[5])v.sources[5].gaps=f.number(web.aiCount)+' completed answers used in rates; failed answers excluded. This is the retained collection.';
  if(v.readingRules[4])v.readingRules[4].text='The workspace uses the retained Sep 8 collection. Website reports cover '+webRange+'; AI answer dates run through '+f.date(web.aiEnd)+'. The dated review can cite earlier source observations.';
  if(s.transcriptError&&v.mtg)v.mtg.transcriptNote=s.transcriptError;
  const attachToNew=(action,refs)=>()=>{const before=(this.state.newDrafts||[]).length;action();if((this.state.newDrafts||[]).length>before){const additions=[...this.state.newDrafts];additions[before]={...additions[before],supportRefs:refs,refs:refs.length};this.setState({newDrafts:additions});}};
  const selectedCompany=this._verifiedAccount(s.accountId);
  if(selectedCompany)v.acct.draftGo=attachToNew(v.acct.draftGo,selectedCompany.refs||[]);
  const selectedRecording=[...s.records.companies.flatMap(c=>c.recordings),...s.records.unmatchedRecordings].find(r=>r.id===s.meetingId);
  if(selectedRecording)v.mtg.draftGo=attachToNew(v.mtg.draftGo,selectedRecording.refs||[]);
  if(s.evidence){
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
      v.ev={kicker:'Original collected records',title:'Records behind this draft',meta:'Retained with the draft',rows:items.map(e=>({label:e.title,value:verifiedEvidenceText(e)})),note:items.length?'Exact supporting records.':'No supporting records are attached to this new draft.',ids:(source?.refs||[]).join(' · '),missing:false,hasRows:items.length>0};
    }
    v.proposeCorrection=()=>{const sourceRefs=(refs||[]).filter(ref=>s.verifiedEvidence[ref]);const draft={kind:'Proposed correction',title:'Correction: '+v.ev.title,company:c?.name||'Not linked',text:'Describe the correction to '+v.ev.title+'. Original records remain unchanged.',rationale:v.ev.ids,refs:sourceRefs.length,supportRefs:sourceRefs,version:0,type:'Proposed correction',status:'Draft',recipients:'',saved:false};this.setState({newDrafts:[...s.newDrafts||[],draft],draft:v.saved.length+v.suggested.length,screen:'drafts',evidence:false});};
    v.exportEvidence=()=>this.csv('collected-record.csv',['Field','Value'],v.ev.rows.map(r=>[r.label,r.value]));
  }
  return v;
};

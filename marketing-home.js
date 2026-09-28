/* global Component, workspaceModel, verifiedFormat */
// Hollie's Marketing home: shows, the LinkedIn and event drafts, and section links.
const marketingHomeOriginal={render:Component.prototype.renderVals,mount:Component.prototype.componentDidMount,target:Component.prototype._verifiedTarget};
Component.prototype.componentDidMount=function(){
  marketingHomeOriginal.mount.call(this);
  fetch('data/marketing.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(marketing=>this.setState({marketing})).catch(()=>this.setState({marketing:null}));
  fetch('/api/me/show-calendar',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(j=>this.setState({showCalendar:(j&&j.matches)||{}})).catch(()=>{});
};
const showAnchor=id=>'show-'+String(id||'').replace(/^show:/,'');
Component.prototype._scrollHome=function(id,patch){
  this.setState({screen:'briefing',briefAudience:'marketing',evidence:false,...(patch||{})});
  setTimeout(()=>{const el=document.getElementById(id);if(el)el.scrollIntoView({block:'start'});},0);
};
Component.prototype._verifiedTarget=function(target){
  if(target&&target.kind==='section')return()=>this._scrollHome(target.id);
  if(target&&target.kind==='show')return()=>this._scrollHome(showAnchor(target.id),{highlightShows:[target.id]});
  if(target&&target.kind==='past-shows')return()=>this._scrollHome(showAnchor((target.ids||[])[0]),{pastShowsOpen:true,highlightShows:target.ids||[]});
  if(target&&target.kind==='linkedin')return()=>this._draftLinkedIn(target.id);
  if(target&&target.kind==='event-followup')return()=>this._openShowDrafts(target.id);
  if(target&&target.kind==='show-csv')return()=>this._downloadShowLeads(target.id);
  if(target&&target.kind==='seed')return()=>{const d=(this.state.draftSeeds||[]).find(x=>x.id===target.id);if(d){this.setState({screen:'drafts',draftId:d.id,draftPurpose:d.purpose,draftShow:null,evidence:false,draftFeedback:null});window.scrollTo(0,0);}};
  return marketingHomeOriginal.target.call(this,target);
};
Component.prototype._showSeeds=function(showId){
  return (this.state.draftSeeds||[]).filter(d=>d.showId===showId&&(d.purpose==='event'||d.purpose==='campaign'));
};
Component.prototype._openShowDrafts=function(showId){
  const first=this._showSeeds(showId)[0];
  if(first){this.setState({screen:'drafts',draftId:first.id,draftPurpose:first.purpose,draftShow:showId,evidence:false,draftFeedback:null});window.scrollTo(0,0);}
};
Component.prototype._downloadShowLeads=function(showId){
  const s=(((this.state.marketing||{}).shows||{}).items||[]).find(x=>x.id===showId);
  if(!s)return;
  const rows=(s.leadRows||[]).map(r=>[String(r.contact||'').split(/\s+/)[0]||'',String(r.contact||'').split(/\s+/).slice(1).join(' '),r.email||'',r.company,r.title||'',r.owner||'',r.lead||'',r.mql||'',r.sql||'',r.note||'',r.sheetUrl||'']);
  this.csv('lemlist-'+showAnchor(showId)+'-leads.csv',['firstName','lastName','email','companyName','jobTitle','leadOwner','leadDate','mqlDate','sqlDate','trackerNote','trackerRow'],rows);
};
Component.prototype._draftLinkedIn=async function(showId){
  if(this.state.linkedinBusy)return;
  this.setState({linkedinBusy:showId,linkedinError:null});
  try{
    const r=await fetch('/api/drafts/linkedin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({showId})});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'The post was not drafted.');
    this._newWorkspaceDraft('linkedin',{title:j.title,subject:j.title,text:j.text,company:'No company linked',citations:j.citations||[],contentMode:'marketing',
      rationale:j.usedGoogle?'Drafted from the dashboard and your Gmail, Calendar and Drive. Check each source before you post.':'Drafted from the dashboard only. Sign in with Google to use your mail, calendar and documents.'});
    this.setState({linkedinBusy:null,draftFeedback:'LinkedIn post drafted. Nothing is posted; copy it into LinkedIn yourself.',draftFeedbackClass:'form-success'});
    window.scrollTo(0,0);
  }catch(error){this.setState({linkedinBusy:null,linkedinError:{showId,message:error.message||'The post was not drafted.'}});}
};
const SHOW_HORIZON_DAYS=42;
const showWhen=(s,today)=>{const rel=workspaceModel.relativeStart(s.start,s.end,today);return rel.charAt(0).toUpperCase()+rel.slice(1)+(s.dateLabel&&s.start?' · '+s.dateLabel:'');};
const showHasData=s=>(s.attendees||[]).length>0||(s.recorded||{}).amount!=null||((s.meetingRequests||{}).count>0)||((s.leads||{}).count>0);
const showView=(component,s,today)=>{
  const st=component.state,mk=workspaceModel.moneyK.bind(workspaceModel);
  const leads=s.leads||{},req=s.meetingRequests||{};
  const past=!!s.end&&s.end<today;
  const figures=[
    {label:'Planned',value:mk(s.planned),note:s.planned==null?'No package price on the show calendar':'Package price'},
    {label:'Recorded',value:mk((s.recorded||{}).amount),note:((s.recorded||{}).rows||[]).length?s.recorded.rows.map(r=>r.vendor).join(', '):'No Actuals row names this show'},
  ];
  if(past||leads.count)figures.push({label:'Leads from the show',value:verifiedFormat.number(leads.count),note:leads.count?'MQL '+leads.mql+' · SQL '+leads.sql:'No Lead Tracker rows tie to this show'});
  if(req.count)figures.push({label:'Asked to meet',value:verifiedFormat.number(req.count),note:req.mql+' booked · '+(req.companies||[]).slice(0,3).join(', ')});
  const check=stage=>(s.checklist||[]).filter(c=>c.stage===stage).map(c=>({label:c.label,detail:c.detail,mark:c.done?'✓':'○',state:c.done?'Done':'Open'}));
  const busy=st.linkedinBusy===s.id,err=st.linkedinError&&st.linkedinError.showId===s.id?st.linkedinError.message:'';
  const onCal=((st.showCalendar||{})[s.id]||[]);
  const seeds=component._showSeeds(s.id);
  const hasData=showHasData(s);
  const stale=past&&workspaceModel.relativeDays(s.end,today)>14;
  const withEmail=(s.leadRows||[]).filter(r=>r.email).length;
  return {
    id:s.id,name:s.name,anchor:showAnchor(s.id),highlight:(st.highlightShows||[]).includes(s.id),
    sheetUrl:(s.sheetRow||{}).url||'',sheetLabel:(s.sheetRow||{}).label||'',sheetCta:(s.attendees||[]).length?'Show calendar row':'Add booth staff on the show calendar',
    showLinkedin:!stale,linkedinClass:seeds.length?'btn-secondary':'btn-primary',
    hasLeadCsv:(s.leadRows||[]).length>0,leadCsvLabel:'Download '+(s.leadRows||[]).length+' leads for LemList (CSV'+(withEmail<(s.leadRows||[]).length?', '+withEmail+' with email':'')+')',leadCsvGo:()=>component._downloadShowLeads(s.id),when:showWhen(s,today),meta:[s.location,s.status,s.package].filter(Boolean).join(' · '),
    attendees:(s.attendees||[]).length?'Opstream: '+s.attendees.join(', '):'Opstream attendees are not listed on the show calendar.',
    campaign:(s.campaigns||[]).length?'LemList campaign “'+s.campaigns[0].name+'” · '+s.campaigns[0].status+campaignStatsText(st.marketing,s.campaigns[0].name):'',hasCampaign:(s.campaigns||[]).length>0,
    onCalendar:onCal.map(e=>'On your calendar: '+e.title+' ('+workspaceModel.formatShort(e.start)+')').join(' · '),hasOnCalendar:onCal.length>0,
    figures,hasData,noDataLine:'No spend or attendees recorded yet.'+(s.planned!=null?' Planned: '+mk(s.planned)+'.':''),
    prep:check('prep'),followUp:check('follow-up'),hasFollowUp:check('follow-up').length>0,
    linkedinLabel:busy?'Drafting…':'Draft LinkedIn post',linkedinGo:()=>component._draftLinkedIn(s.id),linkedinDisabled:!!busy,
    hasFollowDrafts:seeds.length>0,followDraftsLabel:past?'Open the follow-up for '+verifiedFormat.number(leads.count||0)+' leads':'Open meeting request drafts ('+seeds.length+')',followDraftsGo:()=>component._openShowDrafts(s.id),
    linkedinError:err,hasLinkedinError:!!err,
    line:[showWhen(s,today),s.location,s.status].filter(Boolean).join(' · '),
    pastLine:[s.dateLabel,'planned '+mk(s.planned),'recorded '+mk((s.recorded||{}).amount),verifiedFormat.number(leads.count||0)+' leads','MQL '+(leads.mql||0)].join(' · '),
  };
};
const campaignStatsText=(marketing,name)=>{
  const out=(marketing&&marketing.outbound)||{};
  const row=(out.campaignStats||[]).find(c=>c.name===name);
  if(row)return ' · '+[row.sent!=null?verifiedFormat.number(row.sent)+' sent':'',row.opened!=null?verifiedFormat.number(row.opened)+' opened':'',row.replied!=null?verifiedFormat.number(row.replied)+' replied':''].filter(Boolean).join(' · ');
  if(out.statsBlocked)return ' · LemList stats not available on this API key';
  return out.connected?' · no stats for this campaign':' · sent and reply counts not collected yet';
};
const numberWord=n=>['No','One','Two','Three','Four','Five','Six'][n]||String(n);
Component.prototype.renderVals=function(){
  const v=marketingHomeOriginal.render.call(this),st=this.state,m=st.marketing||null,session=st.googleSession||{};
  const today=workspaceModel.phoenixToday();
  const first=String(session.name||'').trim().split(/\s+/)[0];
  v.homeWeek=new Date(today+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',timeZone:'UTC'});
  v.homeIntro=workspaceModel.greeting()+(first?', '+first:'')+'. These are the things worth your time, drawn from the Lead Tracker, the budget workbook and its show calendar, LemList and the CRM. Each one says where it comes from. Drafts stay here until you act on them.';
  v.salesIntro='The deals, follow-ups and meetings that need the sales and customer-success team. Drafts stay here until someone acts on them.';
  const shows=(m&&m.shows)||{};
  const items=shows.items||[];
  const horizon=workspaceModel.addDays(today,SHOW_HORIZON_DAYS);
  const ahead=items.filter(s=>!(s.end&&s.end<today));
  const featured=ahead.filter(s=>s.approved&&s.start&&s.start<=horizon);
  v.showsConnected=!!shows.connected;v.showsNotConnected=!shows.connected;
  v.showsNotConnectedNote=m?(shows.reason||'The show calendar is not connected yet.')+' It comes from the budget workbook’s “Final Annual Show calendar” tab.':'Loading the show calendar…';
  v.showsSourceNote=shows.connected?'Show calendar and Actuals · budget workbook · collected '+verifiedFormat.date(m.asOf):'';
  v.showsAhead=featured.map(s=>showView(this,s,today));
  v.showsAlso=ahead.filter(s=>!featured.includes(s)).map(s=>({name:s.name,line:[s.start?showWhen(s,today):'Date not set',s.location,s.approved?'':s.status||'Not approved'].filter(Boolean).join(' · ')}));
  v.showsPast=items.filter(s=>s.end&&s.end<today).map(s=>showView(this,s,today));
  v.hasShowsAhead=v.showsAhead.length>0;v.hasShowsAlso=v.showsAlso.length>0;v.hasShowsPast=v.showsPast.length>0;
  v.showsPastLabel='Past shows ('+v.showsPast.length+')';
  v.showsEmptyNote='No signed shows in the next six weeks.';
  const looseBy=new Map();
  for(const u of shows.unattributed||[]){const prev=looseBy.get(u.vendor)||{vendor:u.vendor,amount:0,n:0};prev.amount+=u.amount||0;prev.n++;looseBy.set(u.vendor,prev);}
  const loose=[...looseBy.values()];
  v.hasUnattributed=loose.length>0;
  v.unattributedNote=loose.length?'Event payments not given to any one show ('+loose.map(u=>u.vendor+' '+workspaceModel.moneyK(u.amount)+(u.n>1?' ('+u.n+' payments)':'')).join(', ')+') are counted in event spend on Pipeline › Spend.':'';
  const spend=(m&&m.spend)||{};
  v.homeReading=[
    workspaceModel.missingSpendText(spend),
    'Leads, MQLs and SQLs come from the Lead Tracker. A lead counts on its first stage date, an MQL on its MQL date and an SQL on its SQL date.',
    'Show dates, packages and attendees are what the show calendar says. Meeting requests are Lead Tracker notes.',
  ];
  v.homeComingUp=featured.slice(0,4).map(s=>({when:showWhen(s,today),title:s.name,note:[s.location,s.planned!=null?workspaceModel.moneyK(s.planned)+' planned':''].filter(Boolean).join(' · '),go:this._verifiedTarget({kind:'show',id:s.id})}));
  v.pastShowsOpen=!!st.pastShowsOpen;v.togglePastShows=e=>{if(e&&e.preventDefault)e.preventDefault();this.setState({pastShowsOpen:!this.state.pastShowsOpen,highlightShows:[]});};
  v.hasHomeComingUp=v.homeComingUp.length>0;
  v.goEventsShows=this._verifiedTarget({kind:'section',id:'events-shows'});
  const outbound=(m&&m.outbound)||{};
  v.outboundHomeNote=outbound.connected?'':(outbound.reason||'');
  v.hasOutboundHomeNote=!!v.outboundHomeNote;
  for(const p of [...(v.priorities||[]),...(v.lessPriorities||[])]){
    p.leadOwnersLine=(p.leadOwners||[]).map(o=>workspaceModel.displayOwner(o)).filter((o,i,a)=>a.indexOf(o)===i).join(', ');
    p.hasLeadOwners=!!p.leadOwnersLine;
    if(p.kind==='shows'&&(p.shows||[]).length){
      const parts=p.shows.map(s=>s.name+' ('+workspaceModel.relativeStart(s.start,s.end,today).replace(/^starts /,'')+')');
      const soon=p.shows.every(s=>s.start&&-workspaceModel.relativeDays(s.start,today)<7);
      const lead=p.shows.length===1?'':numberWord(p.shows.length)+' shows '+(soon?'start this coming week':'are coming up')+': ';
      p.title=p.shows.length===1?p.shows[0].name+' '+workspaceModel.relativeStart(p.shows[0].start,p.shows[0].end,today):lead+parts.slice(0,-1).join(', ')+' and '+parts.slice(-1);
    }
  }
  return v;
};

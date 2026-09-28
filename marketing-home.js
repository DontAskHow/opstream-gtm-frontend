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
  this.setState({screen:'briefing',briefAudience:'marketing',evidence:false,...(patch||{})},()=>requestAnimationFrame(()=>{const el=document.getElementById(id);if(el)el.scrollIntoView({block:'start'});}));
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
  // LemList gets each person once and never a hot or dead lead; those go to their owner.
  const seen=new Set();
  const rows=(s.leadRows||[]).filter(r=>r.email&&!(r.flags||{}).hot&&!(r.flags||{}).dead).filter(r=>{const k=String(r.email).toLowerCase();if(seen.has(k))return false;seen.add(k);return true;}).map(r=>[String(r.contact||'').split(/\s+/)[0]||'',String(r.contact||'').split(/\s+/).slice(1).join(' '),r.email||'',r.company,r.title||'',r.owner||'',r.lead||'',r.mql||'',r.sql||'',r.note||'',r.sheetUrl||'']);
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
  const st=component.state,session=st.googleSession||{},mk=workspaceModel.moneyK.bind(workspaceModel);
  const leads=s.leads||{},req=s.meetingRequests||{};
  const past=!!s.end&&s.end<today;
  const figures=[
    {label:'Planned',value:mk(s.planned),note:s.planned==null?'No package price on the show calendar':'Package price'},
    {label:'Recorded',value:mk((s.recorded||{}).amount),note:((s.recorded||{}).rows||[]).length?s.recorded.rows.map(r=>r.vendor).join(', '):'No Actuals row names this show'},
  ];
  if(past||leads.count)figures.push({label:'Leads from the show',value:verifiedFormat.number(leads.count),note:leads.count?'MQL '+leads.mql+' · SQL '+leads.sql:'No Lead Tracker rows tie to this show'});
  if(req.count){const open=(s.requestRows||[]).filter(r=>!r.mql).map(r=>r.company),booked=(s.requestRows||[]).filter(r=>r.mql).map(r=>r.company);figures.push({label:'Asked to meet',value:verifiedFormat.number(req.count),note:(open.length?'No MQL date yet: '+open.join(', '):'All have an MQL date')+(booked.length?' · Has an MQL date: '+booked.join(', '):'')});}
  const check=stage=>(s.checklist||[]).filter(c=>c.stage===stage).map(c=>({label:c.label,detail:c.detail,mark:c.done?'✓':'○',state:c.done?'Done':'Open'}));
  const busy=st.linkedinBusy===s.id,err=st.linkedinError&&st.linkedinError.showId===s.id?st.linkedinError.message:'';
  const onCal=((st.showCalendar||{})[s.id]||[]);
  const seeds=component._showSeeds(s.id);
  const hasData=showHasData(s);
  const stale=past&&workspaceModel.relativeDays(s.end,today)>14;
  const campaignRows=(s.leadRows||[]).filter(r=>!(r.flags||{}).hot&&!(r.flags||{}).dead);
  const withEmail=new Set(campaignRows.map(r=>String(r.email||'').toLowerCase()).filter(Boolean)).size;
  const hotRows=(s.leadRows||[]).filter(r=>(r.flags||{}).hot);
  return {
    id:s.id,name:s.name,anchor:showAnchor(s.id),highlight:(st.highlightShows||[]).includes(s.id),
    sheetUrl:(s.sheetRow||{}).url||'',sheetLabel:(s.sheetRow||{}).label||'',sheetCta:(s.attendees||[]).length?'Show calendar row':'Add booth staff on the show calendar',
    showLinkedin:!stale,linkedinClass:seeds.length?'btn-secondary':'btn-primary',
    hasLeadCsv:campaignRows.length>0,leadCsvLabel:'Download '+((s.people||{}).withEmail??withEmail)+' contacts for LemList (CSV)'+((s.people||{}).held?' · '+s.people.held+' held back ('+(s.people.heldHot===s.people.held?'hot lead':'hot or dead lead')+')':''),leadCsvGo:()=>component._downloadShowLeads(s.id),
    hotLine:hotRows.length?'Hot: '+hotRows.map(r=>r.company+' ('+(r.owner||'no owner')+')').join(', ')+'. Hand to the owner, not LemList.':'',when:showWhen(s,today),meta:[s.location,s.status,s.package].filter(Boolean).join(' · '),
    attendees:(s.attendees||[]).length?'Opstream: '+s.attendees.join(', '):'Opstream attendees are not listed on the show calendar.',
    ...campaignReplies(st.marketing,(s.campaigns||[])[0]),
    repliesNote:req.count?'LemList replies are not on the Lead Tracker; the '+req.count+' meeting request'+(req.count===1?'':'s')+' above '+(req.count===1?'is':'are')+' from the tracker.':'No meeting requests are logged in the Lead Tracker for this show yet.',
    campaign:(s.campaigns||[]).length?'LemList campaign “'+s.campaigns[0].name+'” · '+s.campaigns[0].status+campaignStatsText(st.marketing,s.campaigns[0].name):'',hasCampaign:(s.campaigns||[]).length>0,
    onCalendar:onCal.map(e=>'On your calendar: '+e.title+' ('+workspaceModel.formatShort(e.start)+')').join(' · '),hasOnCalendar:onCal.length>0,
    calendarHint:!session.signedIn&&(req.count>0)?'Sign in with Google to match these meetings against your calendar.':'',
    figures,hasData,noDataLine:'No spend or attendees recorded yet.'+(s.planned!=null?' Planned: '+mk(s.planned)+'.':''),
    prep:check('prep'),followUp:check('follow-up'),hasFollowUp:check('follow-up').length>0,
    linkedinLabel:busy?'Drafting…':'Draft LinkedIn post',linkedinGo:()=>component._draftLinkedIn(s.id),linkedinDisabled:!!busy,
    hasFollowDrafts:seeds.length>0,followDraftsLabel:past?'Open the follow-up for '+verifiedFormat.number(leads.count||0)+' leads':'Open meeting request drafts ('+seeds.length+')',followDraftsGo:()=>component._openShowDrafts(s.id),
    linkedinError:err,hasLinkedinError:!!err,
    line:[showWhen(s,today),s.location,s.status].filter(Boolean).join(' · '),
    pastLine:[s.dateLabel,'planned '+mk(s.planned),'recorded '+mk((s.recorded||{}).amount),verifiedFormat.number(leads.count||0)+' leads','MQL '+(leads.mql||0)].join(' · '),
  };
};
const campaignReplies=(marketing,campaign)=>{
  const row=campaign&&(((marketing&&marketing.outbound)||{}).campaignStats||[]).find(c=>c.name===campaign.name);
  const n=row&&row.replied||0;
  return {hasReplies:n>0,repliesLabel:n?'Review the '+verifiedFormat.number(n)+' replies to “'+campaign.name+'” in LemList':'',repliesUrl:'https://app.lemlist.com'};
};
const campaignStatsText=(marketing,name)=>{
  const out=(marketing&&marketing.outbound)||{};
  const row=(out.campaignStats||[]).find(c=>c.name===name);
  // LemList reports 0 opens when open tracking is off; that is not zero opens.
  if(row)return ' · '+[row.sent!=null?verifiedFormat.number(row.sent)+' sent':'',row.opened?verifiedFormat.number(row.opened)+' opened':row.sent?'opens not tracked':'',row.replied!=null?verifiedFormat.number(row.replied)+' replied':''].filter(Boolean).join(' · ');
  if(out.statsBlocked)return ' · LemList stats not available on this API key';
  return out.connected?' · no stats for this campaign':' · sent and reply counts not collected yet';
};
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
  for(const u of (shows.eventRoi&&shows.eventRoi.unmatched)||shows.unattributed||[]){const prev=looseBy.get(u.vendor)||{vendor:u.vendor,amount:0,n:0};prev.amount+=u.amount||0;prev.n++;looseBy.set(u.vendor,prev);}
  const loose=[...looseBy.values()];
  v.hasUnattributed=loose.length>0;
  v.unattributedNote=loose.length?'Event payments not given to any one show ('+loose.map(u=>u.vendor+' '+workspaceModel.moneyK(u.amount)+(u.n>1?' ('+u.n+' payments)':'')).join(', ')+') are counted in event spend on Pipeline › Spend.':'';
  const spend=(m&&m.spend)||{};
  v.homeReading=[
    workspaceModel.missingSpendText(spend),
    'Leads, MQLs and SQLs come from the Lead Tracker. A lead counts on its first stage date, an MQL on its MQL date and an SQL on its SQL date.',
    'Show dates, packages and attendees are what the show calendar says. Meeting requests are Lead Tracker notes.',
  ];
  v.pastShowsOpen=!!st.pastShowsOpen;v.togglePastShows=e=>{if(e&&e.preventDefault)e.preventDefault();this.setState({pastShowsOpen:!this.state.pastShowsOpen,highlightShows:[]});};
  // The numbers block at the top of Marketing Today, and its one-page print view.
  if(st.verified&&st.records){
    const opps=workspaceModel.dealsWithSheet(workspaceModel.annotateOpportunities(st.verified.opportunities,st.records),st.sheetReview);
    const rows=workspaceModel.trackerRows(st.sheetReview,st.verified.leads);
    const k=workspaceModel.kpiSummary({opportunities:opps,records:st.records,trackerRows:rows,marketing:m||{},sheetReview:st.sheetReview,today:workspaceModel.asOf(st.records.generatedAt)});
    const usd=n=>'$'+Math.round(Number(n)||0).toLocaleString('en-US'),num=n=>verifiedFormat.number(n);
    const wow=c=>c.delta===0?'same as the week before ('+num(c.before)+')':(c.delta>0?'up ':'down ')+num(Math.abs(c.delta))+' on the week before ('+num(c.before)+')';
    v.kpiAsOf='Collected '+(v.collectedShort||'')+'. Quarter to date is '+workspaceModel.formatDate(k.quarter.start)+' – '+workspaceModel.formatDate(k.quarter.end)+'.';
    v.kpiCards=[
      {id:'pipeline',label:'Open pipeline',value:usd(k.book.amount),note:num(k.book.count)+' deals on the master Sheet'},
      {id:'weighted',label:'Weighted pipeline',value:k.book.weighted==null?'—':usd(k.book.weighted),note:'Amount × the Sheet probability'},
      {id:'commit',label:'Commit closing this month',value:usd(k.commit.amount),note:(k.commit.deals.join(', ')||'No commit deal closes this month')+' · target '+(k.commit.target==null?'not set':usd(k.commit.target))+' (Forecast tab)'},
      {id:'leads',label:'Leads this quarter',value:num(k.leads.quarter.leads),note:'Last 7 days: '+num(k.leads.week.leads.now)+', '+wow(k.leads.week.leads)+' · target not set'},
      {id:'mql',label:'MQLs this quarter',value:num(k.leads.quarter.mql),note:'Last 7 days: '+num(k.leads.week.mql.now)+', '+wow(k.leads.week.mql)+' · target not set'},
      {id:'sql',label:'SQLs this quarter',value:num(k.leads.quarter.sql),note:'Last 7 days: '+num(k.leads.week.sql.now)+', '+wow(k.leads.week.sql)+' · target not set'},
      {id:'sourced',label:'Marketing-sourced pipeline',value:usd(k.sourced.amount),note:num(k.sourced.count)+' open deal'+(k.sourced.count===1?'':'s')+' whose company is on the Lead Tracker'},
      {id:'won',label:'Won this quarter',value:usd(k.won.amount),note:num(k.won.count)+' won ('+(k.won.rows.map(r=>r.company).join(', ')||'none')+') · '+num(k.lost.count)+' lost ('+usd(k.lost.amount)+')'},
      (()=>{const stats=((m&&m.outbound)||{}).campaignStats||[];const replies=stats.reduce((a,c)=>a+(c.replied||0),0);return {id:'replies',label:'LemList replies',value:stats.length?num(replies):'Not collected',note:(stats.length?'Across '+num(stats.filter(c=>c.sent).length)+' campaigns with sends. ':'LemList stats are not in this collection. ')+'Meetings from replies are not tracked: LemList does not record them and the Lead Tracker has no reply column.'};})(),
      {id:'spend',label:'Spend against plan',value:k.spend.connected?(k.spend.text.match(/\$[\d.]+[KM]? recorded/)||[''])[0].replace(' recorded',''):'—',note:k.spend.connected?k.spend.text:'The budget workbook is not in this collection.'},
    ];
    v.kpiOwners=k.byOwner.map(r=>({owner:r.owner,deals:num(r.deals),amount:usd(r.amount),weighted:usd(r.weighted),meetings:num(r.meetings),mql:num(r.mql),sql:num(r.sql)}));
    v.kpiSourced=k.sourced.rows.sort((a,b)=>(b.amount||0)-(a.amount||0)).map(r=>({company:r.company,amount:usd(r.amount),source:r.source,leadDate:workspaceModel.formatDate(r.leadDate)}));
    v.hasKpiSourced=v.kpiSourced.length>0;
    v.kpiEvents=k.events.map(r=>({name:r.name,planned:r.planned==null?'—':usd(r.planned),paid:r.paid==null?'Not recorded':usd(r.paid),how:r.how||'No payment matches this show',leads:num(r.leads),mql:num(r.mql),cpl:r.costPerLead?usd(r.costPerLead):'—'}));
    v.hasKpiEvents=v.kpiEvents.length>0;
    v.spendMonthNotes=((m&&m.spend&&m.spend.monthNotes)||[]).map(n=>new Date(n.month+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'long',timeZone:'UTC'})+' ran '+workspaceModel.moneyK(n.over)+' over plan. Its largest payments: '+n.largest.map(x=>x.vendor+' '+workspaceModel.moneyK(x.amount)).join(', ')+'.');
    v.hasSpendMonthNotes=v.spendMonthNotes.length>0;
    v.kpiTotals=k;
    v.printSummary=()=>window.print();
  }
  const outbound=(m&&m.outbound)||{};
  v.outboundHomeNote=outbound.connected?'':(outbound.reason||'');
  v.hasOutboundHomeNote=!!v.outboundHomeNote;
  for(const p of [...(v.priorities||[]),...(v.lessPriorities||[])]){
    p.leadOwnersLine=(p.leadOwners||[]).map(o=>workspaceModel.displayOwner(o)).filter((o,i,a)=>a.indexOf(o)===i).join(', ');
    p.hasLeadOwners=!!p.leadOwnersLine;
    if(p.kind==='shows'&&(p.shows||[]).length){
      // Each show says where it is: on now, starts <day>, or ended.
      const weekday=d=>new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'short',timeZone:'UTC'});
      const when=sh=>{const r=workspaceModel.relativeStart(sh.start,sh.end,today);return /^starts in \d+ days$/.test(r)?'starts '+weekday(sh.start):r.replace(/^on now, through .*/,'is on now');};
      const parts=p.shows.map(sh=>sh.name+' '+when(sh));
      p.title=parts.length===1?parts[0]:parts.slice(0,-1).join('; ')+'; '+parts[parts.length-1];
      p.title=p.title.charAt(0).toUpperCase()+p.title.slice(1);
    }
  }
  return v;
};

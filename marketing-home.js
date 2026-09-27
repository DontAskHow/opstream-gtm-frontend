/* global Component, workspaceModel, verifiedFormat */
// Hollie's Marketing home: shows, the LinkedIn draft action, and section links.
const marketingHomeOriginal={render:Component.prototype.renderVals,mount:Component.prototype.componentDidMount,target:Component.prototype._verifiedTarget};
Component.prototype.componentDidMount=function(){
  marketingHomeOriginal.mount.call(this);
  fetch('data/marketing.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(marketing=>this.setState({marketing})).catch(()=>this.setState({marketing:null}));
};
Component.prototype._verifiedTarget=function(target){
  if(target&&target.kind==='section')return()=>{this.setState({screen:'briefing',briefAudience:'marketing',evidence:false});setTimeout(()=>{const el=document.getElementById(target.id);if(el)el.scrollIntoView({block:'start'});},0);};
  if(target&&target.kind==='linkedin')return()=>this._draftLinkedIn(target.id);
  return marketingHomeOriginal.target.call(this,target);
};
Component.prototype._draftLinkedIn=async function(showId){
  if(this.state.linkedinBusy)return;
  this.setState({linkedinBusy:showId,linkedinError:null});
  try{
    const r=await fetch('/api/drafts/linkedin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({showId})});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'The post was not drafted.');
    this._newWorkspaceDraft('linkedin',{title:j.title,subject:j.title,text:j.text,company:'No company linked',citations:j.citations||[],
      rationale:j.usedGoogle?'Drafted from the dashboard and your Gmail, Calendar and Drive. Check each source before you post.':'Drafted from the dashboard only. Sign in with Google to use your mail, calendar and documents.'});
    this.setState({linkedinBusy:null,draftFeedback:'LinkedIn post drafted. Nothing is posted; copy it into LinkedIn yourself.',draftFeedbackClass:'form-success'});
    window.scrollTo(0,0);
  }catch(error){this.setState({linkedinBusy:null,linkedinError:{showId,message:error.message||'The post was not drafted.'}});}
};
const plainNumber=n=>n==null?'—':Math.round(n).toLocaleString('en-US');
const showView=(component,s,past)=>{
  const st=component.state;
  const leads=s.leads||{},req=s.meetingRequests||{};
  const figures=[
    {label:'Planned',value:plainNumber(s.planned),note:s.planned==null?'No package price on the show calendar':'Package price'},
    {label:'Recorded',value:plainNumber((s.recorded||{}).amount),note:(s.recorded||{}).rows&&s.recorded.rows.length?s.recorded.rows.map(r=>r.vendor).join(', '):'No Actuals row names this show'},
  ];
  if(past||leads.count)figures.push({label:'Leads from the show',value:plainNumber(leads.count),note:leads.count?'MQL '+leads.mql+' · SQL '+leads.sql:'No Lead Tracker rows tie to this show'});
  if(req.count)figures.push({label:'Asked to meet',value:plainNumber(req.count),note:req.mql+' booked · '+(req.companies||[]).slice(0,3).join(', ')});
  const check=stage=>(s.checklist||[]).filter(c=>c.stage===stage).map(c=>({label:c.label,detail:c.detail,mark:c.done?'✓':'○',state:c.done?'Done':'Open'}));
  const busy=st.linkedinBusy===s.id,err=st.linkedinError&&st.linkedinError.showId===s.id?st.linkedinError.message:'';
  const meta=[s.location,s.status,s.package].filter(Boolean).join(' · ');
  return {
    id:s.id,name:s.name,when:s.dateLabel,meta,
    phaseLabel:{'this-week':'This week',upcoming:'Coming up',undated:'Date not set',past:'Past'}[s.phase]||'',
    attendees:(s.attendees||[]).length?'Opstream: '+s.attendees.join(', '):'Opstream attendees are not listed on the show calendar yet.',
    campaign:(s.campaigns||[]).length?'LemList campaign “'+s.campaigns[0].name+'” · '+s.campaigns[0].status:'',
    hasCampaign:(s.campaigns||[]).length>0,
    figures,prep:check('prep'),followUp:check('follow-up'),hasFollowUp:check('follow-up').length>0,
    linkedinLabel:busy?'Drafting…':'Draft LinkedIn post',linkedinGo:()=>component._draftLinkedIn(s.id),linkedinDisabled:!!busy,
    linkedinError:err,hasLinkedinError:!!err,
    pastLine:[s.dateLabel,'planned '+plainNumber(s.planned),'recorded '+plainNumber((s.recorded||{}).amount),plainNumber(leads.count)+' leads','MQL '+(leads.mql||0)].join(' · '),
  };
};
Component.prototype.renderVals=function(){
  const v=marketingHomeOriginal.render.call(this),st=this.state,m=st.marketing||null,session=st.googleSession||{};
  const today=workspaceModel.asOf(st.records&&st.records.generatedAt);
  const weekStart=workspaceModel.addDays(today,-((new Date(today+'T12:00:00Z').getUTCDay()+6)%7));
  const first=String(session.name||'').trim().split(/\s+/)[0];
  v.homeWeek='Week of '+new Date(weekStart+'T12:00:00Z').toLocaleDateString('en-US',{month:'long',day:'numeric',timeZone:'UTC'});
  v.homeIntro=workspaceModel.greeting()+(first?', '+first:'')+'. These are the things worth your time this week, drawn from the Lead Tracker, the budget workbook and its show calendar, LemList and the CRM. Each one says where it comes from. Drafts stay here until you act on them.';
  v.salesIntro='The deals, follow-ups and meetings that need the sales and customer-success team. Drafts stay here until someone acts on them.';
  const shows=(m&&m.shows)||{};
  const items=shows.items||[];
  v.showsConnected=!!shows.connected;
  v.showsNotConnected=!shows.connected;
  v.showsNotConnectedNote=m?(shows.reason||'The show calendar is not connected yet.')+' It comes from the budget workbook’s “Final Annual Show calendar” tab.':'Loading the show calendar…';
  v.showsSourceNote=shows.connected?'Show calendar and Actuals · budget workbook · collected '+verifiedFormat.date(m.asOf):'';
  v.showsAhead=items.filter(s=>s.phase!=='past').map(s=>showView(this,s,false));
  v.showsPast=items.filter(s=>s.phase==='past').map(s=>showView(this,s,true));
  v.hasShowsAhead=v.showsAhead.length>0;v.hasShowsPast=v.showsPast.length>0;
  v.showsPastLabel='Past shows ('+v.showsPast.length+')';
  const loose=shows.unattributed||[];
  v.hasUnattributed=loose.length>0;
  v.unattributedNote=loose.length?'Event payments in Actuals that do not name a show: '+loose.map(u=>u.vendor+' '+plainNumber(u.amount)).join(', ')+'. They are counted in event spend but not given to any one show.':'';
  const spend=(m&&m.spend)||{};
  const missing=(spend.missingMonths||[]).map(k=>new Date(k+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'long',timeZone:'UTC'}));
  v.homeReading=[
    missing.length?missing.join(' and ')+' spend '+(missing.length===1?'has':'have')+' not been entered, so '+(missing.length===1?'it is':'they are')+' missing, not zero.':'Blank budget months are missing, not zero.',
    'Leads, MQLs and SQLs come from the Lead Tracker, using its own definitions for each source.',
    'Show dates, packages and attendees are what the show calendar says. Meeting requests are Lead Tracker notes.',
  ];
  const upcoming=items.filter(s=>s.phase==='this-week'||s.phase==='upcoming').slice(0,3).map(s=>({when:s.dateLabel,title:s.name,note:[s.location,s.planned!=null?plainNumber(s.planned)+' planned':''].filter(Boolean).join(' · '),go:()=>this._verifiedTarget({kind:'section',id:'events-shows'})()}));
  v.homeComingUp=upcoming;v.hasHomeComingUp=upcoming.length>0;
  v.goEventsShows=this._verifiedTarget({kind:'section',id:'events-shows'});
  return v;
};

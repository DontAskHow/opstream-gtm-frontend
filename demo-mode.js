// Public preview adapter: browser-local persistence and no provider effects.
let demoState;
Component.prototype._workspaceApi=async function(path,body){
 if(!demoState){const seed=await fetch('/data/bootstrap.json').then(r=>r.json());try{demoState=JSON.parse(localStorage.getItem('gtm-public-demo-v1'))||seed;}catch{demoState=seed;}}
 const save=()=>localStorage.setItem('gtm-public-demo-v1',JSON.stringify(demoState));
 if(path==='/bootstrap')return structuredClone(demoState);
 if(path==='/comments')return {comments:structuredClone(demoState.comments)};
 if(path==='/preferences'){demoState.preferences=body.preferences;demoState.preferencesRevision++;save();return {revision:demoState.preferencesRevision};}
 if(path.startsWith('/priorities/')&&path.endsWith('/comments')){const now=new Date().toISOString(),id=body.id||crypto.randomUUID(),prior=demoState.comments.find(c=>c.id===id);const comment={...body,id,priorityId:decodeURIComponent(path.split('/')[2]),authorName:'You',mine:true,createdAt:prior?.createdAt||now,updatedAt:now,revision:(prior?.revision||0)+1,notifications:[]};demoState.comments=[...demoState.comments.filter(c=>c.id!==id),comment];save();return {comments:structuredClone(demoState.comments),comment};}
 if(path.startsWith('/drafts/')&&!path.endsWith('/send')){const id=decodeURIComponent(path.split('/')[2]),prior=demoState.drafts.find(d=>d.id===id);if(path.endsWith('/history'))return {history:prior?.history||[]};if(!body)return {draft:structuredClone(prior)};const draft={...body.draft,version:(prior?.version||0)+1,updatedAt:new Date().toISOString(),history:[...(prior?.history||[]),...(prior?[prior]:[])]};demoState.drafts=[...demoState.drafts.filter(d=>d.id!==id),draft];save();return {draft:structuredClone(draft)};}
 throw Error('Sending is disabled \u2014 drafts stay in this browser.');
};
const demoRender=Component.prototype.renderVals;
Component.prototype.renderVals=function(){
 const v=demoRender.call(this);
 const s=this.state.googleSession||{};
 const brief=this.state.personalBrief||null;
 v.signedIn=!!s.signedIn;
 v.signedInLabel=s.name||s.email||'';
 v.signedInEmail=s.email||'';
 v.signedInInitials=s.initials||'';
 v.scopeSummary=s.scopeSummary||'';
 v.googleExpired=!!s.expired;
 v.profileOpen=!!this.state.profileOpen;
 v.toggleProfile=()=>this.setState({profileOpen:!this.state.profileOpen});
 v.personalBriefPending=!!s.signedIn&&!s.expired&&!brief;
 v.personalMeetings=(brief&&brief.meetings)||[];
 v.personalFollowUps=(brief&&brief.followUps)||[];
 v.personalNotOnSheet=(brief&&brief.notOnSheet)||[];
 v.personalDrafts=(brief&&brief.drafts)||[];
 if(!s.signedIn){
  v.googleConnectionLabel='Email sending is disabled in this public workspace. Drafts stay in your browser and nothing is sent.';
  v.googleConnectLabel='Sending unavailable';
  v.googleConnectionDisabled=true;
 }else if(s.expired){
  v.googleConnectionLabel='Google access expired, reconnect';
  v.googleConnectLabel='Reconnect';
  v.googleConnectionDisabled=false;
  v.connectGoogle=()=>{window.location.href='/api/google/sign-in';};
 }else{
  v.googleConnectionLabel='Connected as '+(s.email||s.name)+'. Read-only. Nothing is sent.';
  v.googleConnectLabel='Reconnect';
  v.googleConnectionDisabled=false;
  v.connectGoogle=()=>{window.location.href='/api/google/sign-in';};
 }
 v.slackConnectionLabel='Slack is intentionally not part of this workspace — mention notifications are never sent. Comments are saved in your browser.';
 v.slackConnectLabel='Not available';
 v.slackConnectionDisabled=true;
 v.sendDisabled=true;
 v.canCreateGmailDraft=!!(s.signedIn&&s.compose&&!s.expired);
 v.createGmailDraft=async()=>{
  const d=this._currentWorkspaceDraft?this._currentWorkspaceDraft():null;
  if(!d)return;
  try{
   const r=await fetch('/api/gmail/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to:d.recipients||'',subject:d.subject||d.title||'',body:d.text||''})});
   const j=await r.json();
   if(!r.ok)throw new Error(j.error||'Draft was not created');
   this.setState({draftFeedback:'Gmail draft created. Nothing was sent.',draftFeedbackClass:'form-success'});
  }catch(e){this.setState({draftFeedback:e.message||'Draft was not created',draftFeedbackClass:'form-error'});}
 };
 return v;
};

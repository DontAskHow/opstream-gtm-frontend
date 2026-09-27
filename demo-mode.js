// Browser-local workspace store, signed-in Google state, and the confirmed Gmail send.
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
 v.signedInPicture=/^https:\/\//.test(s.picture||'')?s.picture:'';
 v.hasSignedInPicture=!!v.signedInPicture;
 v.signedInPhotoStyle=v.signedInPicture?'background-image:url("'+v.signedInPicture.replace(/["\\)\s]/g,'')+'")':'';
 v.signedInFirstName=String(s.name||'').trim().split(/\s+/)[0]||'';
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
  v.googleConnectionLabel='Email sending is disabled in this public workspace. Sign in with Google to read your mail and calendar and to send a draft from your own Gmail after you confirm it.';
  v.googleConnectLabel='Sign in with Google';
  v.googleConnectionDisabled=false;
  v.connectGoogle=()=>{window.location.href='/api/google/sign-in';};
 }else if(s.expired){
  v.googleConnectionLabel='Google access expired, reconnect';
  v.googleConnectLabel='Reconnect';
  v.googleConnectionDisabled=false;
  v.connectGoogle=()=>{window.location.href='/api/google/sign-in';};
 }else{
  v.googleConnectionLabel='Connected as '+(s.email||s.name)+(s.canSend?'. A draft is sent only when you click Send on it and confirm.':'. Reconnect to allow sending from your Gmail.');
  v.googleConnectLabel='Reconnect';
  v.googleConnectionDisabled=false;
  v.connectGoogle=()=>{window.location.href='/api/google/sign-in';};
 }
 v.slackConnectionLabel='Slack is intentionally not part of this workspace — mention notifications are never sent. Comments are saved in your browser.';
 v.slackConnectLabel='Not available';
 v.slackConnectionDisabled=true;
 v.sendAudit=Array.isArray(this.state.sendAudit)?this.state.sendAudit:[];
 v.hasSendAudit=v.sendAudit.length>0;
 const selected=this._currentWorkspaceDraft?this._currentWorkspaceDraft():null;
 const receipt=selected?v.sendAudit.find(r=>r.draftId===selected.id):null;
 v.hasSendReceipt=!!receipt;
 v.sendReceiptLabel=receipt?'Sent from '+receipt.from+' · '+workspaceModel.formatDateTime(receipt.at)+'.':'';
 const canSend=!!(s.signedIn&&!s.expired&&s.canSend);
 if(canSend){
  v.gmailEmail=s.email||'';
  v.senderLabel=s.email||'';
  const current=this._currentWorkspaceDraft?this._currentWorkspaceDraft():null;
  const emailDraft=current&&(current.purpose==='email'||current.purpose==='event');
  const ready=!!(emailDraft&&String(current.recipients||'').trim()&&String(current.subject||current.title||'').trim()&&String(current.text||'').trim()&&current.id);
  v.sendDisabled=!ready||!!this.state.draftSending;
  v.sendLabel=this.state.draftSending?'Sending…':'Send via Gmail';
  v.sendDraft=()=>{
   const draft=this._currentWorkspaceDraft?this._currentWorkspaceDraft():null;
   if(!draft||this.state.draftSending)return;
   const to=String(draft.recipients||'').trim();
   const cc=String(draft.cc||'').trim();
   const subject=String(draft.subject||draft.title||'').trim();
   const body=String(draft.text||'').trim();
   if(!to||!subject||!body||!draft.id)return;
   this.setState({sendConfirm:{draftId:draft.id,to,cc,subject,body,threadId:draft.threadId||'',inReplyTo:draft.inReplyTo||'',references:draft.references||''}});
  };
  v.confirmSend=async()=>{
   const pending=this.state.sendConfirm;
   if(!pending||pending.confirmed===false||!pending.draftId||this.state.draftSending)return;
   this.setState({draftSending:true});
   try{
    const r=await fetch('/api/gmail/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true,draftId:pending.draftId,to:pending.to,cc:pending.cc||'',subject:pending.subject,body:pending.body,threadId:pending.threadId||'',inReplyTo:pending.inReplyTo||'',references:pending.references||''})});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'Gmail did not send this draft.');
    const row=j.send||{at:new Date().toISOString(),from:s.email,to:pending.to,subject:pending.subject,gmailMessageId:j.id,draftId:pending.draftId};
    this.setState({draftSending:false,sendConfirm:null,draftFeedback:'Sent from '+s.email+'.',draftFeedbackClass:'form-success',sendAudit:[row,...(this.state.sendAudit||[])].slice(0,200)});
   }catch(e){this.setState({draftSending:false,draftFeedback:e.message||'Gmail did not send this draft.',draftFeedbackClass:'form-error'});}
  };
 }else{
  v.sendDisabled=true;
  v.sendLabel=s.signedIn?'Reconnect Google to send':'Sign in with Google to send';
  v.sendDraft=()=>this.setState({draftFeedback:'Sign in with Google to send from your account.',draftFeedbackClass:'form-error'});
  v.confirmSend=()=>this.setState({sendConfirm:null,draftFeedback:'Sign in with Google to send from your account.',draftFeedbackClass:'form-error'});
 }
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

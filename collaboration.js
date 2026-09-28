const collaborationOriginal = { render: Component.prototype.renderVals, mount: Component.prototype.componentDidMount, update: Component.prototype.componentDidUpdate };
const purposeNames = { email: 'Emails', event: 'Event follow-ups', linkedin: 'LinkedIn posts', campaign: 'Campaign drafts', 'internal-note': 'Internal notes' };
const emptyPreferences = () => ({ mode:'marketing', ratings:{}, draftModes:{}, priorityContext:{} });
const shortDate = value => value ? new Date(value).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
Component.prototype._workspaceApi = async function(path, body, method='POST') {
  const response = await fetch('/api'+path,{method:body===undefined?'GET':method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});
  let data;try{data=await response.json();}catch{throw new Error('The workspace could not be reached. Your input is kept.');}
  if(!response.ok){const error=new Error(data.error||'The request could not be completed.');error.code=data.code;throw error;}return data;
};
Component.prototype._loadWorkspace = async function() {
  if(this._workspaceLoad)return this._workspaceLoad;
  this.setState({workspaceLoading:true,workspaceError:null});
  this._workspaceLoad=(async()=>{
    try {
      const data=await this._workspaceApi('/bootstrap');
      this._preferencesRevision=data.preferencesRevision;this._savedPreferences=JSON.stringify(data.preferences);
      const firstLoad=!this._recoveryLoaded;
      let recovery={};this._personalKey='opstream-gtm-personal-work-v2:'+data.user.id;
      if(!this._recoveryLoaded){try{recovery=JSON.parse(localStorage.getItem(this._personalKey)||'{}');this._personalReadFailed=false;}catch{this._personalReadFailed=true;}this._recoveryLoaded=true;}
      this.setState({user:data.user,workspaceReady:true,workspaceLoading:false,workspaceError:null,workspacePreferences:data.preferences,
        remoteDrafts:data.drafts,sharedComments:data.comments,connections:data.connections,browserImported:data.imported,sends:data.sends,campaignSenders:data.campaignSenders,
        draftEdits:firstLoad?recovery.draftEdits||this.state.draftEdits||{}:this.state.draftEdits||{},newDrafts:firstLoad?recovery.newDrafts||this.state.newDrafts||[]:this.state.newDrafts||[],commentEditors:firstLoad?recovery.commentEditors||this.state.commentEditors||{}:this.state.commentEditors||{}});
    }catch(error){this.setState({workspaceLoading:false,workspaceError:error.message});}
    finally{this._workspaceLoad=null;}
  })();return this._workspaceLoad;
};
Component.prototype.componentDidMount = function() {
  collaborationOriginal.mount.call(this);this._loadWorkspace();
  this._workspaceFocus=()=>{if(this.state.workspaceReady)this._workspaceApi('/comments').then(data=>this.setState({sharedComments:data.comments})).catch(()=>{});};
  addEventListener('focus',this._workspaceFocus);
  if(typeof document!=='undefined')addEventListener('keydown',event=>{
    const dialog=document.querySelector('[aria-modal="true"]');if(!dialog||!this.state.evidence||event.key!=='Tab')return;
    const controls=[...dialog.querySelectorAll('button:not(:disabled),a[href],input,textarea,select,summary,[tabindex="0"]')].filter(node=>node.getClientRects().length);
    if(!controls.length)return;const first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&(!dialog.contains(document.activeElement)||document.activeElement===first)){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(!dialog.contains(document.activeElement)||document.activeElement===last)){event.preventDefault();first.focus();}
  });
};
Component.prototype._saveBrowserState = function(retry=false) {
  if(!this.state.user||this._personalReadFailed)return false;
  const state=this.state,remoteIds=new Set((state.remoteDrafts||[]).map(d=>d.id));
  const raw=JSON.stringify({draftEdits:state.draftEdits||{},newDrafts:(state.newDrafts||[]).filter(d=>!remoteIds.has(d.id)),commentEditors:state.commentEditors||{}});
  if(raw===this._personalSaved)return true;if(!retry&&raw===this._personalAttempt)return false;this._personalAttempt=raw;
  try{localStorage.setItem(this._personalKey,raw);this._personalSaved=raw;if(state.storageError&&!this._showcaseReadFailed)this.setState({storageError:null});return true;}
  catch{if(!state.storageError)this.setState({storageError:'Unsaved text is only in this tab because browser recovery storage is unavailable. Save your work to the workspace before closing.'});return false;}
};
Component.prototype._persistPreferences = async function() {
  if(!this.state.workspaceReady||this._preferencesSaving)return;
  const {comments:_comments,schemaVersion:_schemaVersion,...preferences}={...emptyPreferences(),...this.state.workspacePreferences};
  const signature=JSON.stringify(preferences);if(signature===this._savedPreferences)return;
  this._preferencesSaving=true;this.setState({preferencesSaving:true,preferencesError:null});
  try{const saved=await this._workspaceApi('/preferences',{preferences,expectedRevision:this._preferencesRevision},'PUT');this._preferencesRevision=saved.revision;this._savedPreferences=signature;this.setState({preferencesSaving:false});}
  catch(error){this.setState({preferencesSaving:false,preferencesError:error.message});}
  finally{this._preferencesSaving=false;if(!this.state.preferencesError){clearTimeout(this._preferencesTimer);this._preferencesTimer=setTimeout(()=>this._persistPreferences(),300);}}
};
Component.prototype._workspaceDrafts = function() {
  const s=this.state,remote=new Map((s.remoteDrafts||[]).map(d=>[d.id,d])),seeds=s.draftSeeds||[],ids=new Set(seeds.map(d=>d.id));
  const base=[...seeds.map((d,i)=>remote.get(d.id)||workspaceDomain.document(d,i)),...(s.remoteDrafts||[]).filter(d=>!ids.has(d.id))];base.forEach(d=>ids.add(d.id));
  for(const [i,d] of (s.newDrafts||[]).entries()){const normalized=workspaceDomain.document(d,i);if(!ids.has(normalized.id)){base.push(normalized);ids.add(normalized.id);}}
  return base.map(d=>{const edits=s.draftEdits?.[d.id]||{},dirty=Object.keys(edits).some(k=>JSON.stringify(edits[k])!==JSON.stringify(d[k]));return{...d,...edits,dirty,baseVersion:d.version};});
};
Component.prototype._currentWorkspaceDraft = function() {
  const list=this._workspaceDrafts();return this.state.draftId?list.find(d=>d.id===this.state.draftId):list[this.state.draft||0];
};
Component.prototype._draftModeKey = function(){return this._currentWorkspaceDraft()?.id||'none';};
Component.prototype._editWorkspaceDraft = function(id,patch) {
  this.setState({draftEdits:{...this.state.draftEdits,[id]:{...this.state.draftEdits?.[id],...patch}},draftFeedback:null,draftSaveConflict:false});
};
Component.prototype._selectWorkspaceDraft = function(id,purpose) {
  this.setState({draftId:id||null,draftPurpose:purpose||null,draftFeedback:null,draftSaveConflict:false});
};
Component.prototype._newWorkspaceDraft = function(purpose='email',values={}) {
  const d=workspaceDomain.document({id:crypto.randomUUID(),purpose,title:'Untitled draft',subject:'',text:'',...values});
  this.setState({screen:'drafts',newDrafts:[...this.state.newDrafts||[],d],draftId:d.id,draftPurpose:d.purpose,draftFeedback:null,draftSaveConflict:false,evidence:false});
  return d;
};
Component.prototype._saveWorkspaceDraft = async function(draft=this._currentWorkspaceDraft()) {
  if(!this.state.workspaceReady)throw new Error('Your workspace is still loading.');
  if(this._draftSavePromise){await this._draftSavePromise;return this._saveWorkspaceDraft(this._workspaceDrafts().find(d=>d.id===draft.id)||draft);}
  const captured=JSON.stringify(this.state.draftEdits?.[draft.id]||{}),expectedVersion=draft.baseVersion??draft.version;
  this.setState({draftSaving:true,draftFeedback:null,draftSaveConflict:false});
  this._draftSavePromise=(async()=>{
    try{
      const {draft:saved}=await this._workspaceApi('/drafts/'+encodeURIComponent(draft.id),{draft,expectedVersion},'PUT');
      const remote=[...this.state.remoteDrafts||[]],index=remote.findIndex(d=>d.id===saved.id);if(index<0)remote.push(saved);else remote[index]=saved;
      const edits={...this.state.draftEdits};if(JSON.stringify(edits[draft.id]||{})===captured)delete edits[draft.id];
      this.setState({remoteDrafts:remote,draftEdits:edits,draftSaving:false,draftFeedback:'Saved version '+saved.version+'.',draftFeedbackClass:'form-success'});
      return saved;
    }catch(error){this.setState({draftSaving:false,draftFeedback:error.message,draftFeedbackClass:'form-error',draftSaveConflict:error.code==='version_conflict'});throw error;}
    finally{this._draftSavePromise=null;}
  })();return this._draftSavePromise;
};
Component.prototype._connectWorkspaceProvider = async function(provider) {
  this.setState({connectionError:null,connectionBusy:provider});
  try{const result=await this._workspaceApi('/connections/'+provider+'/start',{});location.assign(result.url);}
  catch(error){this.setState({connectionError:error.message,connectionBusy:null});}
};
Component.prototype._testWorkspaceSlack = async function() {
  if(this.state.slackTestBusy)return;
  this.setState({slackTestBusy:true,connectionError:null});
  try{const result=await this._workspaceApi('/connections/slack/test',{retry:this.state.connections?.slack?.test?.status==='failed'});this.setState({connections:{...this.state.connections,slack:{...this.state.connections.slack,test:result.receipt}}});}
  catch(error){this.setState({connectionError:error.message});}
  finally{this.setState({slackTestBusy:false});}
};
Component.prototype._saveWorkspaceComment = async function(priorityId) {
  const editor=this._commentEditor(priorityId);if(!this.state.workspaceReady||editor.saving||!editor.text.trim())return;
  const id=editor.editingId||editor.commentId||crypto.randomUUID(),previous=(this.state.sharedComments||[]).find(c=>c.id===id);
  const signature=JSON.stringify({text:editor.text.trim(),tags:editor.tags}),sameOperation=editor.signature===signature&&editor.operationId;
  const operationId=sameOperation?editor.operationId:crypto.randomUUID(),expectedRevision=sameOperation?editor.expectedRevision:previous?.revision||0;
  this._editComment(priorityId,{commentId:id,operationId,signature,expectedRevision,saving:true,error:null});
  try{
    const result=await this._workspaceApi('/priorities/'+encodeURIComponent(priorityId)+'/comments',{id,operationId,text:editor.text.trim(),tags:editor.tags,expectedRevision});
    this.setState({sharedComments:result.comments});
    const current=this._commentEditor(priorityId);
    this._editComment(priorityId,JSON.stringify({text:current.text.trim(),tags:current.tags})===signature?{text:'',tags:[],editingId:null,commentId:null,operationId:null,signature:null,saving:false}:{saving:false,editingId:id,operationId:null});
  }catch(error){this._editComment(priorityId,{saving:false,error:error.message});try{const result=await this._workspaceApi('/comments');this.setState({sharedComments:result.comments});}catch{/* A later retry uses the same save identity. */}}
};
Component.prototype._retryMention = async function(id,priorityId) {
  try{const result=await this._workspaceApi('/notifications/'+encodeURIComponent(id)+'/retry',{});this.setState({sharedComments:result.comments});}
  catch(error){this._editComment(priorityId,{error:error.message});}
};
Component.prototype._mentionCandidates = function(editor) {
  const caret=editor.caret??editor.text.length,prefix=editor.text.slice(0,caret),match=prefix.match(/(^|\s)@([\p{L}\p{M} .-]{0,50})$/u);
  if(!match||editor.hideSuggestions)return[];
  const query=match[2].toLocaleLowerCase();return(this.state.verified?.meta.owners||[]).filter(p=>!p.former&&p.email&&!editor.tags.includes(p.id)&&(p.name.toLocaleLowerCase().includes(query)||p.email.toLowerCase().includes(query))).slice(0,12);
};
Component.prototype._chooseMention = function(priorityId,person) {
  const editor=this._commentEditor(priorityId),caret=editor.caret??editor.text.length,prefix=editor.text.slice(0,caret);
  const before=prefix.replace(/@[\p{L}\p{M} .-]{0,50}$/u,'@'+person.name+' '),text=before+editor.text.slice(caret);
  this._editComment(priorityId,{text,tags:[...new Set([...editor.tags,person.id])],caret:before.length,mentionIndex:0,hideSuggestions:true});
  setTimeout(()=>{const area=document.getElementById('comment-'+priorityId);area?.focus();area?.setSelectionRange(before.length,before.length);},0);
};
Component.prototype._importBrowser = async function() {
  if(this.state.importing)return;this.setState({importing:true,workspaceError:null});
  try{await this._workspaceApi('/import-browser',{original:this._legacyBrowserRaw});await this._loadWorkspace();}
  catch(error){this.setState({workspaceError:error.message});}finally{this.setState({importing:false});}
};
Component.prototype._workspaceDownload = function(name,value,type='text/plain;charset=utf-8') {
  const url=URL.createObjectURL(new Blob([value],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
Component.prototype._workspaceHistory = async function() {
  const draft=this._currentWorkspaceDraft();if(!draft)return;
  try{
    const result=await this._workspaceApi('/drafts/'+encodeURIComponent(draft.id)+'/history');
    const history=Array.isArray(result?.history)?result.history:Array.isArray(result?.versions)?result.versions:[];
    const distinct=[...new Map(history.map(d=>[d.version+':'+JSON.stringify([d.subject,d.text,d.rationale]),d])).values()].sort((a,b)=>b.version-a.version);
    this.setState({workspaceHistory:distinct,evidence:'workspace-history'});
  }catch(error){this.setState({draftFeedback:error.message,draftFeedbackClass:'form-error'});}
};
// "Name <a@b.c>", bare addresses and contact names all become addresses; repeats go.
const recipientEmails=(value,company)=>{
  const byName=new Map((company?.contacts||[]).filter(c=>c.email).map(c=>[String(c.name||'').trim().toLowerCase(),c.email]));
  const out=[];
  for(const part of String(value||'').split(/[,;]/).map(x=>x.trim()).filter(Boolean)){
    const email=(part.match(/[^\s<>"]+@[^\s<>"]+/)||[])[0]||byName.get(part.replace(/<.*>/,'').trim().toLowerCase())||'';
    if(email&&!out.some(e=>e.toLowerCase()===email.toLowerCase()))out.push(email);
  }
  return out.join(', ');
};
const emailList=value=>String(value||'').split(/[,;]/).map(x=>(x.match(/[^\s<>"]+@[^\s<>"]+/)||[])[0]).filter(Boolean).filter((e,i,a)=>a.findIndex(x=>x.toLowerCase()===e.toLowerCase())===i).join(', ');
const plainNote=html=>String(html||'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
// A follow-up opened from the newest recording or completed meeting on the account.
// CRM notes are internal, so the newest one goes to the draft's internal notes, not the email.
const followUpFromNotes=(company,recipients)=>{
  if(!company)return {text:'',internalNotes:''};
  const contact=(company.contacts||[]).find(c=>c.email&&String(recipients).toLowerCase().includes(c.email.toLowerCase()));
  const first=String(contact?.name||'').trim().split(/\s+/)[0];
  const items=[
    ...(company.recordings||[]).map(r=>({at:String(r.date||r.start||''),line:'Thanks again for the '+(r.title||'call')+' on '+workspaceModel.formatDate(String(r.date||r.start||'').slice(0,10))+'.',detail:(r.actions||[]).slice(0,4).map(a=>'- '+a).join('\n')})),
    ...(company.meetings||[]).filter(m=>/complete/i.test(m.outcome||'')).map(m=>({at:String(m.start||''),line:'Thanks again for the '+(m.title||'meeting')+' on '+workspaceModel.formatDate(String(m.start||'').slice(0,10))+'.',detail:''})),
    ...(company.notes||[]).map(n=>({at:String(n.date||''),line:'',detail:plainNote(n.text).slice(0,400)})),
  ].filter(x=>x.at).sort((a,b)=>b.at.localeCompare(a.at));
  const meeting=items.find(x=>x.line),note=items.find(x=>!x.line&&x.detail);
  const internalNotes=note?'Latest CRM note ('+workspaceModel.formatDate(note.at.slice(0,10))+'): '+note.detail:'';
  const text=[first?'Hi '+first+',':'Hi,','',meeting?meeting.line:'I wanted to follow up on where things stand.',meeting?.detail?'\nThe next steps we noted:\n'+meeting.detail:'','','Would a short call next week help to move this forward?','','Best,'].join('\n').replace(/\n{3,}/g,'\n\n');
  return {text,internalNotes};
};
Component.prototype.renderVals = function() {
  const v=collaborationOriginal.render.call(this),s=this.state,ready=!!s.workspaceReady;
  v.workspaceLoading=!!s.workspaceLoading;v.workspaceError=s.workspaceError||s.preferencesError||'';v.reloadWorkspace=()=>this._loadWorkspace();
  v.connectionsOpen=!!s.connectionsOpen;
  v.showConnections=()=>this.setState({connectionsOpen:true});
  v.hideConnections=()=>this.setState({connectionsOpen:false});
  v.connectGmail=()=>{window.location.href='/api/google/sign-in';};
  v.disconnectGmail=()=>{window.location.href='/auth/logout';};
  v.connectGmailAction=v.connectGmail;
  v.canImportBrowser=ready&&!!this._legacyBrowserRaw&&!s.browserImported;
  v.importLabel=s.importing?'Importing…':'Import my browser work';v.importBrowser=()=>this._importBrowser();
  v.downloadBrowserBackup=()=>this._workspaceDownload('opstream-browser-backup.json',this._legacyBrowserRaw,'application/json');
  const slack=s.connections?.slack||{};
  v.slackConnectionLabel=slack.connected?slack.name+' · '+slack.url:!s.user?.owner?'The workspace owner needs to connect Slack once. You do not need a separate Slack sign-in. Comments are saved; mention DMs will start after setup.':slack.configured?'Connect Slack once for the team and choose its workspace. Its name and address are found automatically.':'Complete the one-time Slack app setup, then connect the team workspace. Teammates do not connect individually. Comments are saved while Slack is disconnected.';
  v.slackConnectLabel=s.connectionBusy==='slack'?'Connecting…':slack.connected?'Reconnect Slack':'Connect Slack';
  v.slackConnectionDisabled=!ready||!slack.configured||!!s.connectionBusy;v.canManageSlack=!!s.user?.owner;
  v.connectSlack=()=>this._connectWorkspaceProvider('slack');v.connectionError=s.connectionError||'';
  v.canTestSlack=!!s.user?.owner&&!!slack.connected;v.testSlack=()=>this._testWorkspaceSlack();
  v.slackTestDisabled=!!s.slackTestBusy||['sent','sending','unknown'].includes(slack.test?.status);
  v.slackTestLabel=s.slackTestBusy?'Sending test…':slack.test?.status==='failed'?'Retry test DM':'Send test DM to installer';
  v.slackTestReceipt=slack.test?(slack.test.status==='sent'?'Test DM accepted by Slack · '+slack.test.providerId:slack.test.error||'Test DM is in progress. Reload to check its outcome.'):'';
  v.refreshNote='A newer collection on the server reloads this page. Latest collection: '+(v.collectedLong||v.collectedShort||'not recorded')+'. Saved work stays in this browser.';
  if(!s.verified)return v;
  if(s.screen==='meeting'){
    const recording=[...s.records.companies.flatMap(c=>c.recordings),...s.records.unmatchedRecordings].find(r=>r.id===s.meetingId);
    this._readableMeeting=recording?.refs.map(ref=>s.verifiedEvidence[ref]).find(record=>record?.content)?.content||'';
  }else this._readableMeeting='';
  const colleagues=(s.verified.meta.owners||[]).filter(p=>!p.former&&p.email),names=new Map(colleagues.map(p=>[p.id,p.name]));
  for(const p of [...v.priorities,...v.lessPriorities]) {
    const comments=(s.sharedComments||[]).filter(c=>c.priorityId===p.id),editor=this._commentEditor(p.id),suggestions=this._mentionCandidates(editor),selected=Math.min(editor.mentionIndex||0,suggestions.length-1);
    p.commentCount=comments.length;p.commentLabel=comments.length?'Comments ('+comments.length+')':'Add a comment';p.starLabel=p.important?'Remove priority star':'Prioritize';p.starFill=p.important?'currentColor':'none';p.lessActionLabel=p.notImportant?'Show in priorities':'Show less';
    const importantGo=p.importantGo,lessGo=p.lessGo,clearRating=p.clearRating;
    p.importantGo=()=>{if(ready)importantGo();};p.lessGo=()=>{if(ready)lessGo();};p.clearRating=()=>{if(ready)clearRating();};
    p.comments=comments.map(c=>({...c,anchorId:'shared-comment-'+c.id,date:shortDate(c.updatedAt||c.createdAt),tags:c.tags.map(id=>'@'+(names.get(id)||id)).join(' · '),hasTags:!!c.tags.length,
      edit:()=>this._editComment(p.id,{editingId:c.id,commentId:null,operationId:null,signature:null,text:c.text,tags:c.tags,caret:c.text.length,error:null,hideSuggestions:true}),
      deliveries:(c.notifications||[]).map(n=>({...n,label:(names.get(n.recipientId)||n.recipientEmail)+' · '+({sent:'DM sent',failed:'DM not sent',sending:'Sending DM…',pending:'DM pending',unknown:'DM outcome uncertain'}[n.status])+(n.error?' — '+n.error:''),canRetry:c.mine&&['pending','failed'].includes(n.status),retry:()=>this._retryMention(n.id,p.id)}))}));
    p.commentError=editor.error||'';p.commentEmpty=!ready||editor.saving||!editor.text.trim();p.saveCommentLabel=editor.saving?'Saving…':editor.editingId?'Save changes':'Save comment';
    p.editCommentText=e=>this._editComment(p.id,{text:e.target.value,caret:e.target.selectionStart,hideSuggestions:false,mentionIndex:0,error:null});
    p.mentionListId='mentions-'+p.id;p.hasSuggestions=suggestions.length>0;
    p.mentionSuggestions=suggestions.map((person,i)=>({...person,selected:i===selected,choose:()=>this._chooseMention(p.id,person)}));
    p.commentKeyDown=e=>{if(suggestions.length&&['ArrowDown','ArrowUp','Enter','Escape'].includes(e.key)){e.preventDefault();if(e.key==='Enter')this._chooseMention(p.id,suggestions[Math.max(0,selected)]);else if(e.key==='Escape')this._editComment(p.id,{hideSuggestions:true});else this._editComment(p.id,{mentionIndex:(selected+(e.key==='ArrowDown'?1:-1)+suggestions.length)%suggestions.length});}};
    p.saveComment=()=>this._saveWorkspaceComment(p.id);
    p.cancelComment=()=>{this._editComment(p.id,{text:'',tags:[],editingId:null,commentId:null,operationId:null,signature:null,error:null,hideSuggestions:true});this.setState({commentPriorityId:null});};
  }
  v.priorityNotice=s.preferencesError?s.preferencesError:s.preferencesSaving?'Saving your preferences…':ready?'Priority preferences are saved in this browser.':'';
  const drafts=this._workspaceDrafts(),selectedDraft=this._currentWorkspaceDraft(),purpose=s.draftPurpose||selectedDraft?.purpose||'email';
  const show=s.draftShow?((s.marketing?.shows?.items)||[]).find(x=>x.id===s.draftShow):null,inShow=d=>!s.draftShow||d.showId===s.draftShow;
  v.draftTabs=Object.entries(purposeNames).map(([id,label])=>({label,count:drafts.filter(d=>d.purpose===id&&inShow(d)).length,selected:purpose===id,go:()=>this._selectWorkspaceDraft(drafts.find(d=>d.purpose===id&&inShow(d))?.id,id)}));
  const visible=drafts.filter(d=>d.purpose===purpose&&inShow(d));
  const plural=(n,one,many)=>n+' '+(n===1?one:many);
  const purposeWords={email:['email','emails'],event:['event follow-up','event follow-ups'],linkedin:['LinkedIn post','LinkedIn posts'],campaign:['campaign draft','campaign drafts'],'internal-note':['internal note','internal notes']};
  v.hasDraftShow=!!s.draftShow;v.draftShowLine=s.draftShow?'Drafts for '+(show?.name||'this show')+': '+Object.entries(purposeWords).map(([id,[one,many]])=>{const n=drafts.filter(d=>d.purpose===id&&inShow(d)).length;return n?plural(n,one,many):'';}).filter(Boolean).join(' · '):'';
  v.clearDraftShow=()=>this.setState({draftShow:null});v.draftListTitle=purposeNames[purpose]||'Drafts';v.draftsEmpty=!visible.length;
  v.draftList=visible.map(d=>({title:d.title||d.subject||'Untitled draft',current:d.id===selectedDraft?.id,status:(s.sendAudit||[]).some(r=>r.draftId===d.id)?'Sent':d.status,
    meta:d.company+' · '+(d.version?'v'+d.version:'Not saved')+(d.dirty?' · unsaved changes':''),go:()=>this._selectWorkspaceDraft(d.id,d.purpose)}));
  v.hasDraft=!!selectedDraft&&selectedDraft.purpose===purpose;v.newDraft=()=>this._newWorkspaceDraft(purpose);
  v.draftFeedback=s.draftFeedback||'';v.draftFeedbackClass=s.draftFeedbackClass||'form-success';v.draftSaveConflict=!!s.draftSaveConflict;
  if(selectedDraft) {
    const draft=selectedDraft,id=draft.id,edit=patch=>this._editWorkspaceDraft(id,patch);
    v.draft={...draft,refs:draft.supportRefs.length,versionLabel:(draft.version?'Version '+draft.version:'Not saved')+(draft.dirty?' · unsaved changes':''),hasCitations:(draft.citations||[]).length>0,citationsLine:(draft.citations||[]).join(' · ')};
    v.isEmailDraft=draft.purpose==='email'||draft.purpose==='event';v.isCampaignDraft=draft.purpose==='campaign';v.isLinkedInDraft=draft.purpose==='linkedin';v.subjectLabel=['email','event','campaign'].includes(draft.purpose)?'Subject':'Title';v.messageLabel=draft.purpose==='internal-note'?'Note':draft.purpose==='linkedin'?'Post':'Message';
    v.senderLabel=s.gmailEmail||'Sign in with Google to send from your own Gmail';v.senderActionLabel=s.gmailEmail?'Sign out':'Sign in with Google';
    v.campaignSenders=s.campaignSenders||[];v.editCampaignSender=e=>edit({campaignSender:e.target.value});
    v.editSubject=e=>edit({subject:e.target.value,title:e.target.value});v.editText=e=>edit({text:e.target.value});v.editRecipients=e=>edit({recipients:e.target.value});v.editCc=e=>edit({cc:e.target.value});v.editBcc=e=>edit({bcc:e.target.value});v.editRationale=e=>edit({rationale:e.target.value});v.editInternalNotes=e=>edit({internalNotes:e.target.value});v.editStatus=e=>edit({status:e.target.value});
    const contacts=(s.records.companies||[]).filter(c=>draft.accountIds.includes('company:'+c.id)).flatMap(c=>c.contacts||[]).filter(c=>c.email);
    v.draftContacts=[...new Map(contacts.map(c=>[c.email,{email:c.email,label:(c.name?c.name+' · ':'')+c.email}])).values()];v.hasContacts=v.draftContacts.length>0;
    v.addDraftContact=e=>{if(v.draftContacts.some(c=>c.email===e.target.value))edit({recipients:[...new Set([...draft.recipients.split(',').map(x=>x.trim()).filter(Boolean),e.target.value])].join(', ')});};
    v.saveDisabled=!ready||!!s.draftSaving||(!draft.dirty&&(s.remoteDrafts||[]).some(d=>d.id===id));v.saveLabel=s.draftSaving?'Saving…':'Save version '+(draft.version+1);
    v.saveDraft=()=>this._saveWorkspaceDraft().catch(()=>{});
    v.sendConfirm=s.sendConfirm||null;
    v.cancelSend=()=>this.setState({sendConfirm:null});
    v.copyLinkedIn=async()=>{try{await navigator.clipboard.writeText(draft.text);this.setState({draftFeedback:'Post copied. Paste it into LinkedIn and post it yourself.',draftFeedbackClass:'form-success'});}catch{this.setState({draftFeedback:'Clipboard access is unavailable. Use Export to download the post.',draftFeedbackClass:'form-error'});}};
    v.evDraftRefs=()=>this._verifiedOpenRefs(draft.supportRefs,'Records behind this draft');
    v.exportDraft=()=>{if(draft.purpose==='campaign')this.csv('lemlist-campaign-draft.csv',['sender','subject','body'],[[draft.campaignSender,draft.subject,draft.text]]);else this.csv('opstream-draft.csv',['Field','Value'],[['Subject',draft.subject],['Purpose',draft.purpose],['To',draft.recipients],['Cc',draft.cc],['Bcc',draft.bcc],['Message',draft.text],['Internal notes',draft.internalNotes],['Review context',draft.rationale],['Version',draft.version]]);};
    v.copyCampaign=async()=>{try{await navigator.clipboard.writeText('Subject: '+draft.subject+'\n\n'+draft.text);this.setState({draftFeedback:'Campaign copy copied. Paste it into your LemList sequence.',draftFeedbackClass:'form-success'});}catch{this.setState({draftFeedback:'Clipboard access is unavailable. Use Export to download the campaign copy.',draftFeedbackClass:'form-error'});}};
    const gmailParams=new URLSearchParams({view:'cm',fs:'1',to:emailList(draft.recipients),su:draft.subject||'',body:draft.text||''});
    if(emailList(draft.cc))gmailParams.set('cc',emailList(draft.cc));if(emailList(draft.bcc))gmailParams.set('bcc',emailList(draft.bcc));
    v.gmailComposeUrl='https://mail.google.com/mail/?'+gmailParams.toString();
    v.copyEmail=async()=>{try{await navigator.clipboard.writeText('To: '+emailList(draft.recipients)+(emailList(draft.cc)?'\nCc: '+emailList(draft.cc):'')+'\nSubject: '+draft.subject+'\n\n'+draft.text);this.setState({draftFeedback:'Email copied. Paste it into Gmail to send.',draftFeedbackClass:'form-success'});}catch{this.setState({draftFeedback:'Clipboard access is unavailable. Use Export to download the email.',draftFeedbackClass:'form-error'});}};
    v.generateLabel=s.generating?'Generating…':'Generate with AI';
    v.generateDisabled=!!s.generating;
    v.generateEmail=async()=>{
      if(this.state.generating)return;
      const d=this._currentWorkspaceDraft();
      if(!d)return;
      this.setState({generating:true,draftFeedback:null});
      try{
        const r=await fetch('/api/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({format:'email',draft:{purpose:d.purpose,company:d.company,recipients:d.recipients,subject:d.subject,text:d.text,rationale:d.rationale}})});
        const j=await r.json();if(!r.ok)throw new Error(j.error||'Generation failed');
        const subject=String(j.subject||'').trim(),body=String(j.body||'').trim();
        if(!body)throw new Error('the reply had no message text. Your draft is unchanged.');
        this._editWorkspaceDraft(d.id,{...(subject?{subject,title:subject}:{}),text:body});
        this.setState({generating:false,draftFeedback:'AI draft generated. Review and edit before sending.',draftFeedbackClass:'form-success'});
      }catch(e){this.setState({generating:false,draftFeedback:'Could not generate: '+(e.message||'error'),draftFeedbackClass:'form-error'});}
    };
    v.showWorkspaceHistory=()=>this._workspaceHistory();v.reloadWorkspaceDraft=async()=>{try{const result=await this._workspaceApi('/drafts/'+encodeURIComponent(id));const edits={...this.state.draftEdits};delete edits[id];this.setState({remoteDrafts:[...(this.state.remoteDrafts||[]).filter(d=>d.id!==id),result.draft],draftEdits:edits,draftSaveConflict:false,draftFeedback:null});}catch(error){this.setState({draftFeedback:error.message,draftFeedbackClass:'form-error'});}};
    v.saveDraftCopy=()=>{this._newWorkspaceDraft(draft.purpose,{...draft,id:crypto.randomUUID(),title:draft.title+' (copy)',subject:draft.subject,version:0,history:[]});return this._saveWorkspaceDraft().catch(()=>{});};
  }
  const wrapEntry=action=>()=>{this.setState({draftId:null,draftPurpose:null,draftShow:null});const count=(this.state.newDrafts||[]).length;action();const additions=this.state.newDrafts||[];if(additions.length>count){const raw=additions[count],company=(s.records.companies||[]).find(c=>c.name===raw.company);const recipients=recipientEmails(raw.recipients,company),seeded=String(raw.text||'').trim()?null:followUpFromNotes(company,recipients);const d=workspaceDomain.document({...raw,id:raw.id||crypto.randomUUID(),subject:raw.subject||('Following up'+(raw.company?' · '+raw.company:'')),text:seeded?seeded.text:String(raw.text),internalNotes:raw.internalNotes||seeded?.internalNotes||'',recipients,accountIds:company?['company:'+company.id]:(raw.accountIds||[])});this.setState({newDrafts:additions.map((x,i)=>i===count?d:x),draftId:d.id,draftPurpose:'email'});}};
  if(v.acct?.draftGo)v.acct.draftGo=wrapEntry(v.acct.draftGo);if(v.mtg?.draftGo)v.mtg.draftGo=wrapEntry(v.mtg.draftGo);
  for(const follow of v.followUps||[])follow.draftGo=wrapEntry(follow.draftGo);
  if(s.evidence){
    const refs=String(v.ev?.ids||'').match(/evidence:[a-f0-9-]{36}/g)||[];
    v.ev.records=refs.map(ref=>s.verifiedEvidence[ref]).filter(Boolean);
    if(v.ev.records.length)v.ev.note='Dates and forecasts remain as recorded. Full original records and exports are available.';
    if(s.evidence==='workspace-history'){
      v.ev={kicker:'Saved versions',title:'Draft version history',meta:'Original and personal versions remain available.',rows:(s.workspaceHistory||[]).map(d=>({label:'Version '+d.version+' · '+(d.updatedAt||d.savedAt||''),value:[d.subject||d.title,d.recipients,d.text,d.internalNotes,d.rationale].filter(Boolean).join('\n\n')})),ids:selectedDraft?.id||'',note:'Saved to your account.',missing:false,hasRows:true};
      v.exportEvidence=()=>this._workspaceDownload('draft-history.json',JSON.stringify(s.workspaceHistory,null,2),'application/json');
    }
    v.proposeCorrection=()=>{const title='Correction: '+v.ev.title;const existing=this._workspaceDrafts().find(d=>d.title===title&&d.purpose==='internal-note');if(existing){this.setState({screen:'drafts',draftId:existing.id,draftPurpose:existing.purpose,evidence:false,draftFeedback:'A correction draft for this record already exists — opened it instead of creating a duplicate.',draftFeedbackClass:'form-success'});window.scrollTo(0,0);return;}this._newWorkspaceDraft('internal-note',{title,subject:title,text:'Describe the correction to '+v.ev.title+'.',internalNotes:'Keep the original record and supporting evidence until the correction is verified.',supportRefs:refs,rationale:v.ev.ids});};
    v.ev.sourceLinks=workspaceModel.hubspotLinks(String(v.ev.ids||'').match(/hubspot:(?:deals|companies|contacts):\d+/g)||[]);v.ev.hasSourceLinks=v.ev.sourceLinks.length>0;
    this._readableEvidence=v.ev;
  }else this._readableEvidence=null;
  return v;
};
Component.prototype.componentDidUpdate = function(...args) {
  collaborationOriginal.update.apply(this,args);
  if(this.state.workspaceReady&&!this.state.preferencesError){clearTimeout(this._preferencesTimer);this._preferencesTimer=setTimeout(()=>this._persistPreferences(),400);}
  if(typeof document==='undefined')return;
  const meetingHost=document.getElementById('meeting-summary-readable');
  if(meetingHost&&typeof OpstreamEvidence!=='undefined'&&(this._meetingHost!==meetingHost||this._meetingSignature!==this._readableMeeting)){
    meetingHost.replaceChildren();OpstreamEvidence.markdown(meetingHost,this._readableMeeting);this._meetingHost=meetingHost;this._meetingSignature=this._readableMeeting;
  }
  const host=document.getElementById('evidence-readable');
  if(host&&this._readableEvidence&&typeof OpstreamEvidence!=='undefined'){
    const signature=JSON.stringify([this.state.evidence,this._readableEvidence.ids,this._readableEvidence.rows]);
    if(signature!==this._evidenceSignature||host!==this._evidenceHost){OpstreamEvidence.render(host,this._readableEvidence,this.state.sheetLabels);this._evidenceSignature=signature;this._evidenceHost=host;}
  }
  const dialog=document.querySelector('[aria-modal="true"]');
  if(dialog&&this.state.evidence&&!this._activeDialog){this._dialogReturnFocus=document.activeElement;this._activeDialog=dialog;dialog.querySelector('button')?.focus();}
  else if(!this.state.evidence&&this._activeDialog){this._activeDialog=null;if(this._dialogReturnFocus?.isConnected)this._dialogReturnFocus.focus();}
  if(this._commentScroll){const comment=document.getElementById('shared-comment-'+this._commentScroll);if(comment){comment.scrollIntoView({block:'center'});comment.classList.add('comment-highlight');this._commentScroll=null;}}
};

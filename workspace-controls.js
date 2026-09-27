/* global Component, workspaceModel, verifiedFormat */
const workspaceRender=Component.prototype.renderVals;
Component.prototype._workspacePreferences=function(){return {schemaVersion:1,mode:'cs',ratings:{},comments:{},draftModes:{},priorityContext:{},...this.state.workspacePreferences};};
Component.prototype._rememberPriority=function(id,patch){
  const prefs=this._workspacePreferences(),p=this.state.verified.presentation.priorities.find(p=>p.id===id);
  this.setState({workspacePreferences:{...prefs,...patch,priorityContext:{...prefs.priorityContext,[id]:{title:p.title,accountIds:p.accountIds,refs:p.refs,reviewId:this.state.verified.presentation.priorityReview.id}}}});
};
Component.prototype._ratePriority=function(id,value){const prefs=this._workspacePreferences(),ratings={...prefs.ratings};if(value)ratings[id]=value;else delete ratings[id];this._rememberPriority(id,{ratings});};
Component.prototype._commentEditor=function(id){return {text:'',tags:[],...this.state.commentEditors?.[id]};};
Component.prototype._editComment=function(id,patch){this.setState({commentEditors:{...this.state.commentEditors,[id]:{...this._commentEditor(id),...patch}}});};
Component.prototype._draftModeKey=function(){
  const s=this.state,base=s.verified.drafts.length,suggested=s.verified.presentation.suggestedDrafts.length,index=Math.min(s.draft||0,base+suggested+(s.newDrafts||[]).length-1);
  return s.verified.drafts[index]?.draft.id||(index<base+suggested?'suggested-draft:'+(index-base):'local-draft:'+(index-base-suggested));
};
Component.prototype.renderVals=function(){
  const v=workspaceRender.call(this),s=this.state,d=s.verified;
  v.storageError=s.storageError||'';v.storageFailed=!!s.storageError;v.canRetryStorage=!this._showcaseReadFailed;v.retryBrowserSave=()=>this._saveBrowserState(true);
  if(!d)return v;
  const prefs=this._workspacePreferences(),through=d.presentation.priorityReview.asOf;
  const colleagues=d.meta.owners.filter(p=>!p.former&&/@example\.com$/i.test(p.email||'')).map(p=>({id:p.id,name:p.name}));
  const colleagueNames=new Map(colleagues.map(p=>[p.id,p.name]));
  const raw=d.presentation.priorities.map((p,i)=>{
    const context=workspaceModel.ownerContext(p,s.records,through),rating=prefs.ratings[p.id];
    const editor=this._commentEditor(p.id),comments=Array.isArray(prefs.comments[p.id])?prefs.comments[p.id]:[];
    const contextRefs=[...new Set([...context.ownerRefs,...context.interaction?.refs||[]])];
    return {...p,n:String(i+1),owner:context.owner,ownerLabel:context.account?'Account owner':'Responsible owner',
      interactionDate:context.account?(context.interaction?verifiedFormat.date(context.interaction.date):'Not recorded'):'Not applicable',
      contextLabel:context.interaction?.source||'Owner source',hasContextRefs:contextRefs.length>0,contextGo:()=>this._verifiedOpenRefs(contextRefs,'Owner and last interaction'),
      primary:p.primary.label,primaryGo:this._verifiedTarget(p.primary.target),hasSecondary:!!p.secondary,secondary:p.secondary?.label||'',secondaryGo:p.secondary?this._verifiedTarget(p.secondary.target):()=>{},
      rankLabel:'Recommended #'+(i+1)+' · Why this rank?',sourcesGo:()=>this._verifiedOpenRefs(p.refs,'Why this priority · '+p.title),
      important:rating==='important',notImportant:rating==='not-important',rated:!!rating,
      importantGo:()=>this._ratePriority(p.id,rating==='important'?null:'important'),lessGo:()=>this._ratePriority(p.id,rating==='not-important'?null:'not-important'),clearRating:()=>this._ratePriority(p.id,null),
      commentLabel:comments.length?'Comments ('+comments.length+')':'Comment',commentsOpen:s.commentPriorityId===p.id,
      commentGo:()=>this.setState({commentPriorityId:s.commentPriorityId===p.id?null:p.id}),
      comments:comments.map(c=>({...c,date:new Date(c.updatedAt||c.createdAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}),tags:(c.tags||[]).map(id=>'@'+(colleagueNames.get(id)||id)).join(' · '),hasTags:!!c.tags?.length,edit:()=>this._editComment(p.id,{editingId:c.id,text:c.text,tags:c.tags||[]})})),
      editorId:'comment-'+p.id,editorLabel:editor.editingId?'Edit your comment':'Add a comment',commentText:editor.text,commentEmpty:!editor.text.trim(),saveCommentLabel:editor.editingId?'Save changes':'Save comment',
      editCommentText:e=>this._editComment(p.id,{text:e.target.value}),colleagues,
      addTag:e=>{const id=e.target.value;if(colleagueNames.has(id)&&!editor.tags.includes(id))this._editComment(p.id,{tags:[...editor.tags,id]});},
      editTags:editor.tags.map(id=>({id,name:colleagueNames.get(id)||id,removeLabel:'Remove tag '+(colleagueNames.get(id)||id),remove:()=>this._editComment(p.id,{tags:editor.tags.filter(t=>t!==id)})})),
      cancelComment:()=>{this._editComment(p.id,{text:'',tags:[],editingId:null});this.setState({commentPriorityId:null});},
      saveComment:()=>{
        const now=new Date().toISOString(),current=this._commentEditor(p.id);if(!current.text.trim())return;
        const prior=comments.find(c=>c.id===current.editingId),entry={id:prior?.id||crypto.randomUUID(),text:current.text.trim(),tags:current.tags,createdAt:prior?.createdAt||now,updatedAt:now};
        this._rememberPriority(p.id,{comments:{...prefs.comments,[p.id]:prior?comments.map(c=>c.id===prior.id?entry:c):[...comments,entry]}});
        this._editComment(p.id,{text:'',tags:[],editingId:null});
      }
    };
  });
  const ordered=workspaceModel.order(raw,prefs.ratings);
  v.priorities=ordered.main;v.lessPriorities=ordered.less;v.hasLessPriorities=ordered.less.length>0;v.lessOpen=!!s.lessPrioritiesOpen;
  v.lessLabel='Less important ('+ordered.less.length+')';v.toggleLess=()=>this.setState({lessPrioritiesOpen:!s.lessPrioritiesOpen});
  v.priorityOrderNote=Object.keys(prefs.ratings).some(id=>raw.some(p=>p.id===id))?'Your order · important items first. Numbers show the review’s recommended rank.':'Recommended order · based on timing, blockers and useful next actions.';
  v.priorityNotice=s.storageError?'Preferences remain in this tab until browser saving succeeds.':'Preferences saved in this browser for future reviews.';
  v.prioritiesEmpty=v.priorities.length===0;v.goBriefing=this.go('briefing');
  v.priorityIntro=v.priorities.length?(v.priorities.length+' priorities from the collected record \u00b7 collected '+v.collectedShort+'.'):'No ranked priorities in this collection.';
  v.reviewScope=d.presentation.priorityReview.scope;
  v.accountOrderNote=s.accounts==='follow'?'Order: saved follow-up review · personal priority ratings do not change this list.':s.accounts==='leads'?'Order: newest lead date first · missing lead dates last.':'Order: '+({weighted:'Weighted ARR — highest first (amount × probability)',close:'Close date — earliest first',days:'Days in stage — highest first',name:'Account name — A to Z'}[s.sort||'weighted']);
  v.showAccountSort=s.accounts==='deals';
  const query=(s.search||'').trim().toLowerCase(),owner=s.owner||'Everyone';
  v.followUps=v.followUps.filter(f=>(owner==='Everyone'||f.meta.startsWith(owner+' ·'))&&(!query||[f.name,f.meta,f.reason,f.next,f.uncertainty].join(' ').toLowerCase().includes(query)));
  v.followUpsEmpty=v.followUps.length===0;
  if(s.accounts==='follow')v.exportAccounts=()=>this.csv('follow-ups.csv',['Company','Owner / stage','Reason','Next step','Uncertainty'],v.followUps.map(f=>[f.name,f.meta,f.reason,f.next,f.uncertainty]));
  const key=this._draftModeKey(),mode=prefs.mode==='marketing'?'marketing':'cs',override=prefs.draftModes[key];
  v.contentMode=mode;v.draftContentMode=override||'default';
  v.setContentMode=e=>this.setState({workspacePreferences:{...prefs,mode:e.target.value==='marketing'?'marketing':'cs'}});
  v.setDraftContentMode=e=>{const draftModes={...prefs.draftModes};if(e.target.value==='default')delete draftModes[key];else draftModes[key]=e.target.value;this.setState({workspacePreferences:{...prefs,draftModes}});};
  v.contentModeNote=(override||mode)==='marketing'?'Marketing: broader positioning and planned capabilities, with availability status preserved.':'CS: verified available capabilities and literal guidance from the Opstream user guide.';
  v.contentModeInstructions=workspaceModel.modeInstructions(override||mode);
  if(s.storageError){v.draft.versionLabel='Changes remain in this tab · not saved to browser';v.flash='';}
  return v;
};

const showcaseStorageKey = 'opstream-gtm-showcase-v1';
const showcaseOriginal = { mount:Component.prototype.componentDidMount, update:Component.prototype.componentDidUpdate, render:Component.prototype.renderVals };
const showcaseRouteKeys = ['perf','accounts','meetings','period','search','owner','sort','meetingSearch','meetingOwner','start','end','draft','contributor','leadStage','leadSource','leadFlag','dealFilter','meetingScope','closeOn','meetingKind','draftShow'];
Component.prototype.componentDidMount = function () {
  showcaseOriginal.mount?.call(this);
  try { const raw=localStorage.getItem(showcaseStorageKey),saved=JSON.parse(raw||'null');if(saved&&(!Object.prototype.hasOwnProperty.call(saved,'savedState')||typeof saved!=='object'||Array.isArray(saved)))throw new Error('Invalid browser data');this._legacyBrowserRaw=saved?raw:null; }
  catch {this._showcaseReadFailed=true;this.setState({storageError:'Saved browser data could not be read. Existing stored data has not been replaced. Keep this tab open to retain new edits.'});}
  this._showcaseRestore=()=>{
    const p=new URL(location.href).searchParams;
    const views=['briefing','pipeline','accounts','account','meetings','meeting','drafts','data'];
    const patch={screen:views.includes(p.get('view'))?p.get('view'):'briefing',evidence:false,perf:'demand',accounts:'deals',meetings:'upcoming',period:'quarter',search:'',owner:'Everyone',sort:'amount',meetingSearch:'',meetingOwner:'Everyone',start:'',end:'',draft:0,contributor:null,leadStage:null,leadSource:null,leadFlag:null,dealFilter:null,meetingScope:null,closeOn:null,meetingKind:null,draftShow:null};
    for(const k of showcaseRouteKeys) if(p.has(k)) patch[k]=k==='draft'?Number(p.get(k)):p.get(k);
    if(!p.has('sort')){try{const saved=localStorage.getItem('gtm-sort');if(saved)patch.sort=saved;}catch{}}
    for(const [key,values] of Object.entries({perf:['demand','spend','web'],accounts:['deals','follow','leads'],meetings:['upcoming','past'],period:['six','quarter','year','custom'],sort:['amount','close','interaction','name']}))if(!values.includes(patch[key]))patch[key]=values[0];
    if(!Number.isInteger(patch.draft)||patch.draft<0)patch.draft=0;
    if(!['lead','mql','sql'].includes(patch.contributor))patch.contributor=null;
    if(!['mql-no-sql','no-mql'].includes(patch.leadStage))patch.leadStage=null;
    if(!['hot','live'].includes(patch.leadFlag))patch.leadFlag=null;
    if(patch.dealFilter!=='quiet')patch.dealFilter=null;
    if(patch.meetingScope!=='all')patch.meetingScope=null;
    if(!['completed','recordings'].includes(patch.meetingKind))patch.meetingKind=null;
    if(patch.closeOn&&!/^\d{4}-\d{2}-\d{2}$/.test(patch.closeOn))patch.closeOn=null;
    for(const key of ['start','end'])if(patch[key]&&!/^\d{4}-\d{2}-\d{2}$/.test(patch[key]))patch[key]='';
    if(p.has('account')) patch.accountId=p.get('account');
    if(p.has('meeting')) patch.meetingId=p.get('meeting');
    patch.draftId=p.get('draftId')||null;patch.draftPurpose=p.get('purpose')||null;
    if(p.has('connection')){patch.connectionsOpen=true;patch.connectionError=p.get('connection_error')||null;}
    if(p.has('priority')){patch.commentPriorityId=p.get('priority');patch.lessPrioritiesOpen=true;this._commentScroll=p.get('comment')||null;}
    this._showcaseRestoring=true;
    this.setState(patch,()=>{this._showcaseRestoring=false;});
  };
  this._showcaseRestore();
  this._showcaseResize=()=>this.forceUpdate();
  this._showcaseKey=e=>{if(e.key==='Escape'&&this.state.evidence)this.setState({evidence:false});};
  addEventListener('popstate',this._showcaseRestore);
  addEventListener('resize',this._showcaseResize);
  addEventListener('keydown',this._showcaseKey);
  this._loadVerified();
  if (!this._collectionWatch) {
    this._collectionWatch = setInterval(() => {
      if (this.state.checking || !this.state.records) return;
      fetch('/api/data-stamp', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => {
        const current = this.state.records && this.state.records.generatedAt;
        if (j && j.generatedAt && current && j.generatedAt !== current) this._loadVerified();
      }).catch(() => {});
    }, 60000);
  }
};
Component.prototype.componentDidUpdate = function (...args) {
  showcaseOriginal.update?.apply(this,args);
  const st=this.state;
  this._saveBrowserState();
  if(st.sort){try{if(localStorage.getItem('gtm-sort')!==st.sort)localStorage.setItem('gtm-sort',st.sort);}catch{}}
  if(!this._showcaseRestoring){
    const u=new URL(location.href);u.search='';u.searchParams.set('view',st.screen||'briefing');
    for(const k of showcaseRouteKeys)if(st[k]!=null&&st[k]!=='')u.searchParams.set(k,st[k]);
    if(st.screen==='account'&&st.accountId)u.searchParams.set('account',st.accountId);
    if(st.screen==='meeting'&&st.meetingId)u.searchParams.set('meeting',st.meetingId);
    if(st.screen==='drafts'&&st.draftId)u.searchParams.set('draftId',st.draftId);
    if(st.screen==='drafts'&&st.draftPurpose)u.searchParams.set('purpose',st.draftPurpose);
    if(st.commentPriorityId){u.searchParams.set('priority',st.commentPriorityId);if(this._commentScroll)u.searchParams.set('comment',this._commentScroll);}
    if(u.href!==location.href)history.pushState(null,'',u);
  }
};
Component.prototype._saveBrowserState = function (retry=false) {
  if(this._showcaseReadFailed)return false;
  const st=this.state,saved=JSON.stringify({...this._showcaseStored,savedState:st.savedState||{},newDrafts:st.newDrafts||[],edits:st.edits||{},versionHistory:st.versionHistory||{},workspacePreferences:st.workspacePreferences||{schemaVersion:1,mode:'marketing',ratings:{},comments:{},draftModes:{},priorityContext:{}}});
  if(saved===this._showcaseSaved){if(st.storageError)this.setState({storageError:null});return true;}
  if(!retry&&saved===this._showcaseWriteAttempt)return false;
  this._showcaseWriteAttempt=saved;
  try{localStorage.setItem(showcaseStorageKey,saved);this._showcaseSaved=saved;if(st.storageError)this.setState({storageError:null});return true;}
  catch{const message='Changes are only in this tab: browser storage is unavailable or full. Keep this tab open and retry saving.';if(st.storageError!==message)this.setState({storageError:message});return false;}
};
Component.prototype.renderVals = function () {
  const props=this.props;this.props={...props,mobile:innerWidth<400};
  let v;try{v=showcaseOriginal.render.call(this);}finally{this.props=props;}
  // There is no on-demand rebuild in the browser. Check for updates reloads
  // the files already on the server. A background watch does the same when
  // records.json carries a new generatedAt.
  v.checkLabel=this.state.checking?'Checking…':'Check for updates';
  v.checkNote=this.state.showcaseCheck||'';
  v.checkUpdates=async()=>{
    this.setState({checking:true});
    try{const r=await fetch('data/records.json',{cache:'no-store'});if(!r.ok)throw new Error();const records=await r.json();this.setState({records,checking:false,showcaseCheck:'Collection loaded'});}
    catch{this.setState({checking:false,showcaseCheck:'Could not load the collection. Try again.'});}
  };
  return v;
};

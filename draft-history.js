/* global Component */
const historyRender=Component.prototype.renderVals;
Component.prototype._showDraftHistory = function () {this.setState({evidence:'draft-history'});};
Component.prototype.renderVals = function () {
  const v=historyRender.call(this),s=this.state;if(!s.verified)return v;
  const index=s.draft,baseline=s.verified.drafts[index]?.draft;
  const retained=(baseline?s.verified.draftVersions[baseline.id]||[]:[]).map(({draft:d})=>({version:d.version,title:d.title,text:d.text,rationale:d.rationale,recipients:d.recipients.map(r=>r.email||r.name).join(', '),savedAt:d.updatedAt}));
  const history=new Map(retained.map(d=>[d.version,d]));for(const d of s.versionHistory?.[index]||[])history.set(d.version,d);
  const earlier=[...history.values()].filter(d=>d.version<v.draft.version).sort((a,b)=>b.version-a.version);
  v.draft.history=earlier.length?'Earlier versions: '+earlier.map(d=>'v'+d.version).join(' · ')+'. Open saved text.':'No earlier saved versions.';
  const save=v.saveDraft;
  v.saveDraft=()=>{
    // Read the unedited version through the same renderer; never reconstruct its text.
    if(v.draft.version){const state=this.state;let current;try{this.state={...state,edits:{...state.edits,[index]:{}}};current=historyRender.call(this).draft;}finally{this.state=state;}history.set(v.draft.version,{...current,savedAt:new Date().toISOString()});}
    this.setState({versionHistory:{...s.versionHistory,[index]:[...history.values()]}});save();
  };
  if(s.evidence==='draft-history'){
    v.ev={kicker:'Saved versions',title:'Draft version history',meta:'Earlier saved text remains available.',rows:earlier.map(d=>({label:'Version '+d.version,value:[d.title,d.recipients,d.text,d.rationale].filter(Boolean).join('\n\n')})),note:'New versions are saved in this browser.',ids:baseline?.id||'',missing:false,hasRows:earlier.length>0};
    v.exportEvidence=()=>this.csv('draft-history.csv',['Version','Title','Recipients','Message','Why'],earlier.map(d=>[d.version,d.title,d.recipients,d.text,d.rationale]));
  }
  return v;
};
const historyUpdate=Component.prototype.componentDidUpdate;
Component.prototype.componentDidUpdate = function (...args) {
  historyUpdate.apply(this,args);
  if(typeof document==='undefined')return;
  const area=document.querySelector('[data-screen-label="Drafts"]');
  const line=area?.querySelector('textarea')?.closest('section')?.querySelector(':scope > p:last-child');
  if(line){line.setAttribute('role','button');line.tabIndex=0;line.onclick=()=>this._showDraftHistory();line.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();this._showDraftHistory();}};}
  area?.querySelectorAll('.field').forEach((field,i)=>{const input=field.querySelector('input,select,textarea'),label=field.querySelector('label');if(input&&label){input.id='draft-field-'+i;label.htmlFor=input.id;}});
};

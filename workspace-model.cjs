// Shared calculations for the exported snapshot and the browser controls.
const workspaceModel = {
  date(value) {
    const raw=String(value??'').trim();
    if(!raw)return null;
    if(/^\d{5}(?:\.\d+)?$/.test(raw))return new Date(Date.UTC(1899,11,30)+Math.floor(Number(raw))*86400000).toISOString().slice(0,10);
    const month=/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2}|\d{4})$/i.exec(raw);
    if(month)return (month[2].length===2?'20':'')+month[2]+'-'+String(['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(month[1].toLowerCase())+1).padStart(2,'0')+'-01';
    const iso=/^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(raw);
    return iso&&Number.isFinite(Date.parse(iso[1]))&&new Date(iso[1]+'T12:00:00Z').toISOString().startsWith(iso[1])?iso[1]:null;
  },
  closeLabel(value) {
    const date=this.date(value);if(!date)return 'Not entered';
    const monthOnly=/^[a-z]{3}\s+\d{2,4}$/i.test(String(value).trim());
    return new Date(date+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',...(monthOnly?{}:{day:'numeric'}),year:'numeric',timeZone:'UTC'});
  },
  weighted(row) {return row.amount==null||row.probability==null?null:row.amount*row.probability;},
  compareLeads(a,b) {
    const left=this.date(a.lead),right=this.date(b.lead),tie=()=>a.name.localeCompare(b.name)||String(a.id).localeCompare(String(b.id));
    if(left==null||right==null)return left==null&&right==null?tie():left==null?1:-1;
    return right.localeCompare(left)||tie();
  },
  compare(a,b,sort) {
    const tie=()=>a.name.localeCompare(b.name)||String(a.id).localeCompare(String(b.id));
    if(sort==='name')return tie();
    const left=sort==='close'?this.date(a.close):sort==='days'?a.days:this.weighted(a);
    const right=sort==='close'?this.date(b.close):sort==='days'?b.days:this.weighted(b);
    if(left==null||right==null)return left==null&&right==null?tie():left==null?1:-1;
    return (sort==='close'?left.localeCompare(right):right-left)||tie();
  },
  interaction(company,through) {
    const candidates=[...(company.lastContact?[{date:company.lastContact,source:'CRM last contact',refs:company.refs||[]}]:[]),...(company.completedInteractions||[])];
    return candidates.map(r=>({...r,date:this.date(r.date)})).filter(r=>r.date&&r.date<=through).sort((a,b)=>b.date.localeCompare(a.date)||a.source.localeCompare(b.source))[0]||null;
  },
  ownerContext(priority,records,through) {
    const companies=(priority.accountIds||[]).map(id=>records.companies.find(c=>c.id===id.replace(/^company:/,''))).filter(Boolean);
    const deals=companies.flatMap(c=>c.deals.filter(d=>d.closed===false));
    const owners=[...new Set(deals.map(d=>d.owner||'Unassigned'))].sort();
    const refs=deals.flatMap(d=>d.refs||[]);
    const interactions=companies.map(c=>this.interaction(c,through)).filter(Boolean).sort((a,b)=>b.date.localeCompare(a.date));
    const interaction=interactions[0]||null;
    const account=!!priority.accountIds?.length;
    return {owner:account?(owners.join(', ')||'Unassigned'):(priority.owner||'Unassigned'),ownerRefs:refs,interaction,account};
  },
  order(priorities,ratings) {
    const important=[],unrated=[],less=[];
    for(const p of priorities){const rating=ratings?.[p.id];(rating==='important'?important:rating==='not-important'?less:unrated).push(p);}
    return {main:[...important,...unrated],less};
  },
  modeInstructions(mode) {
    return mode==='marketing'
      ? 'Write marketing and prospect content. Use broader positioning and supported planned capabilities, preserving whether each capability is available, in development or planned. Do not describe an unreleased capability as available.'
      : 'Write customer-success content using verified available capabilities and the Opstream user guide. Give literal operational guidance. Preserve uncertainty and do not promise an unreleased capability.';
  }
};
if(typeof module!=='undefined')module.exports=workspaceModel;

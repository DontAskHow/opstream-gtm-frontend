// Shared calculations for the exported snapshot and the browser controls.
// Headline numbers (pipeline, lead counts, quiet days, unworked leads) are computed
// here and only here. Generators and the assistant describe these results;
// they do not invent a second figure. Dates are America/Phoenix calendar dates.
const workspaceModel = {
  PHOENIX: 'America/Phoenix',
  QUIET_DAYS: 14,
  // One formatter per shape. Constructing Intl.DateTimeFormat per date retains
  // ICU data until the process is huge; the open-book walk hits this thousands of times.
  fmt(name, locale, options) {
    const cache=this._fmt||(this._fmt=Object.create(null));
    return cache[name]||(cache[name]=new Intl.DateTimeFormat(locale, options));
  },
  date(value) {
    const raw=String(value??'').trim();
    if(!raw)return null;
    if(/^\d{5}(?:\.\d+)?$/.test(raw))return new Date(Date.UTC(1899,11,30)+Math.floor(Number(raw))*86400000).toISOString().slice(0,10);
    const month=/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2}|\d{4})$/i.exec(raw);
    if(month)return (month[2].length===2?'20':'')+month[2]+'-'+String(['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(month[1].toLowerCase())+1).padStart(2,'0')+'-01';
    const iso=/^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(raw);
    return iso&&Number.isFinite(Date.parse(iso[1]))&&new Date(iso[1]+'T12:00:00Z').toISOString().startsWith(iso[1])?iso[1]:null;
  },
  phoenixToday(now=new Date()) {
    return this.fmt('day','en-CA',{timeZone:this.PHOENIX,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  },
  phoenixHour(now=new Date()) {
    return Number(this.fmt('hour','en-US',{timeZone:this.PHOENIX,hour:'numeric',hourCycle:'h23'}).format(now));
  },
  // Calendar date in Phoenix. A date-only string is kept as written so it is
  // not shifted into the previous day by a UTC conversion.
  dateOnly(value) {
    if(value==null||value==='')return null;
    const raw=String(value).trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return raw;
    const parsed=Date.parse(raw.length===16?raw+':00Z':raw);
    if(Number.isFinite(parsed))return this.fmt('day','en-CA',{timeZone:this.PHOENIX,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(parsed));
    return this.date(raw);
  },
  addDays(iso,n) {
    const [y,m,d]=iso.split('-').map(Number);
    return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10);
  },
  formatDate(value) {
    const d=this.dateOnly(value);if(!d)return '—';
    const [y,m,day]=d.split('-').map(Number);
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]+' '+day+', '+y;
  },
  formatDateTime(value) {
    const raw=String(value??'').trim();if(!raw)return '—';
    if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return this.formatDate(raw);
    const parsed=Date.parse(raw.length===16?raw+':00Z':raw);
    if(!Number.isFinite(parsed))return this.formatDate(raw);
    const when=new Date(parsed);
    const date=this.fmt('stampDate','en-US',{timeZone:this.PHOENIX,month:'short',day:'numeric',year:'numeric'}).format(when);
    const time=this.fmt('stampTime','en-US',{timeZone:this.PHOENIX,hour:'numeric',minute:'2-digit'}).format(when);
    return date+' · '+time+' Phoenix';
  },
  // CRM notes are stored as HTML. Show the words, never the tags or scripts.
  plainNote(value) {
    let s=String(value??'');
    if(!/<[a-z!/]/i.test(s))return s;
    s=s.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'');
    s=s.replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi,'\n');
    s=s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi,'$1 ');
    s=s.replace(/<[^>]+>/g,'');
    s=s.replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'");
    return s.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').replace(/[ \t]{2,}/g,' ').trim();
  },
  formatTime(value) {
    const raw=String(value??'').trim();if(!raw)return '';
    const parsed=Date.parse(raw.length===16?raw+':00Z':raw);
    if(!Number.isFinite(parsed))return '';
    return this.fmt('stampTime','en-US',{timeZone:this.PHOENIX,hour:'numeric',minute:'2-digit'}).format(new Date(parsed))+' Phoenix';
  },
  greeting(now=new Date()) {
    const hour=this.phoenixHour(now);
    if(hour<12)return 'Good morning';
    if(hour<17)return 'Good afternoon';
    return 'Good evening';
  },
  alignGreeting(text,now=new Date()) {
    const g=this.greeting(now);
    const raw=String(text||'').trim();
    return raw?raw.replace(/\bgood\s+(morning|afternoon|evening)\b/ig,g):g;
  },
  // One label everywhere: a person's name, or Unassigned. A raw HubSpot id is
  // never shown. "Owner Owner 1234" is the same id twice.
  ownerInfo(value) {
    let s=String(value??'').trim();
    if(!s||/^unassigned$/i.test(s))return {label:'Unassigned', title:'', key:'Unassigned', named:true};
    const stripped=s.replace(/^(owner\s+)+/i,'').trim();
    if(!stripped)return {label:'Unassigned', title:'', key:'Unassigned', named:true};
    if(/^owner name not connected$/i.test(stripped))return {label:'Owner name not connected', title:"Owner name isn't connected", key:'Owner name not connected', named:false};
    const book=this.ownerCatalog||{};
    const hit=book[stripped]||book[s]||book[String(stripped).toLowerCase()];
    if(typeof hit==='string'&&hit.trim())return {label:this.canonicalPerson(hit.trim()), title:'', key:stripped, named:true};
    if(/^\d+$/.test(stripped)||/^[a-f0-9-]{8,}$/i.test(stripped))return {label:'Unassigned', title:'This HubSpot owner has no name in the owners list', key:'Unassigned', named:false};
    const person=this.canonicalPerson(this.personLabel(stripped));
    return {label:person, title:'', key:person, named:true};
  },
  // "Doug", "doug.daniels@opstream.ai" and "Doug Daniels" are one person when
  // the collected directory has exactly one full name for them.
  canonicalPerson(label) {
    const raw=String(label||'').trim();
    const names=[...new Set([...(this.people||[]).map(p=>p&&p.name),...Object.values(this.ownerCatalog||{})].filter(n=>typeof n==='string'&&n.trim()).map(n=>n.trim()))];
    if(!raw||!names.length)return raw;
    const low=raw.toLowerCase();
    if(low.includes('@')){
      const byEmail=(this.people||[]).find(p=>p&&String(p.email||'').toLowerCase()===low);
      if(byEmail)return byEmail.name;
      const local=low.split('@')[0].split(/[._-]+/)[0];
      const full=names.filter(n=>n.toLowerCase().split(/\s+/)[0]===local&&/\s/.test(n));
      return full.length===1?full[0]:raw;
    }
    if(/\s/.test(raw))return raw;
    const full=names.filter(n=>/\s/.test(n)&&n.toLowerCase().split(/\s+/)[0]===low);
    if(full.length===1)return full[0];
    return raw.charAt(0).toUpperCase()+raw.slice(1).toLowerCase();
  },
  displayOwner(value) {
    return this.ownerInfo(value).label;
  },
  resolveOwners(values) {
    return new Map((values||[]).map(v=>[String(v??''),this.ownerInfo(v)]));
  },
  // A trailing comma or semicolon on a CRM company name is not part of the name.
  // Keep endings such as "Inc." and names that end in an exclamation point.
  // 'Applied Materials,' and 'Mozilla Firefox 3.6' (a version number from a browser string) read as names.
  companyName(value) {
    return String(value??'').trim().replace(/[,;]+$/g,'').trim().replace(/\s+\d+(?:\.\d+)+$/,'').trim();
  },
  // HubSpot is the system the lead was stored in, not a marketing channel.
  sourceLabel(source) {
    const s=String(source??'').trim();
    if(!s||/^(hubspot|crm|integration|unknown|unknown source)$/i.test(s))return 'Unknown source';
    return s;
  },
  isTestRecord(deal) {
    const blob=[deal?.name,deal?.dealName,deal?.company,deal?.title,deal?.rationale].filter(Boolean).join(' ');
    return /system verification test/i.test(blob);
  },
  // The extract sometimes files one deal on two companies. Prefer the company whose name is the opportunity name.
  companyForOpportunity(opportunity,records) {
    if(!opportunity)return null;
    const companies=records?.companies||[];
    const holders=companies.filter(c=>(c.deals||[]).some(d=>d&&d.id===opportunity.id));
    const named=holders.find(c=>c.name===opportunity.name);
    if(named)return named;
    if(holders.length===1)return holders[0];
    const id=String(opportunity.companyId||'').replace(/^company:/,'');
    return companies.find(c=>c.id===id)||holders[0]||companies.find(c=>c.name===opportunity.name)||null;
  },
  // Older snapshots stored the company name on the opportunity and left the CRM deal name only on the record.
  // The same generator divided an already-fractional stage probability by 100, so every value sits at or below 0.02.
  annotateOpportunities(opportunities,records) {
    const byId=new Map();
    for(const company of records?.companies||[])for(const deal of company.deals||[])if(deal&&deal.id)byId.set(deal.id,deal);
    const positive=(opportunities||[]).map(o=>Number(o.probability)).filter(n=>Number.isFinite(n)&&n>0);
    const undoExtraDivision=positive.length>0&&Math.max(...positive)<=0.02;
    return (opportunities||[]).map(o=>{
      const deal=byId.get(o.id);
      let next=o;
      if(deal&&!o.dealName)next={...next,dealName:deal.name||''};
      if(undoExtraDivision&&o.probability!=null&&o.probability!==''){
        const n=Number(o.probability);
        if(Number.isFinite(n))next={...next,probability:n*100};
      }
      return next;
    });
  },
  // 'open' is a sheet-active row, including one whose close date has passed.
  // 'excluded' is everything else: On Hold, Disqualified, closed, renewal, or not on the sheet.
  listStatus(deal,today) {
    today=today||this.phoenixToday();
    // A past close date stays in the open pipeline but lists after current deals.
    if(this.isOpenPipeline(deal,today)){const close=this.dateOnly(deal.close);return close&&close<today?'past':'open';}
    return 'excluded';
  },
  closeLabel(value) {
    const date=this.dateOnly(value);if(!date)return 'Not entered';
    const monthOnly=/^[a-z]{3}\s+\d{2,4}$/i.test(String(value).trim());
    if(monthOnly)return this.formatDate(date).replace(/ \d+,/, ',');
    return this.formatDate(date);
  },
  // HubSpot stores stage probability as 0–1 or as 0–100. Values above 1 are percents.
  probabilityFraction(p) {
    if(p==null||p==='')return null;
    const n=Number(p);
    if(!Number.isFinite(n)||n<0)return null;
    return n>1?Math.min(n,100)/100:n;
  },
  weighted(row) {
    const amount=row.amount??row[3];
    const probability=row.probability!=null?row.probability:row[4];
    const fraction=this.probabilityFraction(probability);
    if(amount==null||fraction==null||!Number.isFinite(Number(amount)))return null;
    return Number(amount)*fraction;
  },
  periodBounds(period,customStart,customEnd,today) {
    today=today||this.phoenixToday();
    if(period==='six')return {start:this.addDays(today,-41),end:today,label:'Last 6 weeks'};
    if(period==='year')return {start:today.slice(0,4)+'-01-01',end:today,label:'Year to date'};
    if(period==='custom'){
      let a=customStart||this.addDays(today,-56),b=customEnd||today,reversed=false;
      if(a>b){reversed=true;const t=a;a=b;b=t;}
      return {start:a,end:b,label:'Custom',reversed};
    }
    const [y,m]=today.split('-').map(Number);
    const qm=Math.floor((m-1)/3)*3+1;
    return {start:y+'-'+String(qm).padStart(2,'0')+'-01',end:today,label:'Quarter to date'};
  },
  inRange(value,start,end) {
    const d=this.dateOnly(value);
    return !!d&&d>=start&&d<=end;
  },
  // Customer-success pipelines. Title text is only a fallback.
  RENEWAL_PIPELINE_IDS: {'855205465':true,'686463412':true},
  // A company titled only Renewal or Current agreement is not a company name.
  isPlaceholderName(value) {
    return /^(renewal|current agreement)$/i.test(String(value||'').trim());
  },
  pipelineId(deal) {
    return String((deal&&(deal.pipeline||deal.pipelineId))||'').trim();
  },
  isRenewalPipeline(deal) {
    return !!this.RENEWAL_PIPELINE_IDS[this.pipelineId(deal)];
  },
  stageBlob(deal) {
    return (String(deal&&(deal.stage||deal.stageLabel)||'')+' '+String(deal&&deal.dealName||'')).toLowerCase();
  },
  titleIsRenewal(deal) {
    const blob=this.stageBlob(deal);
    return /current agreement/.test(blob)||/\brenewal\b/.test(blob);
  },
  // Active stages on the master sheet are the new-business open book.
  SHEET_ACTIVE_STAGES: {
    'discovery/rfp received': true,
    'sql': true,
    'demo meeting': true,
    'decision': true,
    'wider stakeholders': true,
    'legal & compliance': true,
  },
  sheetClassName(stage) {
    const s=String(stage||'').toLowerCase().replace(/\s*\(deal\)\s*/g,'').trim();
    if(!s)return '';
    if(this.SHEET_ACTIVE_STAGES[s])return 'active';
    if(s==='on hold')return 'on hold';
    if(s.includes('disqual'))return 'disqualified';
    if(s.includes('closed'))return 'closed';
    return 'other';
  },
  sheetClass(deal) {
    const explicit=String(deal&&deal.sheetClass||'');
    if(explicit)return explicit;
    if(deal&&deal.onSheet)return this.sheetClassName(deal.stage||deal.stageLabel);
    return '';
  },
  closeDatePassed(deal, today) {
    const close=this.dateOnly(deal&&deal.close);
    return !!(close&&today&&close<today);
  },
  isRenewalRecord(deal) {
    if(this.sheetClass(deal)==='active')return false;
    return this.isRenewalPipeline(deal)||this.titleIsRenewal(deal);
  },
  companyKey(deal) {
    const cid=String(deal&&deal.companyId||'').trim();
    if(!cid||cid==='company:'||cid==='company:unknown')return '';
    return cid;
  },
  isLegacyPlaceholder(deal) {
    return this.pipelineId(deal)==='686463412'&&/^(renewal)$/i.test(String(deal&&deal.dealName||'').trim());
  },
  isRenewalAgreement(deal) {
    return this.pipelineId(deal)==='855205465'&&/renewal agreement/i.test(String(deal&&deal.dealName||''));
  },
  renewalCurrent(deal,today) {
    if(!deal||deal.closed===true||this.isTestRecord(deal))return false;
    const blob=this.stageBlob(deal);
    if(/closed\s*won|closed\s*lost|closedwon|closedlost/.test(blob))return false;
    if(/disqualif/.test(blob)||/\bon hold\b/.test(blob))return false;
    const close=this.dateOnly(deal.close);
    if(close&&today&&close<today)return false;
    return true;
  },
  // Current renewal/CS book. A legacy "Renewal" placeholder is not added when
  // that company already has a current Renewal Agreement. The placeholder
  // stays in duplicates.
  renewalBook(deals,today) {
    today=today||this.phoenixToday();
    const rows=(deals||[]).filter(d=>this.isRenewalRecord(d));
    const current=rows.filter(d=>this.renewalCurrent(d,today));
    const agreements=new Set(current.filter(d=>this.isRenewalAgreement(d)&&this.companyKey(d)).map(d=>this.companyKey(d)));
    const counted=[], duplicates=[];
    for(const deal of current){
      const key=this.companyKey(deal);
      if(this.isLegacyPlaceholder(deal)&&key&&agreements.has(key))duplicates.push(deal);
      else counted.push(deal);
    }
    let amount=0;
    for(const deal of counted){
      const amt=Number(deal.amount);
      if(Number.isFinite(amt))amount+=amt;
    }
    let pastClose=0;
    for(const deal of rows){
      if(deal.closed===true||this.isTestRecord(deal))continue;
      const blob=this.stageBlob(deal);
      if(/closed\s*won|closed\s*lost|closedwon|closedlost/.test(blob)||/disqualif/.test(blob)||/\bon hold\b/.test(blob))continue;
      const close=this.dateOnly(deal.close);
      if(close&&today&&close<today)pastClose+=1;
    }
    return {count:counted.length,amount,deals:counted,duplicates,pastClose};
  },
  // Company shown on a pipeline row. Associations win. A placeholder title is not a company.
  pipelineCompanyName(companyName, dealName, fallbackName) {
    const fromCompany=this.accountName(companyName, dealName);
    if(fromCompany&&this.isDomainName(fromCompany)&&this.dealLabel(dealName||fallbackName))return this.dealLabel(dealName||fallbackName);
    if(fromCompany)return fromCompany;
    const raw=this.companyName(companyName);
    if(raw&&!this.isPlaceholderName(raw))return raw;
    const other=this.companyName(fallbackName);
    if(other&&!this.isPlaceholderName(other))return other;
    return 'No company on the Sheet row';
  },
  renewalStage(deal) {
    const raw=String((deal&&(deal.stageLabel||deal.stage))||'').trim();
    const shown=this.stageDisplay(raw);
    if(this.isRenewalPipeline(deal)&&(!raw||raw==='No stage'||/^\d+$/.test(raw)||shown==='No stage'))return 'Stage name not synced';
    return shown;
  },
  // HubSpot-shaped open check. The sheet, not this function, defines the book.
  hubspotLooksOpen(deal,today) {
    if(!deal||deal.closed===true)return false;
    if(this.isTestRecord(deal))return false;
    const blob=this.stageBlob(deal);
    if(/closed\s*won|closed\s*lost|closedwon|closedlost/.test(blob))return false;
    if(/disqualif/.test(blob))return false;
    if(/\bon hold\b/.test(blob))return false;
    if(this.isRenewalPipeline(deal))return false;
    if(/current agreement/.test(blob))return false;
    if(/\brenewal\b/.test(blob))return false;
    if(this.closeDatePassed(deal,today))return false;
    return true;
  },
  // The open book is the master sheet's active new-business rows. A past close
  // date stays in the book. A renewal pipeline does not override the sheet.
  // A deal that is not on the sheet is not in the total.
  isOpenPipeline(deal,today) {
    return this.sheetClass(deal)==='active';
  },
  isHubspotOnlyOpen(deal,today) {
    if(this.sheetClass(deal))return false;
    if(this.isRenewalRecord(deal))return false;
    return this.hubspotLooksOpen(deal,today);
  },
  moneySum(deals) {
    let total=0;
    for(const deal of deals||[]){
      const amt=Number(deal.amount);
      if(Number.isFinite(amt))total+=amt;
    }
    return total;
  },
  onHoldBook(deals) {
    const rows=(deals||[]).filter(d=>this.sheetClass(d)==='on hold');
    return {count:rows.length,amount:this.moneySum(rows),deals:rows};
  },
  hubspotOnlyBook(deals,today) {
    today=today||this.phoenixToday();
    const rows=(deals||[]).filter(d=>this.isHubspotOnlyOpen(d,today));
    return {count:rows.length,amount:this.moneySum(rows),deals:rows};
  },
  exclusionReason(deal,today) {
    if(this.isOpenPipeline(deal,today))return null;
    const kind=this.sheetClass(deal);
    if(kind==='on hold')return 'On Hold';
    if(kind==='disqualified')return 'Disqualified';
    if(kind==='closed')return 'closed';
    if(this.isHubspotOnlyOpen(deal,today))return 'In HubSpot, not on the Sheet';
    if(deal&&deal.closed===true)return 'closed';
    if(this.isTestRecord(deal))return 'verification fixture';
    const blob=this.stageBlob(deal||{});
    if(/closed\s*won|closed\s*lost|closedwon|closedlost/.test(blob))return 'closed won or lost';
    if(/disqualif/.test(blob))return 'Disqualified';
    if(/\bon hold\b/.test(blob))return 'On Hold';
    if(this.isRenewalPipeline(deal)||/\brenewal\b/.test(blob))return 'renewal';
    if(/current agreement/.test(blob))return 'current agreement';
    if(this.closeDatePassed(deal,today))return 'past close date';
    return 'excluded';
  },
  stageDisplay(stage) {
    const s=String(stage||'').trim().replace(/ \(Deal\)$/,'');
    return s||'No stage';
  },
  pipelineTotals(opportunities,today) {
    today=today||this.phoenixToday();
    const deals=(opportunities||[]).filter(o=>this.isOpenPipeline(o,today));
    let openAmount=0,weightedSum=0,weightedKnown=false;
    const stages=new Map();
    for(const o of deals){
      const amt=Number(o.amount);
      const hasAmt=Number.isFinite(amt);
      if(hasAmt)openAmount+=amt;
      const w=this.weighted(o);
      if(w!=null){weightedSum+=w;weightedKnown=true;}
      const label=this.stageDisplay(o.stage);
      const g=stages.get(label)||{stage:label,count:0,amount:0};
      g.count+=1;g.amount+=hasAmt?amt:0;stages.set(label,g);
    }
    const stageRows=[...stages.values()].sort((a,b)=>b.amount-a.amount||a.stage.localeCompare(b.stage));
    return {deals,count:deals.length,openAmount,weighted:weightedKnown?weightedSum:null,stages:stageRows};
  },
  largestDeal(deals) {
    return [...(deals||[])].sort((a,b)=>(Number(b.amount)||0)-(Number(a.amount)||0)||String(a.name||'').localeCompare(String(b.name||'')))[0]||null;
  },
  closeDateShare(deals,close) {
    const day=this.dateOnly(close);
    const total=(deals||[]).length;
    if(!day)return {day:null,count:0,total};
    return {day,total,count:(deals||[]).filter(d=>this.dateOnly(d.close)===day).length};
  },
  commitVersusTarget(commit,target) {
    const c=Number(commit),t=Number(target);
    const money=n=>'$'+Math.round(n).toLocaleString('en-US');
    if(!Number.isFinite(c))return {relation:'unknown',text:null};
    if(!Number.isFinite(t)||t<=0)return {relation:'unknown',text:money(c)+' commit · no forecast target connected'};
    if(c>t)return {relation:'ahead',gap:c-t,text:money(c)+' commit is ahead of the '+money(t)+' forecast by '+money(c-t)};
    if(c===t)return {relation:'met',gap:0,text:money(c)+' commit meets the '+money(t)+' forecast'};
    return {relation:'short',gap:t-c,text:money(c)+' commit is short of the '+money(t)+' forecast by '+money(t-c)};
  },
  // Last past engagement for a company. Future meetings do not count.
  lastEngagement(company,today) {
    if(!company)return null;
    today=today||this.phoenixToday();
    const dates=[];
    const push=v=>{const d=this.dateOnly(v);if(d&&d<=today)dates.push(d);};
    for(const it of company.completedInteractions||[])push(it.date);
    for(const n of company.notes||[])push(n.date);
    for(const c of company.calls||[])push(c.date);
    for(const m of company.meetings||[])push(m.start);
    for(const r of company.recordings||[])push(r.date);
    for(const e of (company.emails&&company.emails.items)||[])push(e.date);
    push(company.lastContact);
    dates.sort();
    return dates.length?dates[dates.length-1]:null;
  },
  daysQuiet(company,today) {
    today=today||this.phoenixToday();
    const last=typeof company==='string'?this.dateOnly(company):this.lastEngagement(company,today);
    if(!last||last>today)return null;
    return Math.round((Date.parse(today+'T12:00:00Z')-Date.parse(last+'T12:00:00Z'))/86400000);
  },
  quietDeals(opportunities,records,today) {
    today=today||this.phoenixToday();
    const companies=records?.companies||[];
    const find=o=>this.companyForOpportunity(o,{companies});
    return this.pipelineTotals(opportunities,today).deals.map(o=>{
      const company=find(o);
      return {...o,companyRecord:company,lastEngagement:company?this.lastEngagement(company,today):null,daysQuiet:company?this.daysQuiet(company,today):null};
    }).filter(o=>o.daysQuiet==null||o.daysQuiet>=this.QUIET_DAYS);
  },
  // One set of lead rows for every surface: the Lead Tracker when it is in the
  // collection, otherwise HubSpot contacts. Subscribers and unnamed rows are not leads.
  trackerRows(sheetReview,contacts) {
    const sheet=(sheetReview&&sheetReview.leads)||[];
    const base=sheet.length?sheet:(contacts||[]);
    return base.filter(r=>{const note=String(r.note||'').trim().toLowerCase();const name=String(r.company||r.name||'').trim();return note!=='subscriber'&&!note.includes('newsletter')&&name&&!name.includes('@');})
      .map(r=>({id:r.id,name:String(r.displayName||r.company||r.name).trim(),trackerName:String(r.company||r.name).trim(),flags:r.flags||{hot:false,dead:false},source:this.sourceLabel(r.source),owner:this.leadOwner(r.owner),lead:this.dateOnly(r.lead||r.leadDate),mql:this.dateOnly(r.mql),sql:this.dateOnly(r.sql),note:r.note,contact:r.contact||null,sheetRow:r.sheetRow||null}));
  },
  // An owner name, or '' when the tracker says nobody owns the lead.
  HUBSPOT_PORTAL:'21303277',
  leadOwner(value) {
    const raw=String(value??'').trim();
    if(/^(|not assigned|unassigned|customer|none|-)$/i.test(raw))return '';
    return /^[a-z]+$/i.test(raw)?raw.charAt(0).toUpperCase()+raw.slice(1).toLowerCase():raw;
  },
  // Recorded spend over a window divided by its leads. Monthly actuals are
  // spread evenly over their days. A month with no actuals makes it unknown.
  costPerLead(months,start,end,leads) {
    const names=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const byMonth=new Map((months||[]).map(m=>[m.month,m]));
    let spend=0;const missing=[];
    for(let at=start.slice(0,7);at<=end.slice(0,7);){
      const [y,mo]=at.split('-').map(Number),days=new Date(Date.UTC(y,mo,0)).getUTCDate();
      const first=at+'-01',last=at+'-'+String(days).padStart(2,'0');
      const from=start>first?start:first,to=end<last?end:last;
      const overlap=Math.round((Date.parse(to)-Date.parse(from))/86400000)+1;
      const row=byMonth.get(at);
      if(!row||row.actual==null)missing.push(names[mo-1]);else spend+=row.actual*overlap/days;
      at=mo===12?(y+1)+'-01':y+'-'+String(mo+1).padStart(2,'0');
    }
    if(missing.length)return {cpl:'needs '+missing.join(' and ')+' actuals',cplNote:''};
    if(!leads)return {cpl:'no leads in this window',cplNote:''};
    return {cpl:'$'+Math.round(spend/leads).toLocaleString('en-US'),cplNote:'Recorded spend spread by day.'};
  },
  // The numbers Hollie opens with. Every figure comes from collected data; a
  // missing target says so rather than inventing one.
  kpiSummary({opportunities, records, trackerRows, marketing, sheetReview, today}) {
    today=today||this.phoenixToday();
    const book=this.pipelineTotals(opportunities,today);
    const q=this.periodBounds('quarter',null,null,today);
    const quarter=this.leadCounts(trackerRows,q.start,q.end);
    const thisWeek=this.leadCounts(trackerRows,this.addDays(today,-6),today);
    const lastWeek=this.leadCounts(trackerRows,this.addDays(today,-13),this.addDays(today,-7));
    const change=k=>({now:thisWeek[k],before:lastWeek[k],delta:thisWeek[k]-lastWeek[k]});
    const month=today.slice(0,7),buckets=((sheetReview&&sheetReview.forecast)||{}).buckets||{};
    const commitTarget=((buckets.commit||{}).targets||{})[month];
    const commitStages=((buckets.commit||{}).stages||[]).map(x=>String(x).toLowerCase());
    const commitDeals=book.deals.filter(d=>this.dateOnly(d.close)&&this.dateOnly(d.close).slice(0,7)===month&&this.dateOnly(d.close)>=today&&commitStages.some(st=>String(d.stageLabel||d.stage||'').toLowerCase().includes(st)));
    // By owner: open pipeline (Sheet owner), completed CRM meetings this quarter, leads' MQL and SQL this quarter.
    const owners=new Map(),row=name=>{const k=this.displayOwner(name);if(!owners.has(k))owners.set(k,{owner:k,deals:0,amount:0,weighted:0,meetings:0,mql:0,sql:0});return owners.get(k);};
    for(const d of book.deals){const r=row(d.owner);r.deals++;r.amount+=Number(d.amount)||0;r.weighted+=this.weighted(d)||0;}
    for(const m of this.activityFromRecords(records).meetings)if(this.inRange(m.start,q.start,q.end)&&/complete/i.test(m.outcome||''))row(m.owner).meetings++;
    for(const l of trackerRows||[]){if(this.inRange(l.mql,q.start,q.end))row(l.owner).mql++;if(this.inRange(l.sql,q.start,q.end))row(l.owner).sql++;}
    const byOwner=[...owners.values()].filter(r=>r.deals||r.meetings||r.mql||r.sql).sort((a,b)=>b.amount-a.amount||b.meetings-a.meetings);
    // Marketing-sourced: an open deal whose company is on the Lead Tracker.
    const key=v=>String(v||'').toLowerCase().replace(/\b(inc|llc|ltd|gmbh|corp|corporation|co|plc|sa|ag|limited|group)\b/g,'').replace(/[^a-z0-9]/g,'');
    const leadByKey=new Map();for(const l of trackerRows||[]){const k=key(l.trackerName||l.name);if(k&&!leadByKey.has(k))leadByKey.set(k,l);}
    const sourced=book.deals.map(d=>({deal:d,lead:leadByKey.get(key(d.name))||leadByKey.get(key(d.companyRecord&&d.companyRecord.name))})).filter(x=>x.lead);
    // Won and lost this quarter: closed HubSpot deals on the accounts in this collection.
    const closed=(records&&records.companies||[]).flatMap(c=>(c.deals||[]).filter(d=>d.closed&&this.inRange(d.close,q.start,q.end)).map(d=>({...d,company:c.name})));
    const won=closed.filter(d=>/won/i.test(d.stageLabel||d.stage||'')),lost=closed.filter(d=>/lost/i.test(d.stageLabel||d.stage||''));
    const sum=list=>list.reduce((a,d)=>a+(Number(d.amount)||0),0);
    const spend=(marketing&&marketing.spend)||{};
    const roi=((marketing&&marketing.shows)||{}).eventRoi||{rows:[]};
    return {today,quarter:q,book:{count:book.count,amount:book.openAmount,weighted:book.weighted},
      commit:{amount:sum(commitDeals),deals:commitDeals.map(d=>this.companyName(d.name)),target:commitTarget==null?null:commitTarget},
      leads:{quarter,week:{leads:change('leads'),mql:change('mql'),sql:change('sql')},targets:null},
      byOwner,sourced:{count:sourced.length,amount:sum(sourced.map(x=>x.deal)),rows:sourced.map(x=>({company:this.companyName(x.deal.name),amount:x.deal.amount,source:this.sourceLabel(x.lead.source),leadDate:this.firstTouch(x.lead)}))},
      won:{count:won.length,amount:sum(won),rows:won.map(d=>({company:d.company,amount:d.amount,close:d.close}))},
      lost:{count:lost.length,amount:sum(lost),rows:lost.map(d=>({company:d.company,amount:d.amount,close:d.close}))},
      spend:{text:this.spendVersusPlan(spend),connected:!!spend.connected},
      events:roi.rows||[]};
  },
  // 'Applied Materials, - New Deal' -> 'Applied Materials'; 'Known - New Deal' -> 'Known'.
  dealLabel(name) {
    return String(name??'').replace(/\s*[-–—]\s*new deal\b.*$/i,'').replace(/\s+/g,' ').trim().replace(/[,;]+$/,'').trim();
  },
  // A domain used as a company name ('tapi.com') is not a name.
  isDomainName(value) {
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(value??'').trim());
  },
  // Markdown links and escapes from pasted notes, as plain words.
  plainMarkdown(text) {
    return String(text??'').replace(/\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]*)\]\(\[?link:[^)]*\)?/gi,'$1').replace(/\\([~*_`#[\]()-])/g,'$1').replace(/\*\*([^*]+)\*\*/g,'$1').replace(/(^|\s)\[(?=\S)/g,'$1').replace(/\s{2,}/g,' ').trim();
  },
  // 'COMPUTER_SOFTWARE' -> 'Computer software'.
  humanEnum(value) {
    const t=String(value??'').trim();if(!t)return '';
    return /^[A-Z0-9_]+$/.test(t)?t.charAt(0)+t.slice(1).toLowerCase().replace(/_/g,' '):t;
  },
  // Model prose with raw ISO timestamps rewritten as Phoenix times.
  phoenixProse(text) {
    return String(text??'').replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,m=>this.formatDateTime(m));
  },
  // 'maya graff' and 'Maya Graff' are one person.
  personLabel(value) {
    let raw=String(value??'').replace(/\s+/g,' ').trim();
    if(raw&&raw===raw.toLowerCase()&&!raw.includes('@'))raw=raw.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
    return raw;
  },
  naturalDay(iso) {
    const d=this.dateOnly(iso);if(!d)return '';
    const [,m,day]=d.split('-').map(Number);
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]+' '+day;
  },
  // Whoever ran the call. Fathom sometimes stores only the host's email.
  // One person, one label: the HubSpot owner name when exactly one owner has that first name.
  callOwner(recording, records) {
    const owners=Object.values((records&&records.owners)||{}).map(String);
    const asOwner=name=>{const first=String(name||'').split(/\s+/)[0].toLowerCase();const hit=owners.filter(n=>n.split(/\s+/)[0].toLowerCase()===first);return hit.length===1?this.personLabel(hit[0]):this.personLabel(name);};
    const who=this.personLabel(recording&&recording.recordedBy);
    if(!who.includes('@'))return asOwner(who);
    const email=who.toLowerCase();
    const all=[recording,...((records&&records.companies)||[]).flatMap(c=>c.recordings||[])];
    for(const r of all)for(const i of (r&&r.invitees)||[])if(String(i.email||'').toLowerCase()===email&&i.name&&!i.name.includes('@'))return asOwner(i.name);
    return asOwner(email.split('@')[0].split('.')[0]);
  },
  teamFirstNames(records) {
    const out=new Set();
    for(const n of Object.values((records&&records.owners)||{}))if(String(n).trim())out.add(String(n).trim().split(/\s+/)[0].toLowerCase());
    for(const c of (records&&records.companies)||[])for(const r of c.recordings||[]){
      const host=this.personLabel(r.recordedBy);if(host&&!host.includes('@'))out.add(host.split(' ')[0].toLowerCase());
      for(const i of r.invitees||[])if(/@opstream\.ai$/i.test(i.email||'')&&i.name)out.add(String(i.name).split(/\s+/)[0].toLowerCase());
    }
    return [...out].filter(n=>n.length>=3);
  },
  // An item for our own team ('Send missing Drive doc to Maya', 'Ping Martin re: code change').
  internalTodo(action, teamFirst) {
    const text=String(action||'');
    if(/\binternal(?:ly)?\b|\bslack\b|\bjira\b|\bticket\b/i.test(text))return true;
    return (teamFirst||[]).some(first=>new RegExp('\\b(?:to|with|ping|ask|tell|remind|loop in|sync with|cc|for)\\s+'+first.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i').test(text));
  },
  // An action item written to the customer, in the second person.
  customerCopy(action, guests) {
    const esc=t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    let text=String(action||'').trim().replace(/\\([~*_`#[\]()-])/g,'$1');
    for(const g of guests||[]){
      const name=String(g.name||'').trim();if(!name)continue;const first=name.split(/\s+/)[0];
      text=text.replace(new RegExp('^(?:email|send|follow up with|share with|reply to)\\s+'+esc(name)+'\\b[:,]?\\s*(?:the\\s+|a\\s+)?','i'),'');
      text=text.replace(new RegExp('^(?:'+esc(name)+'|'+esc(first)+')\\s+(?:to|will)\\s+','i'),"You'll ");
      text=text.replace(new RegExp('\\b(?:'+esc(name)+'|'+esc(first)+')\\b','g'),'you').replace(/\b(?:she|he)'ll\b/gi,"you'll");
    }
    text=text.replace(/^(?:opstream|we)\s+(?:to|will)\s+/i,"We'll ");
    if(/^(?:email|send|fix|backfill|update|share|schedule|set up|book|prepare|draft|follow up|confirm|provide|review)\b/i.test(text))text="We'll "+text.charAt(0).toLowerCase()+text.slice(1);
    return text.charAt(0).toUpperCase()+text.slice(1);
  },
  // Records carry closed:true|false. A stage named Closed … is closed either way.
  dealIsOpen(deal) {
    if(!deal)return false;
    if(deal.closed===true)return false;
    return !/^closed\b/i.test(String(deal.stageLabel||deal.stage||''));
  },
  // HubSpot record pages for deal, company and contact refs ('hubspot:deals:123').
  hubspotLinks(refs) {
    const types={deals:['0-3','deal'],companies:['0-2','company'],contacts:['0-1','contact']};
    const out=[];
    for(const ref of [].concat(refs||[])){
      const m=String(ref||'').match(/^hubspot:(deals|companies|contacts):(\d+)$/);
      if(!m)continue;
      const url='https://app.hubspot.com/contacts/'+this.HUBSPOT_PORTAL+'/record/'+types[m[1]][0]+'/'+m[2];
      if(!out.some(l=>l.url===url))out.push({url,label:'HubSpot '+types[m[1]][1]+' '+m[2],kind:types[m[1]][1]});
    }
    return out;
  },
  hubspotUrl(refs, kind) {
    const hit=this.hubspotLinks(refs).find(l=>!kind||l.kind===kind);
    return hit?hit.url:'';
  },
  // no-mql, mql-no-sql or sql: the Lead Tracker stage a row has reached.
  leadStage(row) {
    if(!row.mql)return 'no-mql';
    return row.sql?'sql':'mql-no-sql';
  },
  firstTouch(row) {
    const days=[row.lead,row.mql,row.sql].filter(Boolean).sort();
    return days[0]||null;
  },
  // Lead Tracker definitions: a lead counts on its first stage date; MQL and SQL on their own dates.
  leadCounts(rows,start,end) {
    const inR=v=>!!v&&v>=start&&v<=end;
    const by=new Map();
    const slot=name=>{if(!by.has(name))by.set(name,{channel:name,leads:0,mql:0,sql:0});return by.get(name);};
    for(const r of rows||[]){
      if(inR(this.firstTouch(r)))slot(r.source).leads++;
      if(inR(r.mql))slot(r.source).mql++;
      if(inR(r.sql))slot(r.source).sql++;
    }
    const sources=[...by.values()].sort((a,b)=>b.leads-a.leads||b.mql-a.mql||b.sql-a.sql||a.channel.localeCompare(b.channel));
    return {leads:sources.reduce((n,c)=>n+c.leads,0),mql:sources.reduce((n,c)=>n+c.mql,0),sql:sources.reduce((n,c)=>n+c.sql,0),sources};
  },
  unworkedRows(rows) {
    return (rows||[]).filter(r=>!r.mql);
  },
  activityFromRecords(records) {
    const meetings=[],recordings=[];
    const seenMeetings=new Set(),seenRecordings=new Set();
    const addMeeting=(m,c)=>{
      const id=m.id||(c.id+'|'+String(m.start||'')+'|'+(m.title||''));
      if(seenMeetings.has(id))return;
      seenMeetings.add(id);
      meetings.push({id:m.id||null,start:m.start,booked:m.booked||m.created||m.start,outcome:m.outcome||'',companyId:c.id,companyName:c.name,title:m.title||'',owner:m.owner||c.owner||''});
    };
    const addRecording=(r,c)=>{
      const id=r.id||((c?c.id:'')+'|'+String(r.date||''));
      if(seenRecordings.has(id))return;
      seenRecordings.add(id);
      recordings.push({id:r.id||null,date:r.date,companyId:c?c.id:null,companyName:c?c.name:(r.companyName||''),title:r.title||'',recordedBy:r.recordedBy||''});
    };
    for(const c of records?.companies||[]){
      for(const m of c.meetings||[])addMeeting(m,c);
      for(const r of c.recordings||[])addRecording(r,c);
    }
    for(const r of records?.unmatchedRecordings||[])addRecording(r,null);
    return {meetings,recordings};
  },
  weekStart(today) {
    today=today||this.phoenixToday();
    const sinceMonday=(new Date(today+'T12:00:00Z').getUTCDay()+6)%7;
    return this.addDays(today,-sinceMonday);
  },
  formatMetric(n,average) {
    if(!Number.isFinite(n))return '—';
    if(!average)return Math.round(n).toLocaleString('en-US');
    return (Math.round(n*10)/10).toFixed(1);
  },
  marketingView(rows,today) {
    today=today||this.phoenixToday();
    const quarter=this.periodBounds('quarter',null,null,today);
    const windows=[
      {key:'week',label:'Last 7 days',start:this.addDays(today,-6),end:today,average:false,weeks:1},
      {key:'six',label:'6-week average',start:this.addDays(today,-41),end:today,average:true,weeks:6},
      {key:'quarter',label:'Quarter to date',start:quarter.start,end:quarter.end,average:false,weeks:1}
    ];
    const blocks=windows.map(w=>({...w,counts:this.leadCounts(rows,w.start,w.end)}));
    const names=[];
    for(const b of blocks)for(const c of b.counts.sources)if(!names.includes(c.channel))names.push(c.channel);
    const cell=(b,name,k)=>{const row=b.counts.sources.find(c=>c.channel===name);return row?row[k]:0;};
    const sources=names.map(name=>({
      channel:name,
      week:this.formatMetric(cell(blocks[0],name,'leads'),false),
      six:this.formatMetric(cell(blocks[1],name,'leads')/6,true),
      quarter:this.formatMetric(cell(blocks[2],name,'leads'),false),
      quarterMql:cell(blocks[2],name,'mql'),quarterSql:cell(blocks[2],name,'sql')
    })).sort((a,b)=>Number(b.quarter.replace(/,/g,''))-Number(a.quarter.replace(/,/g,''))||a.channel.localeCompare(b.channel));
    return {
      intervals:blocks.map(b=>({
        key:b.key,label:b.label,start:b.start,end:b.end,leadTotal:b.counts.leads,range:this.formatDate(b.start)+' – '+this.formatDate(b.end),
        leads:this.formatMetric(b.counts.leads/(b.average?6:1),b.average),
        mql:this.formatMetric(b.counts.mql/(b.average?6:1),b.average),
        sql:this.formatMetric(b.counts.sql/(b.average?6:1),b.average),
        total:b.counts,
        note:b.average?'Per week over the last 42 days. Not the six-week total.':''
      })),
      sources
    };
  },
  compareLeads(a,b) {
    const left=this.date(this.firstTouch(a)),right=this.date(this.firstTouch(b)),tie=()=>a.name.localeCompare(b.name)||String(a.id).localeCompare(String(b.id));
    if(left==null||right==null)return left==null&&right==null?tie():left==null?1:-1;
    return right.localeCompare(left)||tie();
  },
  compare(a,b,sort,today) {
    today=today||this.phoenixToday();
    const tie=()=>String(a.name||'').localeCompare(String(b.name||''))||String(a.id).localeCompare(String(b.id));
    const past=row=>this.listStatus(row,today)==='past'?1:0;
    const pastDiff=past(a)-past(b);
    if(pastDiff)return pastDiff;
    if(sort==='name')return tie();
    if(sort==='interaction'){
      const left=this.dateOnly(a.lastEngagement),right=this.dateOnly(b.lastEngagement);
      if(left==null||right==null)return left==null&&right==null?tie():left==null?1:-1;
      return right.localeCompare(left)||tie();
    }
    if(sort==='close'){
      const left=this.dateOnly(a.close),right=this.dateOnly(b.close);
      if(left==null||right==null)return left==null&&right==null?tie():left==null?1:-1;
      return left.localeCompare(right)||tie();
    }
    if(sort==='days'){
      const left=Number(a.days),right=Number(b.days);
      if(!Number.isFinite(left)||!Number.isFinite(right))return Number.isFinite(left)?-1:Number.isFinite(right)?1:tie();
      return right-left||tie();
    }
    // Amount, not probability. A 0–1% HubSpot probability must not decide the order.
    return (Number(b.amount)||0)-(Number(a.amount)||0)||tie();
  },
  interaction(company,through) {
    const candidates=[...(company.lastContact?[{date:company.lastContact,source:'CRM last contact',refs:company.refs||[]}]:[]),...(company.completedInteractions||[])];
    return candidates.map(r=>({...r,date:this.date(r.date)})).filter(r=>r.date&&r.date<=through).sort((a,b)=>b.date.localeCompare(a.date)||a.source.localeCompare(b.source))[0]||null;
  },
  ownerContext(priority,records,through) {
    const companies=(priority.accountIds||[]).map(id=>records.companies.find(c=>c.id===id.replace(/^company:/,''))).filter(Boolean);
    const deals=companies.flatMap(c=>c.deals.filter(d=>d.closed===false));
    const owners=[...new Set(deals.map(d=>this.displayOwner(d.owner)))].sort();
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
  asOf(generatedAt) {
    return this.dateOnly(generatedAt)||this.phoenixToday();
  },
  snapshotAge(generatedAt, now=new Date()) {
    const t=Date.parse(generatedAt);
    if(!Number.isFinite(t))return null;
    return (now.getTime()-t)/3600000;
  },
  relativeDays(iso, today) {
    today=today||this.phoenixToday();
    const d=this.dateOnly(iso);
    if(!d)return null;
    const [y,m,day]=d.split('-').map(Number);
    const [Y,M,D]=today.split('-').map(Number);
    return Math.round((Date.UTC(Y,M-1,D)-Date.UTC(y,m-1,day))/86400000);
  },
  relativeLabel(iso, today) {
    const n=this.relativeDays(iso, today);
    if(n==null)return '';
    if(n===0)return 'today';
    if(n===1)return 'yesterday';
    if(n>1)return n+' days ago';
    if(n===-1)return 'tomorrow';
    return 'in '+(-n)+' days';
  },
  sheetOverrides(review) {
    const out=new Map();
    const slot=id=>{const k=String(id||'').replace(/^deal-/,''); if(!k)return null; if(!out.has(k))out.set(k,{}); return out.get(k);};
    const money=v=>{const n=Number(String(v??'').replace(/[^0-9.\-]/g,'')); return Number.isFinite(n)&&String(v??'').replace(/[^0-9.\-]/g,'')!==''?n:null;};
    for(const row of (review&&review.mismatches)||[]){
      const s=slot(row.dealId); if(!s)continue;
      const field=String(row.field||'').toLowerCase();
      if(field==='amount'){const n=money(row.sheet); if(n!=null){s.amount=n; s.hubspotAmount=money(row.hubspot);}}
      else if(field.includes('close')){s.close=this.dateOnly(row.sheet)||row.sheet; s.hubspotClose=row.hubspot;}
      else if(field==='stage'){s.stage=String(row.sheet||'').split(' (')[0].trim(); s.hubspotStage=row.hubspot;}
    }
    for(const deal of (review&&review.deals)||[]){
      const s=slot(deal.id); if(!s)continue;
      if(deal.amount!=null)s.amount=Number(deal.amount);
      if(deal.close)s.close=this.dateOnly(deal.close)||deal.close;
      if(deal.stage)s.stage=String(deal.stage).split(' (')[0].trim();
      if(deal.owner)s.owner=String(deal.owner).trim();
      if(deal.company)s.company=String(deal.company).trim();
      if(deal.probability!=null&&deal.probability!=='')s.probability=Number(deal.probability);
    }
    return out;
  },
  applySheetDeal(deal, overrides) {
    if(!deal||!overrides)return deal;
    const id=String(deal.id||'').replace(/^deal-/,'');
    const ov=overrides.get?overrides.get(id):overrides[id];
    if(!ov)return deal;
    const next={...deal}; const diffs=[];
    next.onSheet=true;
    if(ov.amount!=null&&next.amount!==ov.amount){next.hubspotAmount=next.amount; next.amount=ov.amount; diffs.push('amount');}
    const sheetClose=ov.close?this.dateOnly(ov.close)||ov.close:null;
    if(sheetClose&&this.dateOnly(next.close)!==sheetClose){const hub=this.dateOnly(next.close);next.hubspotClose=next.close; next.close=sheetClose; const gap=hub?Math.abs(Date.parse(hub)-Date.parse(sheetClose))/86400000:null; if(gap==null||gap>2)diffs.push('close');}
    if(ov.stage){
      const current=String(next.stageLabel||next.stage||'');
      if(!current.toLowerCase().includes(String(ov.stage).toLowerCase())){
        next.hubspotStage=current||ov.hubspotStage; diffs.push('stage');
      }
      next.stage=ov.stage; next.stageLabel=ov.stage;
    }
    if(ov.owner&&next.owner!==ov.owner){next.hubspotOwner=next.owner; next.owner=ov.owner; diffs.push('owner');}
    if(ov.probability!=null&&Number.isFinite(ov.probability)){const sheetP=this.probabilityFraction(ov.probability);if(this.probabilityFraction(next.probability)!==sheetP){next.hubspotProbability=next.probability;diffs.push('probability');}next.probability=sheetP;}
    if(ov.company&&next.name!==ov.company)next.name=ov.company;
    next.sheetClass=this.sheetClassName(ov.stage||next.stage);
    if(diffs.length)next.hubspotDiffers=diffs;
    return next;
  },
  // Sheet rows win. A sheet deal with no HubSpot match is still included.
  dealsWithSheet(opportunities, review) {
    const overrides=this.sheetOverrides(review);
    const seen=new Set();
    const out=[];
    for(const opp of opportunities||[]){
      const nxt=this.applySheetDeal(opp, overrides);
      out.push(nxt);
      seen.add(String(nxt&&nxt.id||'').replace(/^deal-/,''));
    }
    for(const deal of (review&&review.deals)||[]){
      const did=String(deal.id||'').replace(/^deal-/,'');
      if(!did||seen.has(did))continue;
      const stage=String(deal.stage||'').split(' (')[0].trim();
      out.push({
        id:'deal-'+did,
        companyId:'company:unknown',
        name:deal.company||deal.name||'',
        dealName:deal.name||'',
        owner:deal.owner||'Unassigned',
        stage, stageLabel:stage,
        amount:deal.amount,
        probability:null,
        close:this.dateOnly(deal.close),
        pipeline:'',
        closed:false,
        onSheet:true,
        sheetOnly:true,
        sheetClass:this.sheetClassName(stage),
      });
    }
    return out;
  },
  isJunkName(value) {
    return String(value||'').toLowerCase().includes('system verification test');
  },
  accountName(companyName, dealName) {
    const name=this.companyName(companyName);
    const deal=this.companyName(dealName);
    if(this.isJunkName(name)||this.isJunkName(deal))return null;
    if(/^(renewal|current agreement)$/i.test(name||''))return null;
    if(/\bkidde\b/i.test(deal||'')&&/\bcarrier\b/i.test(name||''))return 'Kidde Global Solutions';
    return name||null;
  },
  // Correct on any day: "starts tomorrow", "starts in 3 days", "on now", "ended 5 days ago".
  relativeStart(start,end,today) {
    today=today||this.phoenixToday();
    if(!start)return 'date not set';
    const last=end||start;
    const ahead=-this.relativeDays(start,today);
    if(start<=today&&today<=last)return last===today?'ends today':'on now, through '+this.formatShort(last);
    if(last<today){const ago=this.relativeDays(last,today);return ago===1?'ended yesterday':'ended '+ago+' days ago';}
    if(ahead===0)return 'starts today';
    if(ahead===1)return 'starts tomorrow';
    if(ahead<7)return 'starts in '+ahead+' days';
    const nextWeek=this.addDays(this.weekStart(today),7);
    if(start>=nextWeek&&start<this.addDays(nextWeek,7))return 'starts next week';
    return 'starts '+this.formatShort(start);
  },
  formatShort(day) {
    const d=this.dateOnly(day);
    return d?new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}):'';
  },
  // $ with K or M, as the beta showed workbook amounts: $429K, $32.7K, $1.05M.
  moneyK(value) {
    if(value==null||value===''||!Number.isFinite(Number(value)))return '—';
    const n=Math.abs(Number(value)),sign=Number(value)<0?'-':'';
    const trim=t=>t.replace(/\.?0+$/,'');
    const text=n>=1e6?trim((n/1e6).toFixed(2))+'M':n>=1e5?Math.round(n/1000)+'K':n>=1000?trim((n/1000).toFixed(1))+'K':String(Math.round(n));
    return sign+'$'+text;
  },
  // A timed meeting whose start is already past. A date with no time has not started.
  hasStarted(start, now=Date.now()) {
    const raw=String(start||'');
    if(!/T\d{2}:\d{2}/.test(raw))return false;
    const t=Date.parse(raw);
    return Number.isFinite(t)&&t<now;
  },
  // Recorded spend against the plan for the same months, then the full-year plan.
  spendVersusPlan(spend) {
    if(!spend||!spend.connected)return '';
    const last=spend.lastEnteredMonth,months=(spend.months||[]).filter(m=>last&&m.month<=last);
    const plan=months.reduce((a,m)=>a+(m.planned||0),0),actual=months.reduce((a,m)=>a+(m.actual||0),0),gap=actual-plan;
    const name=last?new Date(last+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'long',timeZone:'UTC'}):'the last entered month';
    return 'Through '+name+': '+this.moneyK(actual)+' recorded against '+this.moneyK(plan)+' planned for those months ('+this.moneyK(Math.abs(gap))+' '+(gap>0?'over':'under')+' plan). Full-year plan '+this.moneyK(spend.plannedTotal||0)+'.';
  },
  missingSpendText(spend) {
    const months=(spend&&spend.missingMonths)||[];
    const names=months.map(k=>new Date(k+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'long',timeZone:'UTC'}));
    if(!spend||!spend.connected)return 'The budget workbook is not in this collection. Spend shows as not connected, never as zero.';
    if(!names.length)return 'Every month so far has actuals in the budget workbook. A blank month would show as not entered, never as underspend.';
    const list=names.length>1?names.slice(0,-1).join(', ')+' and '+names[names.length-1]:names[0];
    return list+(names.length>1?' have':' has')+' no actuals in the budget workbook yet. '+(names.length>1?'They show':'It shows')+' as not entered, never as underspend.';
  },
  modeInstructions(mode) {
    return mode==='marketing'
      ? 'Write marketing and prospect content. Use broader positioning and supported planned capabilities, preserving whether each capability is available, in development or planned. Do not describe an unreleased capability as available.'
      : 'Write customer-success content using verified available capabilities and the Opstream user guide. Give literal operational guidance. Preserve uncertainty and do not promise an unreleased capability.';
  }
};
if(typeof module!=='undefined')module.exports=workspaceModel;

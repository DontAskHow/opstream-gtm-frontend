// Shared calculations for the exported snapshot and the browser controls.
// Headline numbers (pipeline, funnel, quiet days, unworked leads) are computed
// here and only here. Generators and the assistant describe these results;
// they do not invent a second figure. Dates are America/Phoenix calendar dates.
const workspaceModel = {
  PHOENIX: 'America/Phoenix',
  QUIET_DAYS: 14,
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
    return new Intl.DateTimeFormat('en-CA',{timeZone:this.PHOENIX,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  },
  phoenixHour(now=new Date()) {
    return Number(new Intl.DateTimeFormat('en-US',{timeZone:this.PHOENIX,hour:'numeric',hourCycle:'h23'}).format(now));
  },
  // Calendar date in Phoenix. A date-only string is kept as written so it is
  // not shifted into the previous day by a UTC conversion.
  dateOnly(value) {
    if(value==null||value==='')return null;
    const raw=String(value).trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return raw;
    const parsed=Date.parse(raw.length===16?raw+':00Z':raw);
    if(Number.isFinite(parsed))return new Intl.DateTimeFormat('en-CA',{timeZone:this.PHOENIX,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(parsed));
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
    const date=new Intl.DateTimeFormat('en-US',{timeZone:this.PHOENIX,month:'short',day:'numeric',year:'numeric'}).format(when);
    const time=new Intl.DateTimeFormat('en-US',{timeZone:this.PHOENIX,hour:'numeric',minute:'2-digit'}).format(when);
    return date+' · '+time+' Phoenix';
  },
  formatTime(value) {
    const raw=String(value??'').trim();if(!raw)return '';
    const parsed=Date.parse(raw.length===16?raw+':00Z':raw);
    if(!Number.isFinite(parsed))return '';
    return new Intl.DateTimeFormat('en-US',{timeZone:this.PHOENIX,hour:'numeric',minute:'2-digit'}).format(new Date(parsed))+' Phoenix';
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
  // One label everywhere. A raw HubSpot id is not a name, and "Owner Owner 1234" is the same id twice.
  displayOwner(value) {
    let s=String(value??'').trim();
    if(!s||/^unassigned$/i.test(s))return 'Unassigned';
    s=s.replace(/^(owner\s+)+/i,'').trim();
    if(!s)return 'Unassigned';
    if(/^\d+$/.test(s)||/^[a-f0-9-]{8,}$/i.test(s))return 'Owner name not connected';
    return s;
  },
  // 'open' counts in the headline. 'past' failed only because the close date is past.
  // 'excluded' is a renewal, current agreement, disqualified, on hold, or closed deal.
  listStatus(deal,today) {
    today=today||this.phoenixToday();
    if(this.isOpenPipeline(deal,today))return 'open';
    if(this.isOpenPipeline({...deal,close:this.addDays(today,30)},today))return 'past';
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
  // Open pipeline: future (or unset) close, not a renewal / current agreement,
  // not Disqualified, not On Hold, not closed. A missing stage stays in and is labeled.
  isOpenPipeline(deal,today) {
    if(!deal||deal.closed===true)return false;
    const stage=String(deal.stage||deal.stageLabel||'');
    const dealName=String(deal.dealName||'');
    const blob=(stage+' '+dealName).toLowerCase();
    if(/closed\s*won|closed\s*lost|closedwon|closedlost/.test(blob))return false;
    if(/disqualif/.test(blob))return false;
    if(/\bon hold\b/.test(blob))return false;
    if(/current agreement/.test(blob))return false;
    if(/\brenewal\b/.test(blob))return false;
    const close=this.dateOnly(deal.close);
    if(close&&today&&close<today)return false;
    return true;
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
    const find=o=>companies.find(c=>c.id===String(o.companyId||'').replace(/^company:/,'')||c.name===o.name);
    return this.pipelineTotals(opportunities,today).deals.map(o=>{
      const company=find(o);
      return {...o,companyRecord:company,lastEngagement:company?this.lastEngagement(company,today):null,daysQuiet:company?this.daysQuiet(company,today):null};
    }).filter(o=>o.daysQuiet==null||o.daysQuiet>=this.QUIET_DAYS);
  },
  // Sheet lead tracker wins when it is present. Otherwise a lead is unworked
  // until a meeting is booked (MQL date).
  unworkedLeads(leads,sheetReview) {
    const lt=sheetReview&&sheetReview.leadTracker;
    if(lt&&typeof lt.unworked==='number'&&typeof lt.total==='number'&&lt.total>0)return {count:lt.unworked,source:'sheet'};
    return {count:(leads||[]).filter(l=>!this.dateOnly(l.mql)).length,source:'leads'};
  },
  activityFromRecords(records) {
    const meetings=[],recordings=[];
    for(const c of records?.companies||[]){
      for(const m of c.meetings||[])meetings.push({start:m.start,booked:m.booked||m.created||m.start,outcome:m.outcome||'',companyId:c.id});
      for(const r of c.recordings||[])recordings.push({date:r.date,companyId:c.id});
    }
    for(const r of records?.unmatchedRecordings||[])recordings.push({date:r.date,companyId:null});
    return {meetings,recordings};
  },
  // Leads by lead date. MQL = a meeting booked. SQL = a meeting held
  // (a recording, or a CRM meeting whose outcome says it was held).
  funnel(leads,records,start,end) {
    const inR=v=>this.inRange(v,start,end);
    const leadCount=(leads||[]).filter(l=>inR(l.lead)).length;
    const {meetings,recordings}=this.activityFromRecords(records);
    const booked=meetings.filter(m=>inR(m.booked||m.start));
    const heldKeys=new Set();
    for(const r of recordings){const d=this.dateOnly(r.date);if(d&&inR(d))heldKeys.add((r.companyId||'')+'|'+d);}
    for(const m of meetings){
      const d=this.dateOnly(m.start);
      if(!d||!inR(d))continue;
      if(/complete|held|completed/i.test(m.outcome||''))heldKeys.add((m.companyId||'')+'|'+d+'|crm');
    }
    // A recording and a completed CRM meeting on the same company and day are one held meeting.
    const sqlKeys=new Set();
    for(const key of heldKeys){
      const [company,day]=key.split('|');
      sqlKeys.add(company+'|'+day);
    }
    return {leads:leadCount,mql:booked.length,sql:sqlKeys.size,booked,held:sqlKeys.size};
  },
  // One lead source for a company, or Unattributed when the company has none or several.
  sourceForCompany(company,leads) {
    if(!company)return 'Unattributed';
    const id=String(company.id||'');
    const matches=(leads||[]).filter(l=>(l.companyId&&String(l.companyId).replace(/^company:/,'')===id)||(l.name&&l.name===company.name));
    const sources=[...new Set(matches.map(l=>l.source).filter(Boolean))];
    return sources.length===1?sources[0]:'Unattributed';
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
  // Spend is recorded by month. A gap is not zero: if any month overlapping the
  // range has no actual, the cost is not connected. Week and multi-week ranges
  // are not a month, so they stay not connected rather than borrowing a month.
  costPerLead(channel,leads,spend,start,end) {
    const months=[];
    let cursor=(start||'').slice(0,7);
    const last=(end||'').slice(0,7);
    if(!/^\d{4}-\d{2}$/.test(cursor)||!/^\d{4}-\d{2}$/.test(last)||!String(start).endsWith('-01'))return 'not connected';
    while(cursor<=last){
      months.push(cursor);
      const [y,m]=cursor.split('-').map(Number);
      cursor=m===12?(y+1)+'-01':y+'-'+String(m+1).padStart(2,'0');
    }
    const series=(spend&&spend.channelMonths||[]).find(c=>String(c.channel||'').toLowerCase()===String(channel||'').toLowerCase());
    if(!series)return 'not connected';
    let sum=0;
    for(const month of months){
      const row=(series.months||[]).find(x=>x.month===month);
      if(!row||row.actual==null||row.actual==='')return 'not connected';
      const n=Number(row.actual);
      if(!Number.isFinite(n))return 'not connected';
      sum+=n;
    }
    if(!leads)return '—';
    return '$'+Math.round(sum/leads).toLocaleString('en-US');
  },
  marketingView(leads,records,spend,today) {
    today=today||this.phoenixToday();
    const weekStart=this.weekStart(today);
    const quarter=this.periodBounds('quarter',null,null,today);
    const windows=[
      {key:'week',label:'This week',start:weekStart,end:today,average:false,weeks:1},
      {key:'six',label:'6-week average',start:this.addDays(weekStart,-35),end:today,average:true,weeks:6},
      {key:'quarter',label:'Quarter to date',start:quarter.start,end:quarter.end,average:false,weeks:1}
    ];
    const blocks=windows.map(w=>{
      const fun=this.funnel(leads,records,w.start,w.end);
      const channels=this.channels(leads,records,w.start,w.end);
      const div=w.average?w.weeks:1;
      return {...w,range:this.formatDate(w.start)+' – '+this.formatDate(w.end),leads:fun.leads/div,mql:fun.mql/div,sql:fun.sql/div,leadsTotal:fun.leads,channels};
    });
    const names=[];
    for(const block of blocks)for(const c of block.channels)if(c.leads&&!names.includes(c.channel))names.push(c.channel);
    const quarterBlock=blocks[2];
    const sources=names.map(name=>{
      const raw=block=>{
        const row=block.channels.find(c=>c.channel===name);
        return row?row.leads:0;
      };
      const quarterLeads=raw(quarterBlock);
      return {
        channel:name,
        week:this.formatMetric(raw(blocks[0]),false),
        six:this.formatMetric(raw(blocks[1])/blocks[1].weeks,true),
        quarter:this.formatMetric(quarterLeads,false),
        cpl:this.costPerLead(name,quarterLeads,spend,quarter.start,quarter.end)
      };
    });
    return {
      intervals:blocks.map(b=>({
        key:b.key,label:b.label,range:b.range,
        leads:this.formatMetric(b.leads,b.average),
        mql:this.formatMetric(b.mql,b.average),
        sql:this.formatMetric(b.sql,b.average),
        note:b.average?'Per week across the last 6 weeks. Not the six-week total.':b.key==='week'?'Monday through today, America/Phoenix.':'Calendar quarter through today.',
        cpl:b.key==='quarter'?'See each source':'not connected',
        cplNote:b.key==='quarter'?'Quarter cost per lead is on the source table. A missing month is not connected, not zero.':'Spend is recorded by month, so a weekly cost per lead is not connected.'
      })),
      sources
    };
  },
  channels(leads,records,start,end) {
    const inR=v=>this.inRange(v,start,end);
    const by=new Map();
    const row=src=>{const key=src||'Unattributed';if(!by.has(key))by.set(key,{channel:key,leads:0,mql:0,sql:0});return by.get(key);};
    for(const l of leads||[])if(inR(l.lead))row(l.source||'Unknown source').leads++;
    const companies=records?.companies||[];
    const find=id=>companies.find(c=>c.id===id);
    const {meetings,recordings}=this.activityFromRecords(records);
    for(const m of meetings){
      if(!inR(m.booked||m.start))continue;
      row(this.sourceForCompany(find(m.companyId),leads)).mql++;
    }
    const held=new Set();
    const addHeld=(companyId,day)=>{
      const key=(companyId||'')+'|'+day;
      if(held.has(key))return;
      held.add(key);
      row(this.sourceForCompany(find(companyId),leads)).sql++;
    };
    for(const r of recordings){const d=this.dateOnly(r.date);if(d&&inR(d))addHeld(r.companyId,d);}
    for(const m of meetings){
      const d=this.dateOnly(m.start);
      if(!d||!inR(d))continue;
      if(/complete|held|completed/i.test(m.outcome||''))addHeld(m.companyId,d);
    }
    return [...by.values()].filter(r=>r.leads||r.mql||r.sql).sort((a,b)=>b.leads-a.leads||b.mql-a.mql||a.channel.localeCompare(b.channel));
  },
  compareLeads(a,b) {
    const left=this.date(a.lead),right=this.date(b.lead),tie=()=>a.name.localeCompare(b.name)||String(a.id).localeCompare(String(b.id));
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
  modeInstructions(mode) {
    return mode==='marketing'
      ? 'Write marketing and prospect content. Use broader positioning and supported planned capabilities, preserving whether each capability is available, in development or planned. Do not describe an unreleased capability as available.'
      : 'Write customer-success content using verified available capabilities and the Opstream user guide. Give literal operational guidance. Preserve uncertainty and do not promise an unreleased capability.';
  }
};
if(typeof module!=='undefined')module.exports=workspaceModel;

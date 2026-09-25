// Public preview adapter: browser-local persistence and no provider effects.
let demoState;
Component.prototype._workspaceApi=async function(path,body){
 if(!demoState){const seed=await fetch('/data/bootstrap.json').then(r=>r.json());try{demoState=JSON.parse(localStorage.getItem('gtm-public-demo-v1'))||seed;}catch{demoState=seed;}}
 const save=()=>localStorage.setItem('gtm-public-demo-v1',JSON.stringify(demoState));
 if(path==='/bootstrap')return structuredClone(demoState);
 if(path==='/comments')return {comments:structuredClone(demoState.comments)};
 if(path==='/preferences'){demoState.preferences=body.preferences;demoState.preferencesRevision++;save();return {revision:demoState.preferencesRevision};}
 if(path.startsWith('/priorities/')&&path.endsWith('/comments')){const now=new Date().toISOString(),id=body.id||crypto.randomUUID(),prior=demoState.comments.find(c=>c.id===id);const comment={...body,id,priorityId:decodeURIComponent(path.split('/')[2]),authorName:'Demo User',mine:true,createdAt:prior?.createdAt||now,updatedAt:now,revision:(prior?.revision||0)+1,notifications:[]};demoState.comments=[...demoState.comments.filter(c=>c.id!==id),comment];save();return {comments:structuredClone(demoState.comments),comment};}
 if(path.startsWith('/drafts/')&&!path.endsWith('/send')){const id=decodeURIComponent(path.split('/')[2]),prior=demoState.drafts.find(d=>d.id===id);if(path.endsWith('/history'))return {versions:prior?.history||[]};if(!body)return {draft:structuredClone(prior)};const draft={...body.draft,version:(prior?.version||0)+1,updatedAt:new Date().toISOString(),history:[...(prior?.history||[]),...(prior?[prior]:[])]};demoState.drafts=[...demoState.drafts.filter(d=>d.id!==id),draft];save();return {draft:structuredClone(draft)};}
 throw Error('Provider actions are disabled in this synthetic demo.');
};
const demoRender=Component.prototype.renderVals;
Component.prototype.renderVals=function(){const v=demoRender.call(this);v.priorityIntro='Four example priorities. All companies, people, messages and metrics are synthetic.';v.priorityNotice='Demo preferences are saved only in this browser.';v.refreshNote='Synthetic demo — no production connections.';v.checkNote='Synthetic sample data';v.googleConnectionLabel='Email sending is disabled in this public demo.';v.slackConnectionLabel='Slack is disabled in this public demo.';v.sendDisabled=true;return v;};

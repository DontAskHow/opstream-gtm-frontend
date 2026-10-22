const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),esbuild=require('esbuild'),{execFileSync}=require('node:child_process');
const brainDb=path.join(os.homedir(),'workspace','brain','brain.db');
function runStep(label,cmd,args){
 try{execFileSync(cmd,args,{stdio:'inherit'});return true;}
 catch(e){console.error(label+' failed (non-fatal):',e.message);return false;}
}
async function main(){
 fs.mkdirSync('out/assets',{recursive:true});
 for(const name of ['support.js','_ds','assets'])fs.cpSync('source/'+name,'out/'+name,{recursive:true});
 const modules=["workspace-model.cjs","workspace-domain.cjs","showcase-adapter.js","data-bindings.js","workspace-controls.js","collaboration.js","marketing-home.js","account-session.js","agent.js"];
 const html=fs.readFileSync('source/workspace.html','utf8').replace('/* FRONTEND_MODULES */',()=>modules.map(f=>fs.readFileSync(f,'utf8')).join('\n'));
 fs.writeFileSync('out/index.html',html);fs.mkdirSync('out/gtm',{recursive:true});fs.writeFileSync('out/gtm/index.html',html);
 fs.mkdirSync('out/data',{recursive:true});fs.writeFileSync('out/data/records.json',JSON.stringify({companies:[],unmatchedRecordings:[]}));
// Real data from the company brain takes precedence when the private database
// is present. Synthetic demo data is the fallback so a public checkout builds
// without that database or any contact records.
const hasBrain=fs.existsSync(brainDb);
let usedBrain=false;
if(hasBrain&&fs.existsSync('scripts/brain-data.mjs'))usedBrain=runStep('brain-data','node',['scripts/brain-data.mjs']);
else if(hasBrain&&fs.existsSync('scripts/brain-data.py'))usedBrain=runStep('brain-data','python3',['scripts/brain-data.py']);
if(!usedBrain)console.log('No company brain database; out/data has no collection until the refresh publishes a run.');
// The operator refreshes after data generation (brain or synthetic).
// Before it runs, the sheet review reconciles the manual pipeline sheet
// against HubSpot when the brain database is present.
if(hasBrain&&fs.existsSync('scripts/sheet-review.py'))runStep('sheet-review','python3',['scripts/sheet-review.py']);
else console.log('sheet-review skipped (company brain database not present).');
if(fs.existsSync('scripts/hollie-operator.py'))runStep('hollie-operator','python3',['scripts/hollie-operator.py']);
// The agent's proactive morning brief is LLM-written and fail-soft: it must
// never break the build (no key / API down just keeps the previous brief).
if(fs.existsSync('scripts/agent-brief.py')){try{execFileSync('python3',['scripts/agent-brief.py'],{stdio:'inherit'});}catch(e){console.error('agent-brief failed (non-fatal):',e.message);}}
// The heartbeat tends the product: health-checks the build output and asks the
// agent for proactive insights (fail-soft like agent-brief — never breaks build).
if(fs.existsSync('scripts/heartbeat.py')){try{execFileSync('python3',['scripts/heartbeat.py'],{stdio:'inherit'});}catch(e){console.error('heartbeat failed (non-fatal):',e.message);}}
 runStep('term scrub','python3',['scripts/term_scrub.py','out/data']);
 await esbuild.build({entryPoints:['evidence-renderer.mjs'],bundle:true,format:'iife',globalName:'OpstreamEvidence',platform:'browser',target:'es2022',outfile:'out/assets/evidence-renderer.js',minify:true});
 console.log('Built frontend with the production collection snapshot. Authenticated APIs (/api/ask) are served by the agent server, not the static build.');
} main().catch(e=>{console.error(e);process.exitCode=1;});

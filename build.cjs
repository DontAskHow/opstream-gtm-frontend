const fs=require('node:fs'),esbuild=require('esbuild');
async function main(){
 fs.mkdirSync('out/assets',{recursive:true});
 for(const name of ['support.js','_ds','assets'])fs.cpSync('source/'+name,'out/'+name,{recursive:true});
 const modules=["workspace-model.cjs","workspace-domain.cjs","showcase-adapter.js","data-bindings.js","workspace-controls.js","collaboration.js","demo-mode.js"];
 const html=fs.readFileSync('source/workspace.html','utf8').replace('/* FRONTEND_MODULES */',()=>modules.map(f=>fs.readFileSync(f,'utf8')).join('\n'));
 fs.writeFileSync('out/index.html',html);fs.mkdirSync('out/gtm',{recursive:true});fs.writeFileSync('out/gtm/index.html',html);
 fs.mkdirSync('out/data',{recursive:true});fs.writeFileSync('out/data/records.json',JSON.stringify({companies:[],unmatchedRecordings:[]}));fs.writeFileSync('out/data/transcripts.json','{}');
 require('./scripts/synthetic-data.cjs');
 await esbuild.build({entryPoints:['evidence-renderer.mjs'],bundle:true,format:'iife',globalName:'OpstreamEvidence',platform:'browser',target:'es2022',outfile:'out/assets/evidence-renderer.js',minify:true});
 console.log('Built frontend. Production data and authenticated APIs are not included.');
} main().catch(e=>{console.error(e);process.exitCode=1;});

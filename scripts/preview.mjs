import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const root=path.resolve('out');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8','.ttf':'font/ttf'};
const compressible=new Set(['.html','.js','.mjs','.css','.json','.svg','.txt','.map']);
const server=http.createServer((req,res)=>{
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405).end();return;}
 let file;try{file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));}catch{res.writeHead(400).end();return;}
 if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
 if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
 const ext=path.extname(file);
 res.setHeader('Content-Type',types[ext]||'application/octet-stream');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Vary','Accept-Encoding');
 if(compressible.has(ext)&&/\bgzip\b/.test(String(req.headers['accept-encoding']||''))){res.setHeader('Content-Encoding','gzip');fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);return;}
 fs.createReadStream(file).pipe(res);
});
server.listen(Number(process.env.PORT||4173),'127.0.0.1',()=>console.log('Synthetic preview: http://127.0.0.1:'+server.address().port));

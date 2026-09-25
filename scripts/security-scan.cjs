const fs=require('node:fs'),cp=require('node:child_process');
const files=cp.execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean);
const patterns=[['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],['provider token',/\b(?:xox[baprs]-[A-Za-z0-9-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{30,}|GOCSPX-[A-Za-z0-9_-]{20,})/]];
const findings=[];
for(const file of files){if(!fs.existsSync(file))continue;const bytes=fs.readFileSync(file);if(bytes.subarray(0,8192).includes(0))continue;const text=bytes.toString('utf8');for(const [label,pattern]of patterns)if(pattern.test(text))findings.push({file,detector:label});}
if(findings.length){console.error(findings);process.exitCode=1;}else console.log('PASS: '+files.length+' Git-visible files contain no detected provider tokens or private keys.');

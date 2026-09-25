// Failure modes: render errors, broken routes, lost demo edits, enabled sends,
// mobile overflow, or a preview that exposes files outside its static output.
const {chromium}=require('@playwright/test');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH?{executablePath:process.env.BROWSER_PATH}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';
 const open=async q=>{await page.goto(base+'/?'+q);await page.getByRole('button',{name:'Connections',exact:true}).waitFor();await page.waitForFunction(()=>document.body.innerText.includes('Demo preferences')||document.querySelector('[data-screen-label="Performance"]')||document.querySelector('[data-screen-label="Accounts"]')||document.querySelector('[data-screen-label="Drafts"]'));await page.waitForTimeout(300);assert(!/Root:|Collection unavailable/.test(await page.locator('body').innerText()));};
 await open('view=today');await page.getByRole('button',{name:'Prioritize',exact:true}).first().click();await page.getByRole('button',{name:'Remove priority star',exact:true}).waitFor();await page.waitForFunction(()=>Object.values(JSON.parse(localStorage.getItem('gtm-public-demo-v1')||'{}').preferences?.ratings||{}).includes('important'));await page.reload();await page.getByRole('button',{name:'Remove priority star',exact:true}).waitFor();
 await page.getByRole('button',{name:'Add a comment',exact:true}).first().click();await page.getByRole('textbox',{name:'Add a comment',exact:true}).fill('Synthetic E2E comment');await page.getByRole('button',{name:'Save comment',exact:true}).click();await page.getByText('Synthetic E2E comment',{exact:true}).waitFor();
 fs.mkdirSync('verification',{recursive:true});await page.screenshot({path:'verification/desktop.png',fullPage:true});
 for(const q of ['view=performance&perf=demand','view=performance&perf=spend','view=performance&perf=web','view=accounts&accounts=deals','view=meetings&meetings=past','view=drafts','view=data']){await page.goto(base+'/?'+q);await page.waitForTimeout(900);assert(!/Root:|Collection unavailable/.test(await page.locator('body').innerText()),q);}
 await open('view=today');await page.getByRole('button',{name:'Open account',exact:true}).first().click();await page.getByRole('heading',{name:'Northstar Labs',exact:true}).waitFor();
 await open('view=drafts');await page.locator('#draft-message').fill('Synthetic edited draft');await page.getByRole('button',{name:/Save version/}).click();await page.waitForTimeout(350);await page.reload();await page.locator('#draft-message').waitFor();await page.waitForFunction(()=>document.querySelector('#draft-message')?.value==='Synthetic edited draft');assert(await page.getByRole('button',{name:'Send email',exact:true}).isDisabled());
 await page.setViewportSize({width:390,height:844});await open('view=today');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'verification/mobile.png',fullPage:true});
 assert.equal((await page.request.get(base+'/.git/config')).status(),404);
 assert.deepEqual(errors,[]);await browser.close();
 fs.writeFileSync('verification/result.json',JSON.stringify({date:new Date().toISOString(),result:'pass',checks:['navigation: seven views','account detail','priority persists after reload','comment save','draft edit persists after reload','email disabled','mobile width 390','static root isolation','no browser exceptions']},null,2));console.log('PASS: synthetic frontend browser workflow');
})().catch(e=>{console.error(e);process.exit(1)});

const {chromium}=require('playwright'),fs=require('fs'),http=require('http'),path=require('path'),crypto=require('crypto');
// Optional benchmark tool: requires Playwright and Chromium in the test environment.
const root=process.env.BENCH_ROOT && path.resolve(process.env.BENCH_ROOT),save=process.env.BENCH_SAVE;
if(!root||!save)throw new Error('Set BENCH_ROOT to snapshot directories and BENCH_SAVE to a local sample save.');
const versions=process.argv.slice(2);if(!versions.length)versions.push('before','final');
(async()=>{
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');let file=path.join(root,url.pathname);if(url.pathname.endsWith('/'))file=path.join(file,'index.html');if(!file.startsWith(root+'/')){res.writeHead(403);res.end();return;}fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(data);});});
await new Promise(resolve=>server.listen(8767,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});const results=[];
try {for(let run=1;run<=Number(process.env.BENCH_RUNS || 3);run++)for(const version of (run%2?versions:[...versions].reverse())){
 const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 if (version === 'fallback') await context.addInitScript(() => Object.defineProperty(window, 'scheduler', {value: undefined}));
 await page.goto(`http://127.0.0.1:8767/${version}/`);
 await page.evaluate(()=>{
  window.profile={};for(const [object,methods] of [[TwLzma,['decode','encode']],[TwEsf,['scan','parseContainer']]])for(const method of methods){const original=object[method];object[method]=function(...args){const start=performance.now();const r=original.apply(this,args);if(r&&r.then)return r.then(result=>{window.profile[method]=(window.profile[method]||0)+performance.now()-start;return result;});window.profile[method]=(window.profile[method]||0)+performance.now()-start;return r;};}
  window.tasks=[];new PerformanceObserver(l=>tasks.push(...l.getEntries().map(e=>e.duration))).observe({entryTypes:['longtask']});
  document.getElementById('file').addEventListener('change',()=>window.loadStart=performance.now(),true);
  document.getElementById('build').addEventListener('click',()=>{window.exportStart=performance.now();window.tasks=[];window.profile={};},true);
  const meter=document.getElementById('export-progress');if(meter)new MutationObserver(()=>{if(!meter.hidden&&!window.feedback)window.feedback=performance.now()-window.exportStart;}).observe(meter,{attributes:true});
 });
 await page.locator('#file').setInputFiles(save);await page.locator('#edit-section').waitFor({state:'visible',timeout:90000});
 const loadMs=await page.evaluate(()=>performance.now()-window.loadStart);const rows=await page.locator('#rows tr').count();
 const select=page.locator('#rows select').first();await select.selectOption(process.env.BENCH_TRAIT || 'wh2_dlc09_skill_innate_tmb_cavalry_master');
 await page.locator('#build').scrollIntoViewIfNeeded();const pending=page.waitForEvent('download',{timeout:120000});await page.locator('#build').click();const download=await pending;
 const exportStats=await page.evaluate(()=>({exportMs:performance.now()-window.exportStart,profile:window.profile,feedbackMs:window.feedback??null,maxTaskMs:Math.max(0,...tasks),longTasksOver500ms:tasks.filter(x=>x>500).length}));
 const data=fs.readFileSync(await download.path());
 const result={version,run,loadMs,...exportStats,rows,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex'),errors};results.push(result);console.log(JSON.stringify(result));
 await context.close();
}}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
fs.writeFileSync(path.join(root,'results-'+versions.join('-')+'.json'),JSON.stringify(results,null,2));
if (results.some(r => r.errors.length || r.sha256 !== results[0].sha256)) throw new Error('Browser errors or different output bytes detected; inspect benchmark results.');
})().catch(e=>{console.error(e);process.exit(1)});

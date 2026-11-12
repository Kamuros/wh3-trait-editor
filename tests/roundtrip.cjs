const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), assert = require('node:assert/strict');
const { fixture } = require('./fixtures/synthetic.cjs');
const ctx = vm.createContext({window:{},TextDecoder});
for (const name of ['lzma','esf','savefile']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',name+'.js'),'utf8'),ctx);
const Save=ctx.window.TwSave;
async function test(bytes) {
 const model=await Save.load(Uint8Array.from(bytes),async()=>{});
 assert.equal(model.editBlockers.length,0);
 assert(Buffer.from(await Save.build(model,new Map(),async()=>{})).equals(bytes));
 assert.equal((await Save.verify(bytes,model,new Map(),async()=>{})).length,0);
 const ch=model.characters[0],key='wh3_skill_innate_all_strong',edits=new Map([[ch,key]]);
 const output=await Save.build(model,edits,async()=>{});
 const allowed=new Set(ch.offsets.flatMap(o=>[o,o+1,o+2,o+3]));let changed=0;
 for(let i=0;i<bytes.length;i++)if(bytes[i]!==output[i]){assert(allowed.has(i));changed++;}
 assert(changed>0);assert.equal((await Save.verify(output,model,edits,async()=>{})).length,0);
 const damaged=output.slice(); damaged[4]^=1;
 assert((await Save.verify(damaged,model,edits,async()=>{})).some(s=>s.includes('Unexpected byte')));
}
(async()=>{
 for(const signature of [0xabca,0xabcb]) for(let seed=1;seed<=64;seed++)await test(fixture(seed,signature));
 for(const name of ['abca.esf','abcb.esf']) await test(fs.readFileSync(path.join(__dirname,'fixtures',name)));
 const unknown=await Save.load(fixture(1,0xabcb,'v9.0.6 Build 99999'),async()=>{});
 assert(unknown.editBlockers.some(s=>s.includes('Read-only')));
 await assert.rejects(()=>Save.build(unknown,new Map([[unknown.characters[0],'wh3_skill_innate_all_strong']]),async()=>{}),/Read-only/);
 assert(Buffer.from(await Save.build(unknown,new Map(),async()=>{})).equals(Buffer.from(unknown.root.buf)));
 const unsafe=fixture();unsafe.fill(0xff,20,28);
 await assert.rejects(()=>Save.load(unsafe,async()=>{}),/integer range|oversized|recognised/);
 const partial=fixture(); const opaque=partial.indexOf(Buffer.from('09ffffffffffffffff','hex')); assert(opaque>0); partial[opaque]=0x11;
 const incomplete=await Save.load(Uint8Array.from(partial),async()=>{});
 assert(incomplete.editBlockers.some(s=>s.includes('fully read')));
 await assert.rejects(()=>Save.build(incomplete,new Map([[incomplete.characters[0],'wh3_skill_innate_all_strong']]),async()=>{}),/Read-only/);
 const raw=Uint8Array.from({length:1024},(_,i)=>i%251), props=Uint8Array.from([93,0,0,4,0]);
 const packed=await ctx.window.TwLzma.encode(raw,props);
 assert(Buffer.from(await ctx.window.TwLzma.decode(packed,props,raw.length)).equals(Buffer.from(raw)));
 await assert.rejects(()=>ctx.window.TwLzma.decode(packed.slice(0,5),props,raw.length));
 const model=await Save.load(Uint8Array.from(fixture()),async()=>{});
 assert.equal(Save.optionsFor(model.characters[0],Save.buildPools(model.characters,12),12).length,0);
 await assert.rejects(()=>Save.build(model,new Map([[model.characters[0],'invented_key']]),async()=>{}),/subtype/);
 console.log('PASS: 128 seeded binary-diff properties + 2 golden fixtures; no-edit identity; unrelated-byte rejection; unknown patch refusal; unsafe varints; u64/float/BOM/newline/trailing-byte preservation');
})().catch(e=>{console.error(e);process.exitCode=1});

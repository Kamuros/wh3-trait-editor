const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { fixture } = require('./fixtures/synthetic.cjs');
const ctx = vm.createContext({ window: {}, TextDecoder });
for (const name of ['lzma', 'esf', 'savefile']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', name + '.js'), 'utf8'), ctx);
const { TwLzma: Lzma, TwSave: Save } = ctx.window;
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const variable = n => { const a = [n & 127]; while (n = Math.floor(n / 128)) a.unshift(128 | (n & 127)); return Buffer.from(a); };
const record = (id, fields) => { const body = Buffer.concat(fields); return Buffer.concat([Buffer.from([0xa0]), u16(id), Buffer.from([0]), variable(body.length), body]); };
const array = bytes => Buffer.concat([Buffer.from([0x46]), variable(bytes.length), bytes]);
const props = Uint8Array.from([93, 0, 0, 4, 0]);
async function wrap(raw) {
 const packed = await Lzma.encode(raw, props);
 const body = record(0, [record(1, [array(packed), record(2, [Buffer.concat([Buffer.from([8]), u32(raw.length)]), array(props)])])]);
 const names = ['ROOT', 'COMPRESSED_DATA', 'COMPRESSED_DATA_INFO'];
 const footer = Buffer.concat([u16(names.length), ...names.flatMap(n => [u16(n.length), Buffer.from(n)]), u32(0), u32(0)]);
 return Uint8Array.from(Buffer.concat([u32(0xabcb), u32(0), u32(0), u32(16 + body.length), body, footer]));
}
(async () => {
 const bytes = await wrap(Uint8Array.from(fixture(7)));
 const model = await Save.load(bytes, async () => {});
 assert.equal(model.segments.length, 2);
 assert(Buffer.from(await Save.build(model, new Map(), async () => {})).equals(Buffer.from(bytes)));
 const edits = new Map([[model.characters[0], 'wh3_skill_innate_all_strong']]);
 const output = await Save.build(model, edits, async () => {});
 assert.equal((await Save.verify(output, model, edits, async () => {})).length, 0);
 const parsed = await Save.load(output, async () => {});
 const allowed = new Set(model.characters[0].offsets.flatMap(o => [o, o + 1, o + 2, o + 3]));
 let differences = 0;
 for (let i = 0; i < model.segments[1].buf.length; i++) if (model.segments[1].buf[i] !== parsed.segments[1].buf[i]) {
  assert(allowed.has(i)); differences++;
 }
 assert(differences > 0);
 // A valid compressed stream containing an unintended changed byte must fail
 // final verification even when every character key still reads correctly.
 const encode = Lzma.encode;
 Lzma.encode = async (data, ...args) => { const wrong = data.slice(); wrong[4] ^= 1; return encode(wrong, ...args); };
 const corrupted = await Save.build(model, edits, async () => {});
 Lzma.encode = encode;
 const errors = await Save.verify(corrupted, model, edits, async () => {});
 assert(errors.some(message => message.includes('Unexpected byte changes')));
 // Structurally invalid compressed data also cannot pass final verification.
 const damaged = output.slice(); damaged[parsed.root.children[0].entry.dataStart] = 1;
 let blocked = false;
 try { blocked = (await Save.verify(damaged, model, edits, async () => {})).length > 0; } catch { blocked = true; }
 assert(blocked);
 console.log('PASS: compressed no-edit identity, exact logical diff, full read-back, faulty encoder and damaged stream rejection');
})().catch(error => { console.error(error); process.exitCode = 1; });

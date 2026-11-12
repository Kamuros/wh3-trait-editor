const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const ctx = vm.createContext({ TextDecoder, Uint8Array, DataView, Map, Set }); ctx.window = ctx;
for (const f of ['vendor/fzstd', 'localisation']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', f + '.js'), 'utf8'), ctx);
const L = ctx.TwLabels;
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const string = s => Buffer.concat([u16(s.length), Buffer.from(s, 'utf16le')]);
const loc = Buffer.concat([Buffer.from([255,254,76,79,67,0]),u32(1),u32(2),string('names_name_1'),string('테스트'),Buffer.from([0]),string('alias'),string('{{tr:names_name_1}}'),Buffer.from([0])]);
function file(bytes, name) { return Object.assign(new Blob([bytes]), { name }); }
function pack(compressed) {
 let data = loc;
 if (compressed) {
  // Valid Zstandard single-segment frame with one uncompressed final block.
  const block = Buffer.alloc(3); block.writeUIntLE((loc.length << 3) | 1, 0, 3);
  data = Buffer.concat([u32(loc.length),Buffer.from([0x28,0xb5,0x2f,0xfd,0x20,loc.length]),block,loc]);
 }
 const index = Buffer.concat([u32(data.length),Buffer.from([compressed ? 1 : 0]),Buffer.from('text\\test.loc\0')]);
 const dependency = Buffer.from('base.pack\0');
 return Buffer.concat([Buffer.from('PFH5'),u32(0),u32(1),u32(dependency.length),u32(1),u32(index.length),u32(0),dependency,index,data]);
}
(async () => {
 for (const compressed of [false,true]) {
  const table = await L.readFile(file(pack(compressed), 'local_en.pack'));
  assert.equal(L.resolve(table, 'alias'), '테스트');
  assert.equal(L.character(table, { nameParts: [{ key: 'names_name_1' }], detailsId: 1 }), '테스트');
 }
 assert.equal((await L.readFile(file(loc, 'names.loc'))).size, 2);
 assert.equal((await L.readFile(file(Buffer.from('key\ttext\n#metadata\nnames_name_1\tActual Name\n'), 'names.tsv'))).get('names_name_1'), 'Actual Name');
 for (const bytes of [Buffer.from('\uFEFFkey\ttext\r\nnames_name_2\tBOM Name\r\n'), Buffer.from('\uFEFFkey\ttext\nnames_name_2\tBOM Name\n','utf16le')]) {
  assert.equal((await L.readFile(file(bytes,'bom.tsv'))).get('names_name_2'),'BOM Name');
 }
 assert.equal(L.trait(new Map(), 'wh2_main_skill_innate_all_cunning'), 'Cunning');
 assert.equal(L.trait(new Map([['character_skills_localised_name_wh2_main_skill_innate_all_cunning','Official label']]), 'wh2_main_skill_innate_all_cunning'), 'Official label');
 assert.equal(L.trait(new Map(), 'wh2_dlc09_skill_innate_tmb_cavalry_master'), 'Cavalry Master');
 assert.match(L.character(new Map(), { nameParts: [{ key: 'missing' }], detailsId: 7 }), /Name unavailable/);
 assert.equal(L.character(new Map(), { nameParts: [{ text: 'Renamed Hero' }] }), 'Renamed Hero');
 await assert.rejects(() => L.readFile(file(pack(false).subarray(0,40), 'bad.pack')));
 assert.throws(() => L.parseLoc(loc.subarray(0,loc.length-2)), /truncated/);
 console.log('PASS: compressed/uncompressed packs, dependency indexes, LOC/TSV, Unicode, labels, custom names, and malformed input');
})().catch(e => { console.error(e); process.exitCode = 1; });

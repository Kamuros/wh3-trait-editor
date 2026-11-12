// Original synthetic data only. No bytes or names copied from a user's save.
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
function fixture(seed = 1, signature = 0xabcb, version = 'v9.0.5 Build 51143.4399233') {
 const names = [], strings = [], wide = ['\uFEFFName\r\nSecond\nThird'];
 let random = seed >>> 0;
 const rng = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
 const variable = n => { const a = [n & 127]; while (n = Math.floor(n / 128)) a.unshift(128 | (n & 127)); while (a.length < (seed % 3 ? 1 : 5)) a.unshift(128); return Buffer.from(a); };
 const str = s => { if (!strings.includes(s)) strings.push(s); return Buffer.concat([Buffer.from([15]), u32(strings.indexOf(s))]); };
 const rec = (name, fields) => { if (!names.includes(name)) names.push(name); const body = Buffer.concat(fields); return Buffer.concat([Buffer.from([0xa0]),u16(names.indexOf(name)),Buffer.from([0]),variable(body.length),body]); };
 const header = Array.from({length:15}, () => Buffer.from([20])); header[14] = str(version);
 const keyA = 'wh3_skill_innate_all_cunning', keyB = 'wh3_skill_innate_all_strong';
 const opaque = Buffer.concat([
  Buffer.from([9]), Buffer.from('ffffffffffffffff','hex'), // u64 > 2^53
  Buffer.from([10]), Buffer.from('cdcccc3d','hex'), Buffer.from([10]), Buffer.from('4523c17f','hex'), Buffer.from([10]), Buffer.from('00000080','hex'),
  Buffer.from([10]), u32(rng()), // arbitrary float32 bits, including NaNs for some seeds
  Buffer.from([14]),u32(0),str('\uFEFFraw\r\ntext\n'),
  ...Array.from({length:seed % 20}, () => Buffer.concat([Buffer.from([8]),u32(rng())])),
 ]);
 const details = key => { const fields = Array.from({length:14}, () => Buffer.from([20])); fields[12] = str('general'); fields[13] = str('wh3_main_test_hero'); return rec('CHARACTER_DETAILS',[...fields,str(key),str(key)]); };
 const root = rec('ROOT', [rec('SAVE_GAME_HEADER',header),details(keyA),details(keyB),rec('OTHER',[opaque])]);
 const size = signature === 0xabcb ? u32 : u16;
 const footer = Buffer.concat([u16(names.length),...names.flatMap(n=>[u16(n.length),Buffer.from(n)]),u32(wide.length),...wide.flatMap((s,i)=>[size(s.length),Buffer.from(s,'utf16le'),u32(i)]),u32(strings.length),...strings.flatMap((s,i)=>[size(Buffer.byteLength(s,'latin1')),Buffer.from(s,'latin1'),u32(i)])]);
 return Buffer.concat([u32(signature),u32(seed),u32(rng()),u32(16+root.length),root,footer,Buffer.from([0,0,0,0x7f])]);
}
module.exports = { fixture };

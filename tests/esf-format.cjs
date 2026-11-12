// Synthetic fixtures only: no user saves or game data in the repository.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = vm.createContext({ window: {}, TextDecoder });
for (const name of ['esf', 'savefile']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/', name + '.js'), 'utf8'), context);
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
function fixture(signature, text = 'trait') {
  const size = signature === 0xabcb ? u32 : u16;
  const utf = Buffer.from('이름', 'utf16le'), ascii = Buffer.from(text);
  return Buffer.concat([
    u32(signature), u32(0), u32(0), u32(25),
    Buffer.from([0x80, 0, 0, 0, 4, 0x08, 0, 0, 0]),
    u16(1), u16(4), Buffer.from('ROOT'),
    u32(1), size(utf.length / 2), utf, u32(7),
    u32(1), size(ascii.length), ascii, u32(42),
  ]);
}
// Container-table fixtures need not contain a valid node tree.
for (const signature of [0xabca, 0xabcb]) {
  const bytes = fixture(signature);
  const seg = context.window.TwEsf.parseContainer(bytes);
  assert.equal(seg.signature, signature);
  assert.equal(seg.utf16.get(7), '이름');
  assert.equal(seg.ascii.get(42), 'trait');
  assert.equal(seg.trailingBytes, 0);
  assert.throws(() => context.window.TwEsf.parseContainer(bytes.subarray(0, bytes.length - 1)), /truncated/);
}
assert.equal(context.window.TwEsf.parseContainer(fixture(0xabcb, 'x'.repeat(70000))).ascii.get(42).length, 70000);
assert.throws(() => context.window.TwEsf.parseContainer(fixture(0xabcd)), /unsupported/);
const chars = ['general', 'engineer'].map(type => ({ direct: new Map([[12, type], [13, 'wh3_example_subtype'], [28, 'wh3_art_set_' + type]]) }));
assert.equal(context.window.TwSave.detectFields(chars).subtypeOrdinal, 13);
console.log('PASS: ABCA/ABCB widths, Unicode, long strings, truncation, unknown signature, subtype selection');

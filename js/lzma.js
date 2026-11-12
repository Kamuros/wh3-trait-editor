/*
 * Raw LZMA1 codec (no 13-byte .lzma header). The caller supplies the 5 property
 * bytes and the uncompressed size, which is how ESF saves store compressed blocks.
 *
 * The decoder follows the LZMA specification. The encoder is deliberately simple
 * (greedy; literals, plain matches and rep0 matches only): its output is valid
 * LZMA but larger than what the game writes. Callers must round-trip its output
 * through decode() before trusting it.
 */
(function (global) {
  'use strict';

  const PROB_INIT = 1024;
  const TOP = 0x1000000;
  const CHUNK = 1 << 22; // bytes processed between progress callbacks

  // Offsets into one shared probability table.
  const IS_MATCH = 0;                       // 12 states * 16 pos states
  const IS_REP = IS_MATCH + 192;            // 12
  const IS_REP_G0 = IS_REP + 12;
  const IS_REP_G1 = IS_REP_G0 + 12;
  const IS_REP_G2 = IS_REP_G1 + 12;
  const IS_REP0_LONG = IS_REP_G2 + 12;      // 192
  const POS_SLOT = IS_REP0_LONG + 192;      // 4 * 64
  const POS_SPEC = POS_SLOT + 256;          // 115
  const ALIGN = POS_SPEC + 115;             // 16
  const LEN = ALIGN + 16;                   // 514
  const REP_LEN = LEN + 514;                // 514
  const LITERAL = REP_LEN + 514;
  // Layout inside a length coder: choice, choice2, low[16][8], mid[16][8], high[256].
  const LEN_CHOICE2 = 1, LEN_LOW = 2, LEN_MID = 130, LEN_HIGH = 258;

  function parseProps(props) {
    if (!props || props.length !== 5) throw new Error('LZMA: expected 5 property bytes');
    let d = props[0];
    if (d >= 225) throw new Error('LZMA: invalid lc/lp/pb byte');
    const lc = d % 9;
    d = (d - lc) / 9;
    const lp = d % 5;
    const pb = (d - lp) / 5;
    let dictSize = (props[1] | (props[2] << 8) | (props[3] << 16) | (props[4] << 24)) >>> 0;
    if (dictSize < 4096) dictSize = 4096;
    return { lc, lp, pb, dictSize };
  }

  function newProbs(lc, lp) {
    return new Uint16Array(LITERAL + (0x300 << (lc + lp))).fill(PROB_INIT);
  }

  async function decode(input, props, outSize, onProgress) {
    const { lc, lp, pb, dictSize } = parseProps(props);
    if (input.length < 5 || input[0] !== 0) throw new Error('LZMA: data does not start like a raw LZMA stream');
    const probs = newProbs(lc, lp);
    const out = new Uint8Array(outSize);
    const pbMask = (1 << pb) - 1, lpMask = (1 << lp) - 1, lcShift = 8 - lc;

    let inPos = 1, range = 0xFFFFFFFF, code = 0;
    for (let i = 0; i < 4; i++) code = ((code << 8) | input[inPos++]) >>> 0;
    let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0, outPos = 0;

    function bit(i) {
      const p = probs[i];
      const bound = (range >>> 11) * p;
      let result;
      if (code < bound) {
        range = bound;
        probs[i] = p + ((2048 - p) >>> 5);
        result = 0;
      } else {
        range -= bound;
        code -= bound;
        probs[i] = p - (p >>> 5);
        result = 1;
      }
      if (range < TOP) {
        range = (range << 8) >>> 0;
        code = ((code << 8) | input[inPos++]) >>> 0;
      }
      return result;
    }

    function tree(base, bits) {
      let m = 1;
      for (let i = 0; i < bits; i++) m = (m << 1) | bit(base + m);
      return m - (1 << bits);
    }

    function reverse(base, bits) {
      let m = 1, symbol = 0;
      for (let i = 0; i < bits; i++) {
        const b = bit(base + m);
        m = (m << 1) | b;
        symbol |= b << i;
      }
      return symbol;
    }

    function direct(bits) {
      let result = 0;
      for (let i = 0; i < bits; i++) {
        range >>>= 1;
        result <<= 1;
        if (code >= range) { code -= range; result |= 1; }
        if (range < TOP) {
          range = (range << 8) >>> 0;
          code = ((code << 8) | input[inPos++]) >>> 0;
        }
      }
      return result;
    }

    function length(base, posState) {
      if (bit(base) === 0) return tree(base + LEN_LOW + (posState << 3), 3);
      if (bit(base + LEN_CHOICE2) === 0) return 8 + tree(base + LEN_MID + (posState << 3), 3);
      return 16 + tree(base + LEN_HIGH, 8);
    }

    function run(limit) {
      while (outPos < limit) {
        const posState = outPos & pbMask;
        if (bit(IS_MATCH + (state << 4) + posState) === 0) {
          const prev = outPos > 0 ? out[outPos - 1] : 0;
          const base = LITERAL + 0x300 * (((outPos & lpMask) << lc) + (prev >>> lcShift));
          let symbol = 1;
          if (state >= 7) {
            let matchByte = out[outPos - rep0 - 1];
            do {
              const matchBit = (matchByte >>> 7) & 1;
              matchByte = (matchByte << 1) & 0xFF;
              const b = bit(base + ((1 + matchBit) << 8) + symbol);
              symbol = (symbol << 1) | b;
              if (matchBit !== b) break;
            } while (symbol < 0x100);
          }
          while (symbol < 0x100) symbol = (symbol << 1) | bit(base + symbol);
          out[outPos++] = symbol & 0xFF;
          state = state < 4 ? 0 : (state < 10 ? state - 3 : state - 6);
          continue;
        }

        let len;
        if (bit(IS_REP + state) !== 0) {
          if (rep0 >= outPos) throw new Error('LZMA: invalid repeat distance');
          if (bit(IS_REP_G0 + state) === 0) {
            if (bit(IS_REP0_LONG + (state << 4) + posState) === 0) {
              state = state < 7 ? 9 : 11;
              out[outPos] = out[outPos - rep0 - 1];
              outPos++;
              continue;
            }
          } else {
            let dist;
            if (bit(IS_REP_G1 + state) === 0) {
              dist = rep1;
            } else {
              if (bit(IS_REP_G2 + state) === 0) {
                dist = rep2;
              } else {
                dist = rep3;
                rep3 = rep2;
              }
              rep2 = rep1;
            }
            rep1 = rep0;
            rep0 = dist;
          }
          len = length(REP_LEN, posState);
          state = state < 7 ? 8 : 11;
        } else {
          rep3 = rep2; rep2 = rep1; rep1 = rep0;
          len = length(LEN, posState);
          state = state < 7 ? 7 : 10;
          const slot = tree(POS_SLOT + ((len < 4 ? len : 3) << 6), 6);
          if (slot < 4) {
            rep0 = slot;
          } else {
            const nb = (slot >> 1) - 1;
            let dist = ((2 | (slot & 1)) << nb) >>> 0;
            if (slot < 14) {
              dist += reverse(POS_SPEC + dist - slot, nb);
            } else {
              dist += direct(nb - 4) * 16;
              dist += reverse(ALIGN, 4);
            }
            rep0 = dist;
          }
          if (rep0 === 0xFFFFFFFF) throw new Error('LZMA: end marker reached before the declared size');
        }

        if (rep0 >= outPos || rep0 >= dictSize) throw new Error('LZMA: invalid match distance');
        len += 2;
        if (outPos + len > outSize) throw new Error('LZMA: stream is longer than the declared size');
        let src = outPos - rep0 - 1;
        for (let i = 0; i < len; i++) out[outPos++] = out[src++];
      }
    }

    while (outPos < outSize) {
      run(Math.min(outSize, outPos + CHUNK));
      if (onProgress) await onProgress(outPos / outSize);
    }
    if (inPos > input.length) throw new Error('LZMA: compressed data is truncated');
    return out;
  }

  async function encode(data, props, onProgress) {
    const { lc, lp, pb, dictSize } = parseProps(props);
    const n = data.length;
    const probs = newProbs(lc, lp);
    const pbMask = (1 << pb) - 1, lpMask = (1 << lp) - 1, lcShift = 8 - lc;

    // ---- range encoder -------------------------------------------------
    let out = new Uint8Array(Math.max(1 << 16, n >>> 2));
    let outPos = 0, low = 0, range = 0xFFFFFFFF, cache = 0, cacheSize = 1;

    function shiftLow() {
      // `low` is a 33-bit quantity held in a double; bit 32 is the carry.
      const carry = low >= 0x100000000 ? 1 : 0;
      const low32 = carry ? low - 0x100000000 : low;
      if (low32 < 0xFF000000 || carry) {
        let b = cache;
        do {
          if (outPos === out.length) {
            const grown = new Uint8Array(out.length + (out.length >>> 1) + 65536);
            grown.set(out);
            out = grown;
          }
          out[outPos++] = (b + carry) & 0xFF;
          b = 0xFF;
        } while (--cacheSize !== 0);
        cache = low32 >>> 24;
      }
      cacheSize++;
      low = (low32 & 0x00FFFFFF) * 256;
    }

    function bit(i, value) {
      const p = probs[i];
      const bound = (range >>> 11) * p;
      if (value === 0) {
        range = bound;
        probs[i] = p + ((2048 - p) >>> 5);
      } else {
        low += bound;
        range -= bound;
        probs[i] = p - (p >>> 5);
      }
      if (range < TOP) {
        range = (range << 8) >>> 0;
        shiftLow();
      }
    }

    function tree(base, bits, value) {
      let m = 1;
      for (let i = bits - 1; i >= 0; i--) {
        const b = (value >>> i) & 1;
        bit(base + m, b);
        m = (m << 1) | b;
      }
    }

    function reverse(base, bits, value) {
      let m = 1;
      for (let i = 0; i < bits; i++) {
        const b = (value >>> i) & 1;
        bit(base + m, b);
        m = (m << 1) | b;
      }
    }

    function direct(value, bits) {
      for (let i = bits - 1; i >= 0; i--) {
        range >>>= 1;
        if ((value >>> i) & 1) low += range;
        if (range < TOP) {
          range = (range << 8) >>> 0;
          shiftLow();
        }
      }
    }

    function length(base, len0, posState) {
      if (len0 < 8) {
        bit(base, 0);
        tree(base + LEN_LOW + (posState << 3), 3, len0);
      } else if (len0 < 16) {
        bit(base, 1);
        bit(base + LEN_CHOICE2, 0);
        tree(base + LEN_MID + (posState << 3), 3, len0 - 8);
      } else {
        bit(base, 1);
        bit(base + LEN_CHOICE2, 1);
        tree(base + LEN_HIGH, 8, len0 - 16);
      }
    }

    function distance(dist, len0) {
      let slot = dist;
      if (dist >= 4) {
        const top = 31 - Math.clz32(dist);
        slot = (top << 1) | ((dist >>> (top - 1)) & 1);
      }
      tree(POS_SLOT + ((len0 < 4 ? len0 : 3) << 6), 6, slot);
      if (slot >= 4) {
        const nb = (slot >> 1) - 1;
        const base = (2 | (slot & 1)) << nb;
        const rest = dist - base;
        if (slot < 14) {
          reverse(POS_SPEC + base - slot, nb, rest);
        } else {
          direct(rest >>> 4, nb - 4);
          reverse(ALIGN, 4, rest & 15);
        }
      }
    }

    // ---- hash-chain match finder ---------------------------------------
    const HASH_BITS = 20, WINDOW = 1 << 22, WMASK = WINDOW - 1;
    const MAX_LEN = 273, NICE_LEN = 128, MAX_CHAIN = 32;
    const head = new Int32Array(1 << HASH_BITS).fill(-1);
    const prev = new Int32Array(WINDOW);
    // Distances must stay inside the declared dictionary and inside the chain window.
    const maxDist = Math.min(dictSize, WINDOW - 1);
    let mainLen = 0, mainDist = 0;

    function hash(p) {
      const v = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24);
      return Math.imul(v, 0x9E3779B1) >>> (32 - HASH_BITS);
    }

    function insert(p) {
      const h = hash(p);
      prev[p & WMASK] = head[h];
      head[h] = p;
    }

    function find(p, avail) {
      const h = hash(p);
      let cand = head[h];
      prev[p & WMASK] = cand;
      head[h] = p;
      let best = 0, bestDist = 0, chain = MAX_CHAIN;
      while (cand >= 0 && chain-- > 0) {
        const d = p - cand;
        if (d > maxDist) break;
        if (data[cand + best] === data[p + best]) {
          let l = 0;
          while (l < avail && data[cand + l] === data[p + l]) l++;
          if (l > best) {
            best = l;
            bestDist = d - 1;
            if (l >= NICE_LEN || l === avail) break;
          }
        }
        cand = prev[cand & WMASK];
      }
      mainLen = best;
      mainDist = bestDist;
    }

    // ---- greedy parser ---------------------------------------------------
    let pos = 0, state = 0, rep0 = 0;

    function literal() {
      const cur = data[pos];
      const prevByte = pos > 0 ? data[pos - 1] : 0;
      const base = LITERAL + 0x300 * (((pos & lpMask) << lc) + (prevByte >>> lcShift));
      let m = 1, i = 7;
      if (state >= 7) {
        const matchByte = data[pos - rep0 - 1];
        for (; i >= 0; i--) {
          const matchBit = (matchByte >>> i) & 1, b = (cur >>> i) & 1;
          bit(base + ((1 + matchBit) << 8) + m, b);
          m = (m << 1) | b;
          if (matchBit !== b) { i--; break; }
        }
      }
      for (; i >= 0; i--) {
        const b = (cur >>> i) & 1;
        bit(base + m, b);
        m = (m << 1) | b;
      }
      state = state < 4 ? 0 : (state < 10 ? state - 3 : state - 6);
    }

    function run(limit) {
      while (pos < limit) {
        const avail = Math.min(MAX_LEN, n - pos);
        const posState = pos & pbMask;

        let repLen = 0;
        if (pos > rep0) {
          const src = pos - rep0 - 1;
          while (repLen < avail && data[src + repLen] === data[pos + repLen]) repLen++;
        }
        mainLen = 0;
        if (avail >= 4) {
          if (repLen >= NICE_LEN) insert(pos); else find(pos, avail);
        }

        const mainUsable = mainLen >= 4 && !(mainLen === 4 && mainDist >= 0x40000);
        const preferRep = repLen >= 2 && (!mainUsable || repLen + 1 >= mainLen ||
          (repLen + 2 >= mainLen && mainDist >= 512) || (repLen + 3 >= mainLen && mainDist >= 32768));

        let len = 1;
        if (preferRep) {
          len = repLen;
          bit(IS_MATCH + (state << 4) + posState, 1);
          bit(IS_REP + state, 1);
          bit(IS_REP_G0 + state, 0);
          bit(IS_REP0_LONG + (state << 4) + posState, 1);
          length(REP_LEN, len - 2, posState);
          state = state < 7 ? 8 : 11;
        } else if (mainUsable) {
          len = mainLen;
          bit(IS_MATCH + (state << 4) + posState, 1);
          bit(IS_REP + state, 0);
          length(LEN, len - 2, posState);
          state = state < 7 ? 7 : 10;
          distance(mainDist, len - 2);
          rep0 = mainDist;
        } else {
          bit(IS_MATCH + (state << 4) + posState, 0);
          literal();
        }

        const insertEnd = Math.min(pos + len, n - 3);
        for (let p = pos + 1; p < insertEnd; p++) insert(p);
        pos += len;
      }
    }

    while (pos < n) {
      run(Math.min(n, pos + CHUNK));
      if (onProgress) await onProgress(pos / n);
    }
    for (let i = 0; i < 5; i++) shiftLow();
    return out.slice(0, outPos);
  }

  global.TwLzma = { decode, encode };
})(window);

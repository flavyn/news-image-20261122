import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}

function dimensions(width, height) {
  requireValid(width >= 1 && width <= 1024 && height >= 1 && height <= 1024,
    'Image dimensions must each be between 1 and 1024');
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(bytes) {
  const seen = new Set();
  const compressed = [];
  let width, height, depth, color, interlace, paletteSize;
  let offset = 8;
  let idatEnded = false;
  let ended = false;
  let metadataBudget = 16 * 1024 * 1024;
  function inflateMetadata(data) {
    requireValid(metadataBudget > 0, 'PNG expanded metadata exceeds 16 MiB');
    const result = inflateExact(data, metadataBudget);
    metadataBudget -= result.length;
    return result;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  const beforePalette = new Set(['cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB']);
  const beforeData = new Set(['cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'bKGD', 'hIST', 'tRNS', 'pHYs', 'eXIf', 'cICP', 'mDCV', 'cLLI']);
  const singletons = new Set([...beforeData, 'PLTE', 'IHDR', 'IEND', 'tIME']);
  while (offset < bytes.length) {
    requireValid(offset + 12 <= bytes.length, 'Truncated PNG chunk');
    const length = bytes.readUInt32BE(offset);
    requireValid(length <= 0x7fffffff && offset + 12 + length <= bytes.length, 'Invalid PNG chunk length');
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    requireValid([...typeBytes].every(x => (x >= 65 && x <= 90) || (x >= 97 && x <= 122)) &&
      !(typeBytes[2] & 32), 'Invalid PNG chunk type or reserved bit');
    requireValid(crc32(bytes.subarray(offset + 4, offset + 8 + length)) === bytes.readUInt32BE(offset + 8 + length),
      `PNG ${type} checksum mismatch`);
    requireValid(seen.has('IHDR') || type === 'IHDR', 'IHDR must be first');
    requireValid(!singletons.has(type) || !seen.has(type), `Duplicate PNG ${type}`);
    requireValid(!beforePalette.has(type) || !seen.has('PLTE'), `${type} must precede PLTE`);
    requireValid(!beforeData.has(type) || !seen.has('IDAT'), `${type} must precede IDAT`);
    requireValid(!['acTL', 'fcTL', 'fdAT'].includes(type), 'Animated PNG is not supported; supply a static image');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (seen.has('IDAT') && type !== 'IDAT') idatEnded = true;
    if (type === 'IHDR') {
      requireValid(length === 13, 'IHDR must contain 13 bytes');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      dimensions(width, height);
      depth = data[8]; color = data[9]; interlace = data[12];
      requireValid(depths[color]?.includes(depth), 'Invalid PNG color type / bit depth');
      requireValid(data[10] === 0 && data[11] === 0 && interlace <= 1, 'Invalid PNG compression, filter or interlace method');
    } else if (type === 'PLTE') {
      requireValid(!seen.has('IDAT') && !seen.has('tRNS') && !seen.has('bKGD') && !seen.has('hIST'), 'PLTE out of order');
      requireValid(color !== 0 && color !== 4 && length > 0 && length <= 768 && length % 3 === 0, 'Invalid PNG palette');
      paletteSize = length / 3;
      requireValid(color !== 3 || paletteSize <= 2 ** depth, 'PNG palette exceeds bit depth');
    } else if (type === 'IDAT') {
      requireValid(!idatEnded, 'PNG IDAT chunks must be consecutive');
      requireValid(color !== 3 || paletteSize !== undefined, 'Indexed PNG requires PLTE before IDAT');
      compressed.push(data);
    } else if (type === 'IEND') {
      requireValid(length === 0 && seen.has('IDAT'), 'Invalid PNG IEND or missing IDAT');
      requireValid(offset + 12 === bytes.length, 'Trailing bytes after PNG IEND');
      ended = true;
    } else {
      requireValid(typeBytes[0] & 32, `Unknown critical PNG chunk ${type}`);
      if (type === 'tRNS') {
        requireValid((color === 0 && length === 2 && data.readUInt16BE(0) < 2 ** depth) ||
          (color === 2 && length === 6 && [0, 2, 4].every(i => data.readUInt16BE(i) < 2 ** depth)) ||
          (color === 3 && paletteSize !== undefined && length > 0 && length <= paletteSize), 'Invalid PNG transparency');
      } else if (type === 'hIST') {
        requireValid(paletteSize !== undefined && length === paletteSize * 2, 'Invalid PNG histogram');
      } else if (type === 'bKGD') {
        requireValid(color === 3 ? paletteSize !== undefined && length === 1 && data[0] < paletteSize :
          length === ([0, 4].includes(color) ? 2 : 6) &&
          Array.from({ length: length / 2 }, (_, i) => data.readUInt16BE(i * 2)).every(x => x < 2 ** depth), 'Invalid PNG background');
      } else if (type === 'sBIT') {
        const count = color === 3 ? 3 : channels[color];
        requireValid(length === count && [...data].every(x => x > 0 && x <= (color === 3 ? 8 : depth)), 'Invalid PNG significant bits');
      } else if (type === 'gAMA') {
        requireValid(length === 4 && data.readUInt32BE(0) !== 0, 'Invalid PNG gamma');
      } else if (type === 'cHRM') {
        requireValid(length === 32, 'Invalid PNG chromaticities');
      } else if (type === 'sRGB') {
        requireValid(length === 1 && data[0] <= 3 && !seen.has('iCCP'), 'Invalid or conflicting PNG sRGB');
      } else if (type === 'iCCP') {
        requireValid(!seen.has('sRGB'), 'Conflicting PNG color profiles');
        const zero = data.indexOf(0);
        requireValid(zero >= 1 && zero <= 79 && zero + 2 < length && data[zero + 1] === 0, 'Invalid PNG ICC profile header');
        const profile = inflateMetadata(data.subarray(zero + 2));
        requireValid(profile.length >= 128 && profile.readUInt32BE(0) === profile.length &&
          profile.toString('ascii', 36, 40) === 'acsp', 'Invalid PNG ICC profile');
      } else if (type === 'pHYs') {
        requireValid(length === 9 && data[8] <= 1, 'Invalid PNG physical dimensions');
      } else if (type === 'tIME') {
        requireValid(length === 7, 'Invalid PNG time length');
        const year = data.readUInt16BE(0), month = data[2], day = data[3];
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        requireValid(month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
          data[4] <= 23 && data[5] <= 59 && data[6] <= 60, 'Invalid PNG timestamp');
      } else if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
        const zero = data.indexOf(0);
        const keyword = data.subarray(0, Math.max(0, zero));
        requireValid(zero >= 1 && zero <= 79 && [...keyword].every(x => (x >= 32 && x <= 126) || x >= 161) &&
          keyword[0] !== 32 && keyword[keyword.length - 1] !== 32 && !keyword.includes(Buffer.from('  ')),
        'Invalid PNG text keyword');
        if (type === 'tEXt') requireValid(!data.subarray(zero + 1).includes(0), 'Null in PNG text');
        if (type === 'zTXt') {
          requireValid(zero + 2 < length && data[zero + 1] === 0, 'Invalid PNG compressed text header');
          requireValid(!inflateMetadata(data.subarray(zero + 2)).includes(0), 'Null in PNG text');
        }
        if (type === 'iTXt') {
          requireValid(zero + 5 <= length && data[zero + 1] <= 1 && data[zero + 2] === 0, 'Invalid PNG international text header');
          const languageEnd = data.indexOf(0, zero + 3);
          const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
          requireValid(languageEnd >= 0 && translatedEnd >= 0 &&
            /^[A-Za-z0-9-]*$/.test(data.toString('latin1', zero + 3, languageEnd)), 'Invalid PNG text language');
          const decoder = new TextDecoder('utf-8', { fatal: true });
          decoder.decode(data.subarray(languageEnd + 1, translatedEnd));
          const text = data[zero + 1] ? inflateMetadata(data.subarray(translatedEnd + 1)) : data.subarray(translatedEnd + 1);
          requireValid(!text.includes(0), 'Null in PNG international text');
          decoder.decode(text);
        }
      } else if (type === 'cICP') {
        requireValid(length === 4 && data[2] === 0 && data[3] <= 1, 'Invalid PNG coding-independent color points');
      } else if (type === 'mDCV') {
        requireValid(length === 24, 'Invalid PNG mastering display metadata');
      } else if (type === 'cLLI') {
        requireValid(length === 8, 'Invalid PNG content light metadata');
      }
    }
    seen.add(type);
    offset += length + 12;
  }
  requireValid(ended, 'Missing PNG IEND');

  // Decode every scanline, including Adam7 passes, rather than trusting zlib alone.
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const layouts = passes.map(([x, y, dx, dy]) => {
    const w = Math.max(0, Math.ceil((width - x) / dx));
    const h = Math.max(0, Math.ceil((height - y) / dy));
    return { w, h, rowBytes: Math.ceil(w * channels[color] * depth / 8) };
  }).filter(p => p.w && p.h);
  const expected = layouts.reduce((n, p) => n + (p.rowBytes + 1) * p.h, 0);
  const raw = inflateExact(Buffer.concat(compressed), expected);
  requireValid(raw.length === expected, 'PNG decompressed length disagrees with IHDR');
  const bpp = Math.max(1, Math.ceil(channels[color] * depth / 8));
  let pos = 0;
  for (const { w, h, rowBytes } of layouts) {
    let previous = Buffer.alloc(rowBytes);
    for (let y = 0; y < h; y++) {
      const filter = raw[pos++];
      requireValid(filter <= 4, 'Invalid PNG scanline filter');
      const row = Buffer.from(raw.subarray(pos, pos + rowBytes)); pos += rowBytes;
      for (let x = 0; x < rowBytes; x++) {
        const a = x >= bpp ? row[x - bpp] : 0, b = previous[x], c = x >= bpp ? previous[x - bpp] : 0;
        let predictor = 0;
        if (filter === 1) predictor = a;
        if (filter === 2) predictor = b;
        if (filter === 3) predictor = (a + b) >>> 1;
        if (filter === 4) {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        row[x] = (row[x] + predictor) & 255;
      }
      if (color === 3) {
        for (let x = 0; x < w; x++) {
          const bit = x * depth;
          const index = (row[bit >>> 3] >>> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
          requireValid(index < paletteSize, 'PNG pixel references a missing palette entry');
        }
      }
      previous = row;
    }
  }
  return { format: 'PNG', width, height };
}

function inflateExact(compressed, maxOutputLength) {
  const result = inflateSync(compressed, { maxOutputLength, info: true });
  requireValid(result.engine.bytesWritten === compressed.length, 'Trailing data in zlib stream');
  return result.buffer;
}

function validateJpeg(bytes) {
  let offset = 2, frame, restartInterval = 0, scans = 0;
  const quant = new Map(), huffman = new Map();
  function segment() {
    requireValid(offset + 2 <= bytes.length, 'Truncated JPEG segment length');
    const length = bytes.readUInt16BE(offset);
    requireValid(length >= 2 && offset + length <= bytes.length, 'Invalid JPEG segment length');
    const data = bytes.subarray(offset + 2, offset + length); offset += length;
    return data;
  }
  while (offset < bytes.length) {
    requireValid(bytes[offset++] === 0xff, 'Expected JPEG marker');
    while (bytes[offset] === 0xff) offset++;
    requireValid(offset < bytes.length, 'Truncated JPEG marker');
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      requireValid(frame && scans > 0 && offset === bytes.length, 'Incomplete JPEG or trailing bytes after EOI');
      requireValid(frame.components.every(c => c.approx[0] >= 0 && (frame.progressive || c.approx.every(x => x === 0))),
        'JPEG components are missing scans');
      return { format: 'JPEG', width: frame.width, height: frame.height };
    }
    requireValid(marker !== 0 && marker !== 0xd8 && !(marker >= 0xd0 && marker <= 0xd7) && marker !== 1,
      'Unexpected standalone JPEG marker');
    const data = segment();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      requireValid(!frame && scans === 0 && data.length >= 6, 'Invalid or duplicate JPEG frame');
      const precision = data[0], height = data.readUInt16BE(1), width = data.readUInt16BE(3), count = data[5];
      dimensions(width, height);
      requireValid(precision === 8, 'Only 8-bit Huffman JPEG frames are supported');
      requireValid(count >= 1 && count <= 4 && data.length === 6 + 3 * count, 'Invalid JPEG component count or frame length');
      const components = [];
      for (let i = 0; i < count; i++) {
        const id = data[6 + i * 3], sampling = data[7 + i * 3], q = data[8 + i * 3];
        const h = sampling >>> 4, v = sampling & 15;
        requireValid(!components.some(c => c.id === id) && h >= 1 && h <= 4 && v >= 1 && v <= 4 && q <= 3,
          'Invalid JPEG component ID, sampling or quantization selector');
        components.push({ id, h, v, q, approx: new Int8Array(64).fill(-1) });
      }
      const maxH = Math.max(...components.map(c => c.h)), maxV = Math.max(...components.map(c => c.v));
      const cols = Math.ceil(width / (8 * maxH)), rows = Math.ceil(height / (8 * maxV));
      for (const c of components) {
        c.cols = Math.ceil(width * c.h / (8 * maxH)); c.rows = Math.ceil(height * c.v / (8 * maxV));
        c.stride = cols * c.h;
        c.blocks = new Int32Array(cols * rows * c.h * c.v * 64);
      }
      frame = { width, height, components, cols, rows, progressive: marker === 0xc2, baseline: marker === 0xc0 };
    } else if (marker === 0xdb) {
      requireValid(data.length > 0, 'Empty JPEG quantization segment');
      let p = 0;
      while (p < data.length) {
        const spec = data[p++], precision = spec >>> 4, id = spec & 15;
        requireValid(precision <= 1 && id <= 3 && p + 64 * (precision + 1) <= data.length, 'Invalid JPEG quantization table');
        for (let i = 0; i < 64; i++) {
          const value = precision ? data.readUInt16BE(p) : data[p]; p += precision + 1;
          requireValid(value !== 0, 'JPEG quantization values must be nonzero');
        }
        quant.set(id, precision);
      }
    } else if (marker === 0xc4) {
      requireValid(data.length > 0, 'Empty JPEG Huffman segment');
      let p = 0;
      while (p < data.length) {
        requireValid(p + 17 <= data.length, 'Truncated JPEG Huffman table');
        const spec = data[p++], kind = spec >>> 4, id = spec & 15;
        requireValid(kind <= 1 && id <= 3, 'Invalid JPEG Huffman table selector');
        const counts = [...data.subarray(p, p + 16)]; p += 16;
        const count = counts.reduce((a, b) => a + b, 0);
        requireValid(count > 0 && count <= 256 && p + count <= data.length, 'Invalid JPEG Huffman symbol count');
        const table = new Map(), symbols = new Set();
        let code = 0;
        for (let length = 1; length <= 16; length++) {
          requireValid(code + counts[length - 1] < 2 ** length, 'Oversubscribed JPEG Huffman table or forbidden all-ones code');
          for (let i = 0; i < counts[length - 1]; i++) {
            const symbol = data[p++];
            requireValid(!symbols.has(symbol) && (kind ? (symbol & 15) <= 10 : symbol <= 11), 'Invalid JPEG Huffman symbol');
            symbols.add(symbol); table.set((1 << length) + code++, symbol);
          }
          code *= 2;
        }
        huffman.set(kind * 4 + id, table);
      }
    } else if (marker === 0xdd) {
      requireValid(data.length === 2, 'Invalid JPEG restart interval');
      restartInterval = data.readUInt16BE(0);
    } else if (marker === 0xda) {
      requireValid(frame && data.length >= 6, 'JPEG scan precedes frame or is truncated');
      const count = data[0];
      requireValid(count >= 1 && count <= frame.components.length && data.length === 4 + 2 * count, 'Invalid JPEG scan length');
      const selected = [];
      for (let i = 0; i < count; i++) {
        const c = frame.components.find(c => c.id === data[1 + i * 2]);
        const selector = data[2 + i * 2], dc = selector >>> 4, ac = selector & 15;
        requireValid(c && !selected.some(s => s.c === c) && dc <= 3 && ac <= 3 && quant.has(c.q),
          'Invalid JPEG scan component or missing quantization table');
        requireValid(!frame.baseline || (dc <= 1 && ac <= 1 && quant.get(c.q) === 0), 'Invalid baseline JPEG table');
        selected.push({ c, dc, ac });
      }
      const start = data[1 + 2 * count], end = data[2 + 2 * count];
      const high = data[3 + 2 * count] >>> 4, low = data[3 + 2 * count] & 15;
      if (frame.progressive) {
        requireValid(start <= end && end <= 63 && (start === 0 ? end === 0 : count === 1) &&
          high <= 13 && low <= 13 && (high === 0 || high === low + 1), 'Invalid progressive JPEG scan parameters');
      } else {
        requireValid(start === 0 && end === 63 && high === 0 && low === 0, 'Invalid sequential JPEG scan parameters');
      }
      requireValid(count === 1 || selected.reduce((n, s) => n + s.c.h * s.c.v, 0) <= 10, 'JPEG MCU contains too many blocks');
      for (const s of selected) {
        for (let k = start; k <= end; k++) {
          requireValid(s.c.approx[k] === (high ? high : -1), 'Duplicate or out-of-order JPEG coefficient scan');
        }
        requireValid(start === 0 || s.c.approx[0] >= 0, 'JPEG AC scan precedes DC');
        if (!high && start === 0) requireValid(huffman.has(s.dc), 'Missing JPEG DC Huffman table');
        if (end > 0) requireValid(huffman.has(4 + s.ac), 'Missing JPEG AC Huffman table');
        if (frame.progressive) requireValid(start === 0 ? s.ac === 0 : s.dc === 0, 'Unused JPEG table selector must be zero');
      }
      offset = decodeJpegScan(bytes, offset, frame, selected, start, end, high, low, restartInterval, huffman);
      for (const s of selected) for (let k = start; k <= end; k++) s.c.approx[k] = low;
      scans++;
    } else {
      requireValid((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe,
        `Unsupported JPEG marker 0x${marker.toString(16)} (only sequential/progressive Huffman DCT images are accepted)`);
    }
  }
  throw new Error('Missing JPEG EOI');
}

// Entropy decoding validates all encoded blocks without performing an IDCT or altering pixels.
function decodeJpegScan(bytes, offset, frame, selected, start, end, high, low, interval, tables) {
  let bits = 0, value = 0, eobRun = 0, restart = 0;
  const predictors = new Map(selected.map(s => [s.c.id, 0]));
  function bit() {
    if (bits === 0) {
      requireValid(offset < bytes.length, 'Truncated JPEG entropy data');
      value = bytes[offset++];
      if (value === 255) requireValid(bytes[offset++] === 0, 'Premature marker in JPEG entropy data');
      bits = 8;
    }
    return (value >>> --bits) & 1;
  }
  function receive(n) {
    let result = 0;
    for (let i = 0; i < n; i++) result = result * 2 + bit();
    return result;
  }
  function extend(n) {
    const v = receive(n);
    return n && v < 2 ** (n - 1) ? v - (2 ** n - 1) : v;
  }
  function symbol(table) {
    let code = 0;
    for (let n = 1; n <= 16; n++) {
      code = code * 2 + bit();
      const result = table.get((1 << n) + code);
      if (result !== undefined) return result;
    }
    throw new Error('Invalid JPEG Huffman code');
  }
  function align() {
    requireValid((value & ((1 << bits) - 1)) === (1 << bits) - 1, 'Invalid JPEG entropy padding');
    bits = 0;
  }
  function refine(block, k) {
    if (bit() && !(Math.abs(block[k]) & (1 << low))) block[k] += block[k] > 0 ? 1 << low : -(1 << low);
  }
  function block(s, index) {
    const data = s.c.blocks.subarray(index * 64, index * 64 + 64);
    if (start === 0) {
      if (high) data[0] |= bit() << low;
      else {
        const size = symbol(tables.get(s.dc));
        const dc = predictors.get(s.c.id) + extend(size);
        requireValid(dc >= -2047 && dc <= 2047, 'JPEG DC predictor out of range');
        predictors.set(s.c.id, dc); data[0] = dc * 2 ** low;
      }
      if (end === 0) return;
    }
    let k = Math.max(1, start);
    if (!frame.progressive || !high) {
      if (eobRun) { eobRun--; return; }
      while (k <= end) {
        const code = symbol(tables.get(4 + s.ac)), run = code >>> 4, size = code & 15;
        if (!size) {
          if (run === 15) {
            requireValid(k + 16 <= end + 1, 'JPEG zero run exceeds block'); k += 16;
          } else {
            requireValid(frame.progressive || run === 0, 'Invalid sequential JPEG end-of-block symbol');
            eobRun = frame.progressive ? 2 ** run + receive(run) - 1 : 0;
            break;
          }
        } else {
          k += run;
          requireValid(k <= end, 'JPEG coefficient run exceeds scan band');
          data[k++] = extend(size) * 2 ** low;
        }
      }
    } else {
      if (!eobRun) {
        while (k <= end) {
          const code = symbol(tables.get(4 + s.ac));
          let run = code >>> 4;
          const size = code & 15;
          requireValid(size <= 1, 'Invalid progressive JPEG refinement symbol');
          let next = 0;
          if (size) next = bit() ? 1 << low : -(1 << low);
          else if (run !== 15) { eobRun = 2 ** run + receive(run); break; }
          else run = 16;
          while (k <= end) {
            if (data[k]) refine(data, k);
            else {
              if (run === 0) break;
              run--;
            }
            k++;
            if (!size && run === 0) break;
          }
          requireValid(run === 0 && (!size || k <= end), 'JPEG refinement run exceeds scan band');
          if (size) data[k++] = next;
        }
      }
      if (eobRun) {
        while (k <= end) { if (data[k]) refine(data, k); k++; }
        eobRun--;
      }
    }
  }
  const single = selected.length === 1;
  const total = single ? selected[0].c.cols * selected[0].c.rows : frame.cols * frame.rows;
  for (let mcu = 0; mcu < total; mcu++) {
    for (const s of selected) {
      if (single) block(s, Math.floor(mcu / s.c.cols) * s.c.stride + mcu % s.c.cols);
      else {
        const x = mcu % frame.cols, y = Math.floor(mcu / frame.cols);
        for (let dy = 0; dy < s.c.v; dy++) for (let dx = 0; dx < s.c.h; dx++)
          block(s, (y * s.c.v + dy) * s.c.stride + x * s.c.h + dx);
      }
    }
    if (interval && (mcu + 1) % interval === 0 && mcu + 1 < total) {
      requireValid(eobRun === 0, 'JPEG EOB run crosses restart interval');
      align();
      requireValid(bytes[offset++] === 255, 'Missing JPEG restart marker');
      while (bytes[offset] === 255) offset++;
      requireValid(bytes[offset++] === 0xd0 + restart, 'Wrong JPEG restart marker sequence');
      restart = (restart + 1) & 7;
      for (const s of selected) predictors.set(s.c.id, 0);
    }
  }
  requireValid(eobRun === 0, 'JPEG EOB run exceeds scan');
  align();
  requireValid(bytes[offset] === 255 && bytes[offset + 1] !== 0, 'Extra or unterminated JPEG entropy data');
  return offset;
}

export function validateImage(bytes) {
  requireValid(bytes.length > 0 && bytes.length <= 1_048_576, 'Image must contain 1 to 1048576 bytes');
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return validatePng(bytes);
  if (bytes[0] === 255 && bytes[1] === 0xd8) return validateJpeg(bytes);
  throw new Error('Image must be PNG or JPEG');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const source = fileURLToPath(new URL('./entry.png', import.meta.url));
    const bytes = readFileSync(source);
    validateImage(bytes);
    const outputDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
    mkdirSync(outputDir, { recursive: true });
    const destination = join(outputDir, 'entry.png');
    if (resolve(source) !== destination) writeFileSync(destination, bytes);
  } catch (error) {
    console.error(`Image export failed: ${error.message.replace(/[\r\n]+/g, ' ')}`);
    process.exitCode = 1;
  }
}

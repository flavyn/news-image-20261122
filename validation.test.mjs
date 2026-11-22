import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateImage } from './main.ts';

const B = (...values) => Buffer.from(values);
const cat = (...parts) => Buffer.concat(parts);
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
function crc(bytes) {
  let n = 0xffffffff;
  for (const byte of bytes) {
    n ^= byte;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(type, data = B()) {
  const body = cat(Buffer.from(type), data);
  return cat(u32(data.length), body, u32(crc(body)));
}
const signature = B(137, 80, 78, 71, 13, 10, 26, 10);
function png(o = {}) {
  const w = o.w ?? 1, h = o.h ?? 1, depth = o.depth ?? 8, color = o.color ?? 2, interlace = o.interlace ?? 0;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color] ?? 1;
  const passes = interlace === 1 ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  let length = 0;
  for (const [x,y,dx,dy] of passes) {
    const pw = Math.max(0, Math.ceil((w-x)/dx)), ph = Math.max(0, Math.ceil((h-y)/dy));
    if (pw && ph) length += (1 + Math.ceil(pw*channels*depth/8))*ph;
  }
  const header = cat(u32(w), u32(h), B(depth, color, o.compression ?? 0, o.filter ?? 0, interlace));
  return cat(signature, chunk('IHDR', header), ...(o.before ?? (color === 3 ? [chunk('PLTE', B(0,0,0))] : [])),
    ...(o.dataChunks ?? [chunk('IDAT', o.compressed ?? deflateSync(o.raw ?? Buffer.alloc(length)))]),
    ...(o.after ?? []), ...(o.end === false ? [] : [chunk('IEND', o.endData)]), o.trailing ?? B());
}
function segment(marker, data) { return cat(B(255,marker),u16(data.length+2),data); }
const dqt = segment(0xdb,cat(B(0),Buffer.alloc(64,1)));
function dht(kind, values = [0], counts = [1]) {
  const sizes = Buffer.alloc(16); counts.forEach((n,i) => sizes[i] = n);
  return segment(0xc4,cat(B(kind << 4),sizes,Buffer.from(values)));
}
function sos(start=0,end=63,approx=0,entropy=B(0x3f), component=1, selector=0) {
  return cat(segment(0xda,B(1,component,selector,start,end,approx)),entropy);
}
function jpeg(o={}) {
  const frame = segment(o.marker ?? 0xc0,cat(B(o.precision ?? 8),u16(o.h ?? 1),u16(o.w ?? 1),B(1,1,o.sampling ?? 0x11,0)));
  return cat(B(255,216),o.quant ?? dqt,frame,o.tables ?? cat(dht(0),dht(1)),o.extra ?? B(),
    ...(o.scans ?? [sos()]),o.eoi === false ? B() : B(255,217),o.trailing ?? B());
}
const valid = (name, bytes, format) => test(name, () => assert.equal(validateImage(bytes).format,format));
const invalid = (name, bytes, reason) => test(name, () => assert.throws(() => validateImage(bytes),reason));

valid('final PNG is accepted unchanged',readFileSync(new URL('./entry.png',import.meta.url)),'PNG');
for (const [color,depths] of [[0,[1,2,4,8,16]],[2,[8,16]],[3,[1,2,4,8]],[4,[8,16]],[6,[8,16]]])
  for (const depth of depths) valid(`PNG color ${color} depth ${depth}`,png({color,depth}),'PNG');
for (let filter=0;filter<=4;filter++) valid(`PNG filter ${filter}`,png({raw:B(filter,12,34,56)}),'PNG');
valid('PNG Adam7 multiple passes',png({w:13,h:11,interlace:1}),'PNG');
valid('PNG Adam7 skips empty passes',png({interlace:1}),'PNG');
valid('PNG limits 1024x1024',png({w:1024,h:1024,color:0,depth:1}),'PNG');
const z = deflateSync(B(0,0,0,0));
valid('consecutive split IDAT',png({dataChunks:[chunk('IDAT',z.subarray(0,2)),chunk('IDAT'),chunk('IDAT',z.subarray(2))]}),'PNG');
valid('unknown ancillary chunk is allowed',png({after:[chunk('vpAg',B(1,2,3))]}),'PNG');
valid('PNG compressed text',png({after:[chunk('zTXt',cat(Buffer.from('Title\0'),B(0),deflateSync(Buffer.from('news'))))]}),'PNG');
valid('PNG UTF-8 international text',png({after:[chunk('iTXt',cat(Buffer.from('Title\0'),B(0,0),Buffer.from('en\0Title\0news')))]}),'PNG');
invalid('empty image',B(),/1 to/);
invalid('oversize image',Buffer.alloc(1048577),/1 to/);
invalid('wrong signature',Buffer.from('not an image'),/PNG or JPEG/);
invalid('PNG width zero',png({w:0}),/dimensions/);
invalid('PNG height above limit',png({h:1025}),/dimensions/);
invalid('PNG invalid color',png({color:1}),/color type/);
invalid('PNG invalid depth',png({depth:4}),/bit depth/);
invalid('PNG compression method',png({compression:1}),/compression/);
invalid('PNG filter method',png({filter:1}),/compression/);
invalid('PNG invalid interlace',png({interlace:2}),/interlace/);
const badCrc = png(); badCrc[29] ^= 1;
invalid('PNG CRC corruption',badCrc,/checksum/);
const hugeChunk = png(); hugeChunk.writeUInt32BE(0x80000000,8);
invalid('PNG chunk length overflow',hugeChunk,/chunk length/);
invalid('PNG incomplete chunk',png().subarray(0,38),/Truncated|length/);
invalid('PNG invalid chunk characters',png({after:[chunk('t1Xt')]}),/chunk type/);
invalid('PNG reserved chunk bit',png({after:[chunk('texT')]}),/reserved/);
invalid('PNG unknown critical chunk',png({after:[chunk('ABCD')]}),/Unknown critical/);
invalid('PNG missing IHDR',cat(signature,chunk('IEND')),/IHDR/);
invalid('PNG duplicate IHDR',png({before:[png().subarray(8,33)]}),/Duplicate/);
invalid('PNG missing IDAT',png({dataChunks:[]}),/missing IDAT/);
invalid('PNG missing IEND',png({end:false}),/IEND/);
invalid('PNG nonempty IEND',png({endData:B(0)}),/IEND/);
invalid('PNG trailing bytes',png({trailing:B(0)}),/Trailing/);
invalid('PNG nonconsecutive IDAT',png({dataChunks:[chunk('IDAT',z),chunk('tEXt',Buffer.from('x\0y')),chunk('IDAT')]}),/consecutive/);
invalid('PNG bad zlib checksum',png({compressed:Buffer.from(z.map((b,i)=>i===z.length-1?b^1:b))}),/check|data/);
invalid('PNG truncated zlib',png({compressed:z.subarray(0,z.length-1)}),/unexpected|buffer/);
invalid('PNG trailing zlib bytes',png({compressed:cat(z,B(0))}),/Trailing/);
invalid('PNG extra decompressed data',png({raw:B(0,0,0,0,0)}),/larger|length|buffer/i);
invalid('PNG missing decompressed data',png({raw:B(0,0)}),/length/);
invalid('PNG invalid row filter',png({raw:B(5,0,0,0)}),/scanline filter/);
invalid('PNG palette required',png({color:3,before:[]}),/PLTE/);
invalid('PNG palette empty',png({color:3,before:[chunk('PLTE')]}),/palette/);
invalid('PNG palette too large for bit depth',png({color:3,depth:1,before:[chunk('PLTE',Buffer.alloc(9))]}),/palette/);
invalid('PNG palette index missing',png({color:3,raw:B(0,1)}),/palette entry/);
invalid('PNG filtered palette index missing',png({color:3,w:2,raw:B(1,0,1)}),/palette entry/);
invalid('PNG grayscale PLTE forbidden',png({color:0,before:[chunk('PLTE',B(0,0,0))]}),/palette/);
invalid('PNG late PLTE',png({after:[chunk('PLTE',B(0,0,0))]}),/order/);
invalid('PNG duplicate PLTE',png({color:3,before:[chunk('PLTE',B(0,0,0)),chunk('PLTE',B(0,0,0))]}),/Duplicate/);
invalid('PNG invalid transparency',png({color:6,before:[chunk('tRNS',B(0,0))]}),/transparency/);
invalid('PNG transparency after data',png({after:[chunk('tRNS',Buffer.alloc(6))]}),/precede/);
invalid('PNG malformed histogram',png({color:3,before:[chunk('PLTE',B(0,0,0)),chunk('hIST',B(0))]}),/histogram/);
invalid('PNG invalid background palette index',png({color:3,before:[chunk('PLTE',B(0,0,0)),chunk('bKGD',B(1))]}),/background/);
invalid('PNG zero gamma',png({before:[chunk('gAMA',u32(0))]}),/gamma/);
invalid('PNG invalid sBIT',png({before:[chunk('sBIT',B(8,0,8))]}),/significant/);
invalid('PNG invalid pHYs',png({before:[chunk('pHYs',Buffer.alloc(8))]}),/physical/);
invalid('PNG invalid tIME',png({after:[chunk('tIME',B(7,234,2,30,0,0,0))]}),/timestamp/);
invalid('PNG animation rejected explicitly',png({before:[chunk('acTL',Buffer.alloc(8))]}),/Animated/);
invalid('PNG malformed text keyword',png({after:[chunk('tEXt',Buffer.from(' bad\0text'))]}),/keyword/);
invalid('PNG corrupt compressed text',png({after:[chunk('zTXt',cat(Buffer.from('x\0'),B(0,0)))]}),/check|header|buffer|unexpected/i);
invalid('PNG invalid international UTF-8',png({after:[chunk('iTXt',cat(Buffer.from('x\0'),B(0,0,0,0,255)))]}),/encoded data|encoding/i);

valid('JPEG baseline complete block',jpeg(),'JPEG');
valid('JPEG extended sequential',jpeg({marker:0xc1}),'JPEG');
valid('JPEG DC-only progressive',jpeg({marker:0xc2,scans:[sos(0,0,0,B(0x7f))]}),'JPEG');
valid('JPEG progressive AC and DC refinements',jpeg({marker:0xc2,scans:[sos(0,0,1,B(0x7f)),sos(1,63,1,B(0x7f)),sos(0,0,0x10,B(0x7f)),sos(1,63,0x10,B(0x7f))]}),'JPEG');
valid('JPEG restart interval',jpeg({w:16,extra:segment(0xdd,u16(1)),scans:[sos(0,63,0,B(0x3f,255,208,0x3f))]}),'JPEG');
valid('JPEG APP and COM segments',jpeg({extra:cat(segment(0xe1,B(1,2,3)),segment(0xfe,B(9)))}),'JPEG');
valid('JPEG stuffed entropy byte',jpeg({tables:cat(dht(0),dht(1,[0xf0,0],[0,2])),scans:[sos(0,63,0,B(0,255,0))]}),'JPEG');
valid('JPEG progressive positive AC correction and insertion',jpeg({marker:0xc2,tables:cat(dht(0),dht(1,[1,0],[0,2])),
  scans:[sos(0,0,1,B(0x7f)),sos(1,63,1,B(0x2f)),sos(0,0,0x10,B(0x7f)),sos(1,63,0x10,B(0x37))]}),'JPEG');
valid('JPEG progressive negative AC correction',jpeg({marker:0xc2,tables:cat(dht(0),dht(1,[1,0],[0,2])),
  scans:[sos(0,0,1,B(0x7f)),sos(1,63,1,B(0x0f)),sos(0,0,0x10,B(0x7f)),sos(1,63,0x10,B(0x7f))]}),'JPEG');
valid('JPEG progressive EOB run across two blocks',jpeg({marker:0xc2,w:16,tables:cat(dht(0),dht(1,[0x10])),
  scans:[sos(0,0,0,B(0x3f)),sos(1,63,0,B(0x3f))]}),'JPEG');
const colorFrame = segment(0xc0,cat(B(8),u16(9),u16(17),B(3,1,0x22,0,2,0x11,0,3,0x11,0)));
const colorScan = segment(0xda,B(3,1,0,2,0,3,0,0,63,0));
valid('JPEG interleaved chroma subsampling and edge MCUs',cat(B(255,216),dqt,colorFrame,dht(0),dht(1),colorScan,B(0,0,0),B(255,217)),'JPEG');
const nativeFixture = new URL('./test-fixtures/baseline.jpg',import.meta.url);
valid('JPEG independently encoded 37x29 RGB fixture',readFileSync(nativeFixture),'JPEG');
invalid('JPEG missing EOI',jpeg({eoi:false}),/EOI|unterminated/);
invalid('JPEG no scans',jpeg({scans:[]}),/Incomplete/);
invalid('JPEG trailing bytes',jpeg({trailing:B(0)}),/trailing/);
invalid('JPEG zero dimension',jpeg({w:0}),/dimensions/);
invalid('JPEG excessive dimension',jpeg({h:1025}),/dimensions/);
invalid('JPEG unknown coding mode',jpeg({marker:0xc3}),/Unsupported/);
invalid('JPEG unsupported precision',jpeg({precision:12}),/8-bit/);
invalid('JPEG sampling zero',jpeg({sampling:0x10}),/sampling/);
invalid('JPEG missing quantization',jpeg({quant:B()}),/quantization/);
invalid('JPEG zero quantization value',jpeg({quant:segment(0xdb,Buffer.alloc(65))}),/nonzero/);
invalid('JPEG missing Huffman table',jpeg({tables:dht(0)}),/Huffman/);
invalid('JPEG oversubscribed Huffman table',jpeg({tables:dht(0,[0,1],[2])}),/Oversubscribed/);
invalid('JPEG truncated Huffman symbols',jpeg({tables:segment(0xc4,cat(B(0,1),Buffer.alloc(15)))}),/symbol count/);
invalid('JPEG invalid DC symbol',jpeg({tables:cat(dht(0,[12]),dht(1))}),/symbol/);
invalid('JPEG invalid scan selector',jpeg({scans:[sos(0,63,0,B(0x3f),2)]}),/component/);
invalid('JPEG invalid scan band',jpeg({scans:[sos(1,63)]}),/sequential/);
invalid('JPEG duplicate component scan',jpeg({scans:[sos(),sos()]}),/Duplicate/);
invalid('JPEG progressive AC before DC',jpeg({marker:0xc2,scans:[sos(1,63,0,B(0x7f))]}),/precedes DC/);
invalid('JPEG progressive out-of-order refinement',jpeg({marker:0xc2,scans:[sos(0,0,0x10,B(0x7f))]}),/out-of-order/);
invalid('JPEG entropy missing',jpeg({scans:[sos(0,63,0,B())]}),/Premature/);
invalid('JPEG invalid entropy code',jpeg({scans:[sos(0,63,0,B(0xff,0))]}),/Premature|Huffman/);
invalid('JPEG invalid entropy padding',jpeg({scans:[sos(0,63,0,B(0))]}),/padding/);
invalid('JPEG extra entropy byte',jpeg({scans:[sos(0,63,0,B(0x3f,0))]}),/Extra/);
invalid('JPEG wrong restart number',jpeg({w:16,extra:segment(0xdd,u16(1)),scans:[sos(0,63,0,B(0x3f,255,209,0x3f))]}),/restart/);
invalid('JPEG missing restart marker',jpeg({w:16,extra:segment(0xdd,u16(1)),scans:[sos(0,63,0,B(0x3f,0x3f))]}),/restart/);
invalid('JPEG premature EOI before all MCUs',jpeg({w:16}),/Premature|Huffman/);
invalid('JPEG AC zero run overflow',jpeg({tables:cat(dht(0),dht(1,[0xf0]))}),/zero run|Premature|Huffman/);
invalid('JPEG progressive EOB run exceeds scan',jpeg({marker:0xc2,tables:cat(dht(0),dht(1,[0x10])),
  scans:[sos(0,0,0,B(0x7f)),sos(1,63,0,B(0x3f))]}),/EOB run/);
invalid('JPEG segment length below two',cat(B(255,216,255,219),u16(1),B(255,217)),/segment length/);
invalid('JPEG truncated segment',cat(B(255,216,255,219),u16(100),B(0)),/segment length/);
invalid('JPEG unexpected SOI',cat(B(255,216,255,216),jpeg()),/standalone/);

invalid('PNG malformed cICP',png({before:[chunk('cICP',B(1,1,1,1))]}),/coding-independent/);
invalid('PNG malformed mDCV',png({before:[chunk('mDCV',B(0))]}),/mastering/);
invalid('PNG malformed cLLI',png({before:[chunk('cLLI',B(0))]}),/content light/);
invalid('PNG metadata decompression bomb',png({after:[chunk('zTXt',cat(Buffer.from('x\0'),B(0),deflateSync(Buffer.alloc(16*1024*1024+1,65))))]}),/larger|buffer|length/i);

test('CLI validates before creating output; failure is one stderr line', () => {
  const dir = mkdtempSync(join(tmpdir(),'news-image-validation-'));
  try {
    copyFileSync(new URL('./main.ts',import.meta.url),join(dir,'main.ts'));
    copyFileSync(new URL('./package.json',import.meta.url),join(dir,'package.json'));
    writeFileSync(join(dir,'entry.png'),png({raw:B(5,0,0,0)}));
    const result = spawnSync(process.execPath,[join(dir,'main.ts')],{encoding:'utf8',env:{...process.env,MAKEFUN_OUTPUT_DIR:join(dir,'output')}});
    assert.equal(result.status,1);
    assert.equal(result.stdout,'');
    assert.equal(result.stderr.trim().split(/\r?\n/).length,1,result.stderr);
    assert.match(result.stderr,/scanline filter/);
    assert.equal(existsSync(join(dir,'output')),false);
    mkdirSync(join(dir,'output'));
    const previous = Buffer.from('previous output');
    writeFileSync(join(dir,'output','entry.png'),previous);
    const second = spawnSync(process.execPath,[join(dir,'main.ts')],{encoding:'utf8',env:{...process.env,MAKEFUN_OUTPUT_DIR:join(dir,'output')}});
    assert.equal(second.status,1);
    assert.deepEqual(readFileSync(join(dir,'output','entry.png')),previous);
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/'));
    rmSync(dir,{recursive:true,force:true});
  }
});

test('CLI exports final image byte-for-byte twice', () => {
  const dir = mkdtempSync(join(tmpdir(),'news-image-export-'));
  try {
    const original = readFileSync(new URL('./entry.png',import.meta.url));
    for (const run of ['one','two']) {
      const result = spawnSync(process.execPath,['main.ts'],{encoding:'utf8',env:{...process.env,MAKEFUN_OUTPUT_DIR:join(dir,run)}});
      assert.equal(result.status,0,result.stderr);
      assert.equal(result.stderr,'');
      assert.deepEqual(readFileSync(join(dir,run,'entry.png')),original);
    }
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/'));
    rmSync(dir,{recursive:true,force:true});
  }
});

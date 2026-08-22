import {
  approvedRecordSummary,
  categoryCredit,
  durationLabel,
  eventDate,
  number,
  timeDetails,
} from './portal-record.js';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LEFT = 48;
const TOP = 744;
const BOTTOM = 48;
const LINE_HEIGHT = 14;
const encoder = new TextEncoder();

const asBytes = (value) => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('A bundled PDF font is required.');
};

const hex4 = (value) => value.toString(16).toUpperCase().padStart(4, '0');

const unicodeHex = (codePoint) => {
  if (codePoint <= 0xffff) return hex4(codePoint);
  const adjusted = codePoint - 0x10000;
  return `${hex4(0xd800 + (adjusted >> 10))}${hex4(0xdc00 + (adjusted & 0x3ff))}`;
};

function parseTrueType(value, name) {
  const bytes = asBytes(value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map();
  const tableCount = view.getUint16(4);
  for (let index = 0; index < tableCount; index += 1) {
    const offset = 12 + index * 16;
    const tag = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    tables.set(tag, { offset: view.getUint32(offset + 8), length: view.getUint32(offset + 12) });
  }
  const need = (tag) => {
    const table = tables.get(tag);
    if (!table) throw new Error(`${name} has no ${tag} table.`);
    return table.offset;
  };

  const head = need('head');
  const hhea = need('hhea');
  const maxp = need('maxp');
  const hmtx = need('hmtx');
  const unitsPerEm = view.getUint16(head + 18);
  const numberOfHMetrics = view.getUint16(hhea + 34);
  const glyphCount = view.getUint16(maxp + 4);
  const advances = [];
  let lastAdvance = unitsPerEm;
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    if (glyph < numberOfHMetrics) lastAdvance = view.getUint16(hmtx + glyph * 4);
    advances.push(lastAdvance);
  }

  const cmap = need('cmap');
  const candidates = [];
  const cmapCount = view.getUint16(cmap + 2);
  for (let index = 0; index < cmapCount; index += 1) {
    const record = cmap + 4 + index * 8;
    const platform = view.getUint16(record);
    const offset = cmap + view.getUint32(record + 4);
    const format = view.getUint16(offset);
    if (format === 4 || format === 12) candidates.push({ platform, offset, format });
  }
  candidates.sort(
    (a, b) =>
      (b.format === 12 ? 10 : 0) - (a.format === 12 ? 10 : 0) ||
      (b.platform === 3 ? 2 : b.platform === 0 ? 1 : 0) -
        (a.platform === 3 ? 2 : a.platform === 0 ? 1 : 0),
  );
  const selected = candidates[0];
  if (!selected) throw new Error(`${name} has no Unicode cmap.`);

  let glyphFor;
  if (selected.format === 12) {
    const groupCount = view.getUint32(selected.offset + 12);
    const groups = Array.from({ length: groupCount }, (_, index) => {
      const offset = selected.offset + 16 + index * 12;
      return [view.getUint32(offset), view.getUint32(offset + 4), view.getUint32(offset + 8)];
    });
    glyphFor = (codePoint) => {
      let low = 0;
      let high = groups.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const [start, end, firstGlyph] = groups[middle];
        if (codePoint < start) high = middle - 1;
        else if (codePoint > end) low = middle + 1;
        else return firstGlyph + codePoint - start;
      }
      return 0;
    };
  } else {
    const segmentCount = view.getUint16(selected.offset + 6) / 2;
    const ends = selected.offset + 14;
    const starts = ends + segmentCount * 2 + 2;
    const deltas = starts + segmentCount * 2;
    const ranges = deltas + segmentCount * 2;
    glyphFor = (codePoint) => {
      if (codePoint > 0xffff) return 0;
      for (let index = 0; index < segmentCount; index += 1) {
        const end = view.getUint16(ends + index * 2);
        if (codePoint > end) continue;
        const start = view.getUint16(starts + index * 2);
        if (codePoint < start) return 0;
        const delta = view.getInt16(deltas + index * 2);
        const range = view.getUint16(ranges + index * 2);
        if (!range) return (codePoint + delta) & 0xffff;
        const glyphOffset = ranges + index * 2 + range + (codePoint - start) * 2;
        if (glyphOffset + 2 > bytes.byteLength) return 0;
        const glyph = view.getUint16(glyphOffset);
        return glyph ? (glyph + delta) & 0xffff : 0;
      }
      return 0;
    };
  }

  const used = new Map();
  const cids = new Map();
  return {
    name,
    bytes,
    unitsPerEm,
    ascent: view.getInt16(hhea + 4),
    descent: view.getInt16(hhea + 6),
    bbox: [
      view.getInt16(head + 36),
      view.getInt16(head + 38),
      view.getInt16(head + 40),
      view.getInt16(head + 42),
    ],
    glyphFor,
    width(glyph) {
      return advances[glyph] ?? advances[0] ?? unitsPerEm;
    },
    encode(codePoint) {
      const glyph = glyphFor(codePoint);
      if (!glyph) return null;
      if (!cids.has(codePoint)) {
        const cid = cids.size + 1;
        cids.set(codePoint, cid);
        used.set(cid, { codePoint, glyph });
      }
      return cids.get(codePoint);
    },
    used,
  };
}

function createFontBook(fontBytes, fallbackFontBytes) {
  const fonts = [
    parseTrueType(fontBytes, 'PublicSans'),
    parseTrueType(fallbackFontBytes, 'NotoSans'),
  ];
  const find = (codePoint) => {
    const font = fonts.find((candidate) => candidate.glyphFor(codePoint));
    if (!font) {
      throw new Error(`The bundled PDF fonts do not support U+${codePoint.toString(16).toUpperCase()}.`);
    }
    return font;
  };
  const measure = (value, size) =>
    [...String(value ?? '')].reduce((total, character) => {
      const codePoint = character.codePointAt(0);
      const font = find(codePoint);
      return total + (font.width(font.glyphFor(codePoint)) / font.unitsPerEm) * size;
    }, 0);
  const runs = (value) => {
    const out = [];
    for (const character of String(value ?? '')) {
      const codePoint = character.codePointAt(0);
      const font = find(codePoint);
      const fontIndex = fonts.indexOf(font);
      const cid = font.encode(codePoint);
      const last = out[out.length - 1];
      if (!last || last.fontIndex !== fontIndex) out.push({ fontIndex, cids: [cid] });
      else last.cids.push(cid);
    }
    return out;
  };
  return { fonts, measure, runs };
}

function splitLongWord(word, maxWidth, size, fontBook) {
  const parts = [];
  let part = '';
  for (const character of word) {
    if (part && fontBook.measure(`${part}${character}`, size) > maxWidth) {
      parts.push(part);
      part = character;
    } else {
      part += character;
    }
  }
  if (part) parts.push(part);
  return parts;
}

function wrap(value, maxWidth, size, fontBook) {
  const words = String(value ?? '').split(/\s+/u).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidates = fontBook.measure(word, size) > maxWidth
      ? splitLongWord(word, maxWidth, size, fontBook)
      : [word];
    for (const candidate of candidates) {
      const next = line ? `${line} ${candidate}` : candidate;
      if (!line || fontBook.measure(next, size) <= maxWidth) line = next;
      else {
        lines.push(line);
        line = candidate;
      }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function requirementLines(card) {
  return (card?.requirements ?? [])
    .filter((row) => row.type !== 'group')
    .map(
      (row) =>
        `${row.passed ? 'Met' : 'Not met'}  ${row.label}: ${number(row.value)} of ${number(
          row.target,
        )}`,
    );
}

export function attendancePdfFilename(card) {
  const slug = String(card?.member?.display_name ?? 'member')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'member';
  const year = String(card?.year?.label ?? 'current-year')
    .replace(/[^0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `pdsa-attendance-${slug}-${year || 'current-year'}.pdf`;
}

function buildPages(card, attendance, generatedAt, fontBook) {
  const { approved, recordedMinutes, missingTimes } = approvedRecordSummary(attendance?.events);
  const pages = [[]];
  let y = TOP;
  const page = () => pages[pages.length - 1];
  const newPage = () => {
    pages.push([]);
    y = TOP;
  };
  const wrapped = (value, size, indent) =>
    wrap(value, PAGE_WIDTH - LEFT * 2 - indent, size, fontBook);
  const add = (value, { size = 10, bold = false, indent = 0, gap = 0 } = {}) => {
    for (const line of wrapped(value, size, indent)) {
      if (y < BOTTOM + LINE_HEIGHT) newPage();
      page().push({ text: line, x: LEFT + indent, y, size, bold });
      y -= LINE_HEIGHT;
    }
    y -= gap;
  };
  const ensure = (lineCount) => {
    if (y - lineCount * LINE_HEIGHT < BOTTOM) newPage();
  };

  add('Pre-Dental Student Association at UCF', { size: 11, bold: true });
  add('Attendance Record', { size: 20, bold: true, gap: 8 });
  add(`Member: ${card?.member?.display_name ?? ''}`);
  add(`Academic year: ${card?.year?.label ?? ''}`);
  add(
    `Generated: ${new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(generatedAt)}`,
  );
  add(`Honorary Member status: ${card?.is_honorary ? 'Honorary Member' : 'Not yet'}`);
  add(`Total points: ${number(card?.point_total)}`, { gap: 8 });

  add('Requirement progress', { size: 13, bold: true, gap: 2 });
  for (const line of requirementLines(card)) add(line, { indent: 8 });
  y -= 6;

  add('Approved events', { size: 13, bold: true, gap: 2 });
  add(`Approved events: ${approved.length}`);
  add(`Recorded duration: ${durationLabel(recordedMinutes)}`);
  add(`Approved events without recorded duration: ${missingTimes}`, { gap: 6 });

  const tableHeading = () => add('Event | Date | Time | Duration | Categories and credit', { bold: true });
  tableHeading();
  if (!approved.length) add('No approved events.');
  for (const event of approved) {
    const time = timeDetails(event);
    const lines = [
      `${event.title} | ${eventDate(event.occurred_on)}`,
      [time.range, time.duration].filter(Boolean).join(' | '),
      (event.categories ?? []).map(categoryCredit).join(', ') || 'No category credit',
    ];
    ensure(lines.reduce((sum, line) => sum + wrapped(line, 10, 8).length, 0) + 1);
    if (pages.length > 1 && page().length === 0) tableHeading();
    for (const line of lines) add(line, { indent: 8 });
    y -= 4;
  }
  return pages;
}

const concatBytes = (chunks) => {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const streamObject = (data, extra = '') => ({ data, extra });

function toUnicodeCmap(font) {
  const entries = [...font.used.entries()].sort(([a], [b]) => a - b);
  const sections = [];
  for (let index = 0; index < entries.length; index += 100) {
    const chunk = entries.slice(index, index + 100);
    sections.push(
      `${chunk.length} beginbfchar\n${chunk
        .map(([cid, item]) => `<${hex4(cid)}> <${unicodeHex(item.codePoint)}>`)
        .join('\n')}\nendbfchar`,
    );
  }
  return encoder.encode(
    `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n` +
      `/CMapName /PDSA${font.name}UCS def\n/CMapType 2 def\n` +
      `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n` +
      `${sections.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`,
  );
}

function cidToGlyphMap(font) {
  const maxCid = Math.max(0, ...font.used.keys());
  const output = new Uint8Array((maxCid + 1) * 2);
  for (const [cid, item] of font.used) {
    output[cid * 2] = item.glyph >> 8;
    output[cid * 2 + 1] = item.glyph & 0xff;
  }
  return output;
}

function scaled(font, value) {
  return Math.round((value / font.unitsPerEm) * 1000);
}

function encodePdf(pages, fontBook) {
  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = addObject('');
  const pagesRoot = addObject('');

  const commandPages = pages.map((lines) =>
    lines
      .map((line) => {
        const runs = fontBook.runs(line.text);
        const commands = runs
          .map(
            (run) =>
              `/F${run.fontIndex + 1} ${line.size} Tf <${run.cids.map(hex4).join('')}> Tj`,
          )
          .join(' ');
        return `BT ${line.bold ? '2 Tr 0.25 w' : '0 Tr'} 1 0 0 1 ${line.x} ${line.y} Tm ${commands} ET`;
      })
      .join('\n'),
  );

  const fontIds = fontBook.fonts.map((font) => {
    const fontFile = addObject(streamObject(font.bytes, `/Length1 ${font.bytes.byteLength}`));
    const bbox = font.bbox.map((value) => scaled(font, value)).join(' ');
    const descriptor = addObject(
      `<< /Type /FontDescriptor /FontName /${font.name} /Flags 32 /FontBBox [${bbox}] ` +
        `/ItalicAngle 0 /Ascent ${scaled(font, font.ascent)} /Descent ${scaled(font, font.descent)} ` +
        `/CapHeight ${scaled(font, font.ascent)} /StemV 80 /FontFile2 ${fontFile} 0 R >>`,
    );
    const toUnicode = addObject(streamObject(toUnicodeCmap(font)));
    const cidMap = addObject(streamObject(cidToGlyphMap(font)));
    const widths = [...font.used.entries()]
      .sort(([a], [b]) => a - b)
      .map(([cid, item]) => `${cid} [${scaled(font, font.width(item.glyph))}]`)
      .join(' ');
    const descendant = addObject(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${font.name} ` +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
        `/FontDescriptor ${descriptor} 0 R /DW 1000 /W [${widths}] /CIDToGIDMap ${cidMap} 0 R >>`,
    );
    return addObject(
      `<< /Type /Font /Subtype /Type0 /BaseFont /${font.name} /Encoding /Identity-H ` +
        `/DescendantFonts [${descendant} 0 R] /ToUnicode ${toUnicode} 0 R >>`,
    );
  });

  const pageIds = [];
  for (const commands of commandPages) {
    const content = encoder.encode(commands);
    const contentId = addObject(streamObject(content));
    const resources = fontIds.map((id, index) => `/F${index + 1} ${id} 0 R`).join(' ');
    const pageId = addObject(
      `<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << ${resources} >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`;
  objects[pagesRoot - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  const chunks = [encoder.encode('%PDF-1.4\n%PDSA\n')];
  const offsets = [0];
  let byteLength = chunks[0].byteLength;
  objects.forEach((body, index) => {
    offsets.push(byteLength);
    const prefix = encoder.encode(`${index + 1} 0 obj\n`);
    let bodyBytes;
    if (typeof body === 'string') {
      bodyBytes = encoder.encode(body);
    } else {
      const streamPrefix = encoder.encode(
        `<< /Length ${body.data.byteLength}${body.extra ? ` ${body.extra}` : ''} >>\nstream\n`,
      );
      bodyBytes = concatBytes([streamPrefix, body.data, encoder.encode('\nendstream')]);
    }
    const objectBytes = concatBytes([prefix, bodyBytes, encoder.encode('\nendobj\n')]);
    chunks.push(objectBytes);
    byteLength += objectBytes.byteLength;
  });
  const xref = byteLength;
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    trailer += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  chunks.push(encoder.encode(trailer));
  return new Blob(chunks, { type: 'application/pdf' });
}

export async function loadAttendancePdfFonts(fetchImpl = fetch) {
  const baseUrl = globalThis.window?.location?.href ?? import.meta.url;
  const fontUrl = new URL('../assets/fonts/public-sans/PublicSans-Regular.ttf', baseUrl);
  const fallbackFontUrl = new URL('../assets/fonts/public-sans/NotoSans-Regular.ttf', baseUrl);
  const load = async (url) => {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error('PDF font unavailable.');
    return new Uint8Array(await response.arrayBuffer());
  };
  const [fontBytes, fallbackFontBytes] = await Promise.all([
    load(fontUrl),
    load(fallbackFontUrl),
  ]);
  return { fontBytes, fallbackFontBytes };
}

export function buildAttendancePdf({
  card,
  attendance,
  fontBytes,
  fallbackFontBytes,
  generatedAt = new Date(),
}) {
  if (!card?.member || !attendance?.events) throw new Error('Attendance data is incomplete.');
  const fontBook = createFontBook(fontBytes, fallbackFontBytes);
  return encodePdf(buildPages(card, attendance, generatedAt, fontBook), fontBook);
}

export function saveAttendancePdf(blob, filename, { documentRef = document, urlApi = URL } = {}) {
  const href = urlApi.createObjectURL(blob);
  const link = documentRef.createElement('a');
  link.href = href;
  link.download = filename;
  link.hidden = true;
  documentRef.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => urlApi.revokeObjectURL(href), 0);
}

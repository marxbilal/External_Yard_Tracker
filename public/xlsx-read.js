// Reads the worksheets of an Excel .xlsx file in the browser, with no library.
// An .xlsx file is a zip of XML files; the browser unzips (DecompressionStream) and parses the XML (DOMParser).
// readWorkbook(arrayBuffer) -> { date1904, sheets: [{ name, rows: async () => [{ n, cells }] }] }
//   n     = the row number as Excel shows it
//   cells = text for text cells, a number for number and date cells (dates are Excel serial numbers)
(function (root) {
  'use strict';
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const NOT_XLSX = 'This file could not be read as an Excel .xlsx file';

  function zipIndex(buf) {
    const b = new Uint8Array(buf);
    let end = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error(NOT_XLSX);
    const files = new Map(), dec = new TextDecoder();
    let p = u32(b, end + 16);
    for (let k = u16(b, end + 10); k > 0 && p + 46 <= b.length && u32(b, p) === 0x02014b50; k--) {
      const nlen = u16(b, p + 28);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nlen)).replace(/\\/g, '/');
      files.set(name.toLowerCase(), { method: u16(b, p + 10), size: u32(b, p + 20), off: u32(b, p + 42) });
      p += 46 + nlen + u16(b, p + 30) + u16(b, p + 32);
    }
    return { b, files };
  }

  async function entryText(zip, name) {
    const f = zip.files.get(name.replace(/^\//, '').toLowerCase());
    if (!f) return null;
    const { b } = zip, start = f.off + 30 + u16(b, f.off + 26) + u16(b, f.off + 28);
    const data = b.subarray(start, start + f.size);
    if (f.method === 0) return new TextDecoder().decode(data);
    if (f.method !== 8) throw new Error(NOT_XLSX);
    return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  }

  const xml = text => {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error(NOT_XLSX);
    return doc;
  };
  const all = (node, tag) => node.getElementsByTagNameNS('*', tag);
  const kids = (node, tag) => [...node.children].filter(e => e.localName === tag);
  const attrLocal = (el, local) => { for (const a of el.attributes) if (a.localName === local) return a.value; return null; };
  // text of a string item, leaving out phonetic guides
  const runText = el => [...all(el, 't')].filter(t => t.parentNode.localName !== 'rPh').map(t => t.textContent).join('');
  function colIndex(ref) {
    let n = 0;
    for (const ch of ref.toUpperCase()) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + c - 64; }
    return n - 1;
  }

  function parseSheet(doc, shared) {
    const rows = [];
    for (const row of all(doc, 'row')) {
      const cells = [];
      let next = 0;
      for (const c of kids(row, 'c')) {
        const ref = c.getAttribute('r');
        const ci = ref ? colIndex(ref) : next;
        next = ci + 1;
        const t = c.getAttribute('t'), vEl = kids(c, 'v')[0], v = vEl ? vEl.textContent : null;
        let val;
        if (t === 's') val = v === null ? '' : (shared[Number(v)] ?? '');
        else if (t === 'inlineStr') val = kids(c, 'is').map(runText).join('');
        else if (t === 'str' || t === 'd') val = v ?? '';
        else if (t === 'b') val = v === '1' ? 'TRUE' : v === null ? '' : 'FALSE';
        else if (t === 'e') val = '';
        else val = v === null || v === '' ? '' : Number(v);
        if (ci >= 0) cells[ci] = val;
      }
      rows.push({ n: Number(row.getAttribute('r')) || rows.length + 1, cells: Array.from(cells, x => (x === undefined ? '' : x)) });
    }
    return rows;
  }

  async function readWorkbook(buf) {
    const zip = zipIndex(buf);
    const wbText = await entryText(zip, 'xl/workbook.xml');
    if (!wbText) throw new Error(NOT_XLSX);
    const wb = xml(wbText);
    const pr = all(wb, 'workbookPr')[0];
    const date1904 = !!pr && /^(1|true)$/i.test(pr.getAttribute('date1904') || '');
    const rels = new Map();
    const relText = await entryText(zip, 'xl/_rels/workbook.xml.rels');
    if (relText) for (const r of all(xml(relText), 'Relationship')) rels.set(r.getAttribute('Id'), r.getAttribute('Target'));
    let shared = null;
    const loadShared = async () => {
      if (shared) return shared;
      const s = await entryText(zip, 'xl/sharedStrings.xml');
      shared = s ? [...all(xml(s), 'si')].map(runText) : [];
      return shared;
    };
    const sheets = [...all(wb, 'sheet')].map((s, i) => {
      const target = rels.get(attrLocal(s, 'id')) || `worksheets/sheet${i + 1}.xml`;
      const file = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      return {
        name: s.getAttribute('name') || `Sheet${i + 1}`,
        rows: async () => { const t = await entryText(zip, file); return t ? parseSheet(xml(t), await loadShared()) : []; },
      };
    });
    return { date1904, sheets };
  }

  // Excel date serial number -> YYYY-MM-DD
  function serialToISO(n, date1904) {
    const ms = Date.UTC(1899, 11, 30) + (Math.floor(n) + (date1904 ? 1462 : 0)) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  root.readWorkbook = readWorkbook;
  root.excelSerialToISO = serialToISO;
})(typeof window !== 'undefined' ? window : globalThis);

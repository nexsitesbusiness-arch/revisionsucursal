// Lectura de códigos GS1 (DataMatrix / GS1-128) que traen GTIN, lote y vencimiento.
// Ej: "]d2010779012345678917261231101ABC123" -> { gtin, lote: "1ABC123", vencimiento: "2026-12-31" }
(function (global) {
  const GS = '\u001d';
  // Largo fijo de los AI más comunes (sin contar el AI).
  const FIXED = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };
  const VARIABLE = ['10', '21', '22', '240', '241', '30', '37', '90', '91', '92', '93', '94', '95', '96', '97', '98', '99'];

  function yymmdd(s) {
    if (!/^\d{6}$/.test(s)) return s;
    const yy = +s.slice(0, 2), mm = s.slice(2, 4);
    let dd = s.slice(4, 6);
    const year = 2000 + yy;
    if (dd === '00') dd = String(new Date(year, +mm, 0).getDate()).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }

  function parse(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    // Formato legible: (01)07790123456789(10)ABC123(17)261231
    if (/^\(\d{2,4}\)/.test(s)) {
      const out = {};
      const re = /\((\d{2,4})\)([^(]*)/g;
      let m;
      while ((m = re.exec(s))) out[m[1]] = m[2].trim();
      return build(out);
    }
    // Prefijos de simbología: ]d2 (DataMatrix), ]C1 (GS1-128), ]Q3 (QR)
    s = s.replace(/^\][A-Za-z]\d/, '');
    if (s.startsWith(GS)) s = s.slice(1);
    if (!/^(01|02|00)\d/.test(s)) return null;

    const out = {};
    let i = 0;
    while (i < s.length) {
      if (s[i] === GS) { i++; continue; }
      let ai = s.slice(i, i + 2);
      if (FIXED[ai] !== undefined) {
        out[ai] = s.slice(i + 2, i + 2 + FIXED[ai]);
        i += 2 + FIXED[ai];
        continue;
      }
      const ai3 = s.slice(i, i + 3);
      if (VARIABLE.includes(ai3)) ai = ai3;
      else if (!VARIABLE.includes(ai)) break; // AI desconocido: paramos
      const start = i + ai.length;
      let end = s.indexOf(GS, start);
      if (end === -1) end = s.length;
      let val = s.slice(start, end);
      // Sin separador GS: si a un lote le sigue "17" + 6 dígitos al final, lo separamos.
      if (ai === '10' && end === s.length) {
        const m = val.match(/^(.+?)17(\d{6})$/);
        if (m) { out['17'] = m[2]; val = m[1]; }
      }
      out[ai] = val;
      i = end;
    }
    return build(out);
  }

  function build(o) {
    const gtin = o['01'] || o['02'];
    if (!gtin) return null;
    return {
      gtin,
      lote: o['10'] || '',
      vencimiento: o['17'] ? yymmdd(o['17']) : '',
      serie: o['21'] || '',
    };
  }

  global.GS1 = { parse };
})(typeof window !== 'undefined' ? window : globalThis);

// Lectura de pedidos desde Word (.docx), PDF y fotos de la hoja (reconocimiento de texto).
// Las librerías se descargan solo cuando se usan, para que la app abra rápido.
(function (global) {
  'use strict';

  const LIBS = {
    mammoth: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
    pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  };
  const loaded = {};
  function loadScript(url) {
    if (!loaded[url]) {
      loaded[url] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => { delete loaded[url]; reject(new Error('No se pudo descargar el lector. Revisa la conexión a internet.')); };
        document.head.appendChild(s);
      });
    }
    return loaded[url];
  }

  // ---------- Word ----------
  async function fromWord(file) {
    if (/\.doc$/i.test(file.name)) throw new Error('Este es un Word antiguo (.doc). Ábrelo en Word y guárdalo como .docx.');
    await loadScript(LIBS.mammoth);
    const buf = await file.arrayBuffer();
    const { value: html } = await global.mammoth.convertToHtml({ arrayBuffer: buf });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tables = [...doc.querySelectorAll('table')].map((t) =>
      [...t.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td,th')].map((c) => c.textContent.replace(/\s+/g, ' ').trim())));
    const lines = [...doc.querySelectorAll('p, li')].map((p) => p.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return { tables, lines };
  }

  // ---------- PDF ----------
  async function fromPdf(file) {
    await loadScript(LIBS.pdfjs);
    const pdfjs = global.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const { items } = await page.getTextContent();
      const words = items.filter((it) => it.str && it.str.trim()).map((it) => ({
        t: it.str, x0: it.transform[4], x1: it.transform[4] + (it.width || 0), y: it.transform[5], h: Math.abs(it.transform[3]) || 10,
      }));
      // Agrupa por altura (misma fila) y ordena de arriba hacia abajo.
      words.sort((a, b) => b.y - a.y || a.x0 - b.x0);
      let cur = null;
      for (const w of words) {
        if (!cur || Math.abs(cur.y - w.y) > Math.max(3, w.h * 0.4)) { cur = { y: w.y, words: [] }; lines.push(cur); }
        cur.words.push(w);
      }
    }
    return toCells(lines.map((l) => l.words.sort((a, b) => a.x0 - b.x0)));
  }

  // ---------- Foto (reconocimiento de texto) ----------
  async function fromImage(file, onProgress) {
    await loadScript(LIBS.tesseract);
    const img = await prepareImage(file);
    const worker = await global.Tesseract.createWorker('spa', 1, {
      logger: (m) => { if (m.status === 'recognizing text' && onProgress) onProgress(Math.round(m.progress * 100)); },
    });
    try {
      // Modo "texto disperso": lee cada celda por separado; las filas se arman por posición.
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      const { data } = await worker.recognize(img);
      const words = (data.words || []).filter((w) => w.text && w.text.trim() && w.confidence > 20).map((w) => ({
        t: w.text.trim(), x0: w.bbox.x0, x1: w.bbox.x1, yc: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0,
      }));
      return toCells(groupRows(words));
    } finally {
      await worker.terminate();
    }
  }

  // Agrupa palabras en filas según su altura en la imagen.
  function groupRows(words) {
    if (!words.length) return [];
    const hs = words.map((w) => w.h).sort((a, b) => a - b);
    const tol = hs[Math.floor(hs.length / 2)] * 0.6;
    words.sort((a, b) => a.yc - b.yc);
    const rows = [];
    for (const w of words) {
      const r = rows[rows.length - 1];
      if (r && Math.abs(w.yc - r.yc) <= tol) { r.ws.push(w); r.yc = (r.yc * (r.ws.length - 1) + w.yc) / r.ws.length; }
      else rows.push({ yc: w.yc, ws: [w] });
    }
    return rows.map((r) => r.ws.sort((a, b) => a.x0 - b.x0));
  }

  // Prepara la foto: la agranda si es chica, la endereza si está torcida
  // y borra las líneas de la cuadrícula (confunden al lector).
  async function prepareImage(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(3, Math.max(1, 2200 / Math.max(bmp.width, bmp.height)));
    let c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);

    let { gray, ink } = analyze(c);
    const angle = estimateSkew(ink, c.width, c.height);
    if (Math.abs(angle) >= 0.2) {
      const r = document.createElement('canvas');
      r.width = c.width; r.height = c.height;
      const rc = r.getContext('2d');
      rc.fillStyle = '#fff';
      rc.fillRect(0, 0, r.width, r.height);
      rc.translate(r.width / 2, r.height / 2);
      rc.rotate(-angle * Math.PI / 180);
      rc.drawImage(c, -c.width / 2, -c.height / 2);
      c = r;
      ({ gray, ink } = analyze(c));
    }
    const W = c.width, H = c.height;
    // Borra tramos largos horizontales y verticales (líneas de tabla).
    const minH = Math.round(W * 0.12), minV = Math.round(H * 0.12);
    const clear = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      let run = 0;
      for (let x = 0; x <= W; x++) {
        if (x < W && ink[y * W + x]) run++;
        else {
          if (run >= minH) for (let k = x - run; k < x; k++) for (let dy = -2; dy <= 2; dy++) { const yy = y + dy; if (yy >= 0 && yy < H) clear[yy * W + k] = 1; }
          run = 0;
        }
      }
    }
    for (let x = 0; x < W; x++) {
      let run = 0;
      for (let y = 0; y <= H; y++) {
        if (y < H && ink[y * W + x]) run++;
        else {
          if (run >= minV) for (let k = y - run; k < y; k++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx; if (xx >= 0 && xx < W) clear[k * W + xx] = 1; }
          run = 0;
        }
      }
    }
    // Gris con contraste estirado (mejor que blanco y negro puro para las letras).
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    let lo = 255, hi = 0;
    for (let p = 0; p < gray.length; p += 7) { if (gray[p] < lo) lo = gray[p]; if (gray[p] > hi) hi = gray[p]; }
    const k = 255 / Math.max(40, hi - lo);
    for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
      const v = clear[p] ? 255 : Math.max(0, Math.min(255, (gray[p] - lo) * k));
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // Escala de grises + tinta (umbral de Otsu).
  function analyze(c) {
    const W = c.width, H = c.height;
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const gray = new Uint8Array(W * H);
    const hist = new Array(256).fill(0);
    for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
      const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      gray[p] = g; hist[g]++;
    }
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = gray.length - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    const ink = new Uint8Array(W * H);
    for (let p = 0; p < ink.length; p++) ink[p] = gray[p] < thr ? 1 : 0;
    return { gray, ink };
  }

  // Busca el ángulo (−5° a 5°) en que las filas de texto quedan más "nítidas".
  function estimateSkew(ink, W, H) {
    const pts = [];
    for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) if (ink[y * W + x]) pts.push(x, y);
    if (pts.length < 200) return 0;
    let bestA = 0, bestS = -1;
    for (let a = -5; a <= 5.001; a += 0.25) {
      const t = Math.tan(a * Math.PI / 180);
      const hist = new Float64Array(H + W);
      for (let i = 0; i < pts.length; i += 2) {
        const yy = Math.round(pts[i + 1] - pts[i] * t + W * 0.1);
        if (yy >= 0 && yy < hist.length) hist[yy]++;
      }
      let s = 0; for (let k = 0; k < hist.length; k++) s += hist[k] * hist[k];
      if (s > bestS) { bestS = s; bestA = a; }
    }
    return bestA;
  }

  // Une palabras cercanas en celdas; un espacio grande separa columnas.
  function toCells(lines) {
    return lines.filter((ws) => ws.length).map((ws) => {
      const cells = [];
      let cell = null;
      for (const w of ws) {
        const gap = cell ? w.x0 - cell.x1 : Infinity;
        if (cell && gap < Math.max(6, (w.h || 10) * 0.9)) { cell.t += ' ' + w.t; cell.x1 = w.x1; }
        else { cell = { t: w.t, x0: w.x0, x1: w.x1 }; cells.push(cell); }
      }
      cells.forEach((c) => { c.t = c.t.replace(/\s+/g, ' ').trim(); });
      return cells;
    });
  }

  // Con la fila de encabezados, ubica cada celda en la columna más cercana (por posición).
  function alignToHeader(cellLines, isHeader) {
    const hIdx = cellLines.findIndex((cells) => isHeader(cells.map((c) => c.t)));
    if (hIdx < 0) return null;
    const head = cellLines[hIdx];
    const centers = head.map((c) => (c.x0 + c.x1) / 2);
    const rows = [head.map((c) => c.t)];
    for (const cells of cellLines.slice(hIdx + 1)) {
      const row = head.map(() => '');
      for (const c of cells) {
        // Columna cuyo rango se superpone más, o la de centro más cercano.
        let best = 0, bestScore = -Infinity;
        head.forEach((h, k) => {
          const overlap = Math.min(c.x1, h.x1) - Math.max(c.x0, h.x0);
          const score = overlap > 0 ? overlap : -Math.abs((c.x0 + c.x1) / 2 - centers[k]);
          if (score > bestScore) { bestScore = score; best = k; }
        });
        row[best] = row[best] ? row[best] + ' ' + c.t : c.t;
      }
      rows.push(row);
    }
    return rows;
  }

  // ---------- Líneas sueltas (sin tabla) ----------
  // Ej: "7790001000011 Paracetamol 500 mg x 20 comp L2405A 2,50 30 und"
  const RE_CODE = /^\d{8,14}$/;
  const RE_DATE = /^(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{2}\/\d{4})$/;
  const RE_NUM = /^\$?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?$|^\$?\d+(?:[.,]\d{1,2})?$/;
  const RE_LOTE = /^(?=.*[a-z])(?=.*\d)[a-z0-9\-\/]{4,}$/i;
  const RE_DOSE = /\d(mg|ml|g|gr|mcg|ui|%|cm|mm|kg|l)$/i;
  const RE_UNIT = /^(und|unds|unid|unidades|uds|u|cj|caja|cajas)\.?$/i;

  function looseItems(lines) {
    const items = [];
    for (const raw of lines) {
      const text = String(raw).replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length < 4) continue;
      let tokens = text.split(' ');
      let codigo = '', lote = '', venc = '';
      const nums = [];
      // Cola de la línea: números, lote, fecha y unidad.
      while (tokens.length > 1) {
        const t = tokens[tokens.length - 1];
        const prev = tokens[tokens.length - 2];
        if (RE_UNIT.test(t)) { tokens.pop(); continue; }
        if (RE_DATE.test(t) && !venc) { venc = t; tokens.pop(); continue; }
        if (RE_CODE.test(t) && !codigo) { codigo = t; tokens.pop(); continue; }
        if (RE_NUM.test(t)) { nums.unshift(t); tokens.pop(); continue; }
        if (/^(lote|lot|l)[:.]?$/i.test(prev) && !lote) { lote = t; tokens.splice(-2, 2); continue; }
        if (RE_LOTE.test(t) && !RE_DOSE.test(t) && !lote) { lote = t; tokens.pop(); continue; }
        break;
      }
      if (RE_CODE.test(tokens[0])) codigo = codigo || tokens.shift();
      const producto = tokens.join(' ').replace(/^[\-•*·\d.)\s]+(?=[a-z])/i, '').trim();
      if (!nums.length || producto.length < 3 || !/[a-z]{3}/i.test(producto)) continue;
      if (/^(producto|descrip|codigo|código|total|subtotal)/i.test(producto)) continue;
      // Cantidad = último entero; precio = número con decimales.
      let cantidad = 0, precio = 0;
      for (let k = nums.length - 1; k >= 0; k--) {
        if (!cantidad && /^\d+$/.test(nums[k])) { cantidad = +nums[k]; nums.splice(k, 1); }
      }
      const dec = nums.find((n) => /[.,]\d{1,2}$/.test(n));
      if (dec) precio = parseFloat(dec.replace('$', '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')) || 0;
      if (!cantidad) continue;
      items.push({ codigo, producto, lote, precio, cantidad, vencimiento: venc });
    }
    return items;
  }

  global.Importar = { fromWord, fromPdf, fromImage, alignToHeader, looseItems, loadScript, prepareImage };
})(window);

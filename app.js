/* Revisión de pedidos en sucursal
 * - La central carga el pedido (producto, código, lote, precio, cantidad).
 * - La sucursal cuenta a ciegas (sin ver la cantidad enviada), buscando o escaneando.
 * - Al terminar se muestran las diferencias: contado vs. lo que debería ser.
 * Todo se guarda en el navegador (localStorage); no hay servidor.
 */
(function () {
  'use strict';

  const STORE_KEY = 'revision-pedidos-v1';
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (n) => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const fmtMoney = (n) => (Number(n) || 0).toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (ts) => new Date(ts).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });

  // ---------- Normalización ----------
  const stripAccents = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const normText = (s) => stripAccents(s).toLowerCase().trim();
  // Códigos: sin espacios; si es numérico, sin ceros a la izquierda (GTIN-14 == EAN-13).
  function normCode(c) {
    const s = String(c ?? '').replace(/\s+/g, '').toUpperCase();
    return /^\d+$/.test(s) ? s.replace(/^0+/, '') : s;
  }
  const normLote = (l) => String(l ?? '').replace(/[\s\-_.]/g, '').toUpperCase();

  function parseNum(v) {
    if (typeof v === 'number') return v;
    let s = String(v ?? '').replace(/[^\d.,\-]/g, '');
    if (!s) return 0;
    const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
    if (lc > -1 && ld > -1) {
      s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (lc > -1) {
      s = s.replace(',', '.');
    }
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  // ---------- Almacenamiento ----------
  let db = load();
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY));
      if (d && Array.isArray(d.orders)) return d;
    } catch (e) { /* vacío */ }
    return { orders: [] };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
    catch (e) { alert('No se pudo guardar en este dispositivo: ' + e.message); }
  }
  const getOrder = (id) => db.orders.find((o) => o.id === id);

  // ---------- Navegación ----------
  let current = null; // pedido abierto
  const views = ['home', 'load', 'order', 'count', 'results'];
  function show(view, title) {
    views.forEach((v) => { $('#view-' + v).hidden = v !== view; });
    $('#title').textContent = title || '';
    if (view !== 'count') stopScanner();
    window.scrollTo(0, 0);
  }
  $('#btnHome').onclick = () => renderHome();

  // ---------- Diálogo ----------
  function ask({ title, html = '', buttons = [{ label: 'Aceptar', value: 'ok', cls: 'primary' }] }) {
    const dlg = $('#dlg');
    $('#dlgTitle').textContent = title;
    $('#dlgBody').innerHTML = html;
    $('#dlgActions').innerHTML = buttons.map((b) =>
      `<button class="btn ${b.cls || ''}" value="${esc(b.value)}">${esc(b.label)}</button>`).join('');
    return new Promise((resolve) => {
      dlg.onclose = () => {
        const fields = {};
        dlg.querySelectorAll('#dlgBody [name]').forEach((el) => { fields[el.name] = el.value; });
        resolve({ value: dlg.returnValue, fields });
      };
      // Enter en un campo = botón principal (no el primer botón del formulario).
      const main = buttons.find((b) => b.cls === 'primary') || buttons[buttons.length - 1];
      dlg.onkeydown = (e) => {
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); dlg.close(main.value); }
      };
      dlg.returnValue = '';
      dlg.showModal();
      const first = dlg.querySelector('#dlgBody input');
      if (first) setTimeout(() => first.focus(), 50);
    });
  }

  // =========================================================
  // INICIO
  // =========================================================
  function orderStatus(o) {
    const counted = o.items.filter((i) => (o.counts[i.id] || 0) > 0).length;
    if (o.finishedAt) {
      const d = computeResults(o).filter((r) => r.dif !== 0).length;
      return { counted, key: 'done', tag: d ? `<span class="pill bad">${d} ${d === 1 ? 'diferencia' : 'diferencias'}</span>` : '<span class="pill ok">Correcto</span>', diffs: d };
    }
    return { counted, key: counted ? 'counting' : 'new', tag: counted ? '<span class="pill warn">En conteo</span>' : '<span class="pill">Sin contar</span>', diffs: 0 };
  }

  function renderHome() {
    current = null;
    show('home');
    const st = db.orders.map(orderStatus);
    const open = st.filter((x) => x.key !== 'done').length;
    const done = st.filter((x) => x.key === 'done').length;
    const withDiffs = st.filter((x) => x.diffs > 0).length;
    $('#homeStats').innerHTML = `
      <div class="kpi"><div class="l">Pedidos</div><div class="v">${db.orders.length}</div><div class="s">en este equipo</div></div>
      <div class="kpi"><div class="l">En revisión</div><div class="v">${open}</div><div class="s">abiertos</div></div>
      <div class="kpi ok"><div class="l">Cerrados</div><div class="v">${done}</div><div class="s">conteos terminados</div></div>
      <div class="kpi ${withDiffs ? 'bad' : ''}"><div class="l">Con diferencias</div><div class="v">${withDiffs}</div><div class="s">de ${done} cerrados</div></div>`;

    const list = $('#orderList');
    if (!db.orders.length) {
      list.innerHTML = `<div class="empty">Todavía no hay pedidos. Usa <b>Nuevo pedido</b> para cargar uno o abre el enlace que te enviaron.</div>`;
      return;
    }
    list.innerHTML = `<div class="table-wrap"><table class="orders">
      <thead><tr><th>Pedido</th><th>Sucursal</th><th>Avance</th><th>Estado</th><th class="num">Fecha</th></tr></thead>
      <tbody>${db.orders.slice().sort((a, b) => b.creado - a.creado).map((o) => {
        const x = orderStatus(o);
        const pct = o.finishedAt ? 100 : (o.items.length ? Math.round((x.counted / o.items.length) * 100) : 0);
        return `<tr class="click" data-id="${o.id}">
          <td><b>${esc(o.nombre || 'Pedido')}</b><div class="sub">${o.items.length} productos${o.contadoPor ? ' · contó ' + esc(o.contadoPor) : ''}</div></td>
          <td class="c-branch">${esc(o.sucursal || '—')}</td>
          <td class="c-progress"><span class="sub">${o.finishedAt ? 'Cerrado' : `${x.counted} de ${o.items.length}`}</span><div class="mini-bar"><span style="width:${pct}%"></span></div></td>
          <td class="c-state">${x.tag}</td>
          <td class="num c-date sub">${fmtDate(o.finishedAt || o.creado)}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
    list.querySelectorAll('tr[data-id]').forEach((r) => { r.onclick = () => openOrder(r.dataset.id); });
  }

  // ---------- Modo claro / oscuro ----------
  function applyTheme(id) {
    document.documentElement.dataset.theme = id;
    document.querySelector('meta[name=theme-color]').content = id === 'nocturno' ? '#0b0f14' : '#13233a';
    $('#btnTheme').innerHTML = ic(id === 'nocturno' ? 'sun' : 'moon');
  }
  $('#btnTheme').onclick = () => {
    const next = document.documentElement.dataset.theme === 'nocturno' ? 'ejecutivo' : 'nocturno';
    applyTheme(next);
    try { localStorage.setItem('revision-tema', next); } catch (e) { /* sin almacenamiento */ }
  };
  applyTheme(document.documentElement.dataset.theme === 'nocturno' ? 'nocturno' : 'ejecutivo');

  $('#btnNewOrder').onclick = () => startLoad();
  $('#fileOpenOrder').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { importPayload(JSON.parse(await f.text()).pedido); }
    catch (err) { alert('El archivo no es un pedido válido.'); }
  };

  // =========================================================
  // CARGA (CENTRAL)
  // =========================================================
  let draft = [];
  function startLoad() {
    draft = [];
    $('#orderName').value = '';
    $('#orderBranch').value = '';
    setLoadStatus('');
    renderPreview();
    show('load', 'Cargar pedido');
  }

  const HEADER_RULES = [
    ['vencimiento', /venc|expir|caduc|^f\.?v/],
    ['lote', /lote|batch/],
    ['cantidad', /cant|unidades|^und|qty|^uds/],
    ['precio', /precio|p\.?\s?unit|valor|costo|importe/],
    ['codigo', /cod|barra|ean|gtin|upc|sku/],
    ['producto', /producto|descrip|nombre|articulo|item|detalle/],
  ];
  function mapHeaders(row) {
    const map = {};
    row.forEach((h, idx) => {
      const n = normText(h);
      if (!n) return;
      for (const [key, re] of HEADER_RULES) {
        if (map[key] === undefined && re.test(n)) { map[key] = idx; break; }
      }
    });
    return map;
  }

  function rowsToItems(rows) {
    let hIdx = -1, map = null;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const m = mapHeaders(rows[i]);
      if (m.producto !== undefined) { hIdx = i; map = m; break; }
    }
    if (!map) throw new Error('No encontré la columna "Producto". Revisa que la primera fila tenga los encabezados.');
    if (map.cantidad === undefined) throw new Error('No encontré la columna "Cantidad".');
    const items = [];
    for (const r of rows.slice(hIdx + 1)) {
      const producto = String(r[map.producto] ?? '').trim();
      if (!producto) continue;
      let venc = map.vencimiento !== undefined ? r[map.vencimiento] : '';
      if (venc instanceof Date) venc = venc.toISOString().slice(0, 10);
      items.push({
        codigo: map.codigo !== undefined ? String(r[map.codigo] ?? '').trim() : '',
        producto,
        lote: map.lote !== undefined ? String(r[map.lote] ?? '').trim() : '',
        precio: map.precio !== undefined ? parseNum(r[map.precio]) : 0,
        cantidad: parseNum(r[map.cantidad]),
        vencimiento: String(venc ?? '').trim(),
      });
    }
    return items;
  }

  // CSV / texto pegado (detecta ; , o tabulación)
  function parseDelimited(text) {
    const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
    const counts = { '\t': first.split('\t').length, ';': first.split(';').length, ',': first.split(',').length };
    const d = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === d) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function addToDraft(items) {
    // Une filas repetidas (mismo código + lote + producto) sumando cantidades.
    for (const it of items) {
      const key = normCode(it.codigo) + '|' + normLote(it.lote) + '|' + normText(it.producto);
      const ex = !it.revisar && draft.find((d) => !d.revisar && normCode(d.codigo) + '|' + normLote(d.lote) + '|' + normText(d.producto) === key);
      if (ex) ex.cantidad += it.cantidad;
      else draft.push({ id: uid(), ...it });
    }
    renderPreview();
  }

  const isHeaderRow = (texts) => { const m = mapHeaders(texts); return m.producto !== undefined && m.cantidad !== undefined; };
  function bestFromTables(tables) {
    let best = [];
    for (const t of tables) { try { const it = rowsToItems(t); if (it.length > best.length) best = it; } catch (e) { /* tabla sin encabezados */ } }
    return best;
  }
  // Filas con posición (PDF o foto): primero intenta por encabezados; si no, lee línea por línea.
  function fromCellLines(cellLines) {
    const rows = Importar.alignToHeader(cellLines, isHeaderRow);
    let items = [];
    if (rows) { try { items = rowsToItems(rows); } catch (e) { /* sigue con lectura libre */ } }
    if (items.length) return { items, exact: true };
    return { items: Importar.looseItems(cellLines.map((cs) => cs.map((c) => c.t).join(' '))), exact: false };
  }

  function setLoadStatus(msg, kind = 'info') {
    const el = $('#loadStatus');
    el.className = 'load-status ' + kind;
    el.innerHTML = msg ? (kind === 'busy' ? '<span class="spinner"></span>' : ic(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : kind === 'warn' ? 'alert' : 'file')) + `<span>${msg}</span>` : '';
    el.hidden = !msg;
  }

  async function importFile(f, isPhoto = false) {
    const name = f.name.toLowerCase();
    let items = [], exact = true;
    setLoadStatus(`Leyendo ${esc(f.name)}…`, 'busy');
    if (/\.(csv|txt)$/.test(name)) {
      items = rowsToItems(parseDelimited(await f.text()));
    } else if (/\.(xlsx|xls)$/.test(name)) {
      const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
      items = rowsToItems(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' }));
    } else if (/\.docx?$/.test(name)) {
      const w = await Importar.fromWord(f);
      items = bestFromTables(w.tables);
      if (!items.length) { items = Importar.looseItems(w.lines); exact = false; }
    } else if (/\.pdf$/.test(name)) {
      ({ items, exact } = fromCellLines(await Importar.fromPdf(f)));
    } else if (isPhoto || (f.type || '').startsWith('image/')) {
      setLoadStatus('Preparando el lector de fotos (la primera vez tarda un poco)…', 'busy');
      const lines = await Importar.fromImage(f, (p) => setLoadStatus(`Leyendo la foto… ${p}%`, 'busy'));
      ({ items } = fromCellLines(lines));
      exact = false;
    } else {
      throw new Error('Formato no reconocido. Usa Excel, CSV, Word (.docx), PDF o una foto.');
    }
    if (!items.length) throw new Error('No encontré productos. Revisa que el documento tenga una tabla con columnas Producto y Cantidad, o agrégalos a mano.');
    if (!exact) items.forEach((i) => {
      i.revisar = true;
      // Limpia lo típico de una lectura automática: códigos partidos o metidos en el nombre.
      if (/^[\d\s.,]{8,}$/.test(i.codigo)) i.codigo = i.codigo.replace(/\D/g, '');
      const m = !i.codigo && i.producto.match(/^\|?\s*(\d[\d\s]{7,17}\d)[\s,.;:|]+(.+)$/);
      if (m) { i.codigo = m[1].replace(/\s/g, ''); i.producto = m[2]; }
      i.producto = i.producto.replace(/^[\s|,.;:\-]+|[\s|,.;:\-]+$/g, '');
      i.lote = String(i.lote || '').replace(/[|,;]/g, '').trim();
    });
    addToDraft(items);
    if (!$('#orderName').value && !isPhoto) $('#orderName').value = f.name.replace(/\.[^.]+$/, '');
    setLoadStatus(exact ? `${items.length} productos cargados de ${esc(f.name)}.`
      : `${items.length} productos leídos de ${isPhoto ? 'la foto' : esc(f.name)}. Revisa las filas marcadas en amarillo y corrige lo que haga falta antes de guardar.`, exact ? 'ok' : 'warn');
  }

  $('#fileExcel').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { await importFile(f); } catch (err) { setLoadStatus(esc(err.message), 'err'); }
  };
  $('#fileFoto').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { await importFile(f, true); } catch (err) { setLoadStatus(esc(err.message), 'err'); }
  };

  $('#btnPaste').onclick = () => { $('#pasteBox').hidden = !$('#pasteBox').hidden; };
  $('#btnPasteApply').onclick = () => {
    try {
      const items = rowsToItems(parseDelimited($('#pasteArea').value));
      addToDraft(items);
      $('#pasteArea').value = '';
      $('#pasteBox').hidden = true;
      setLoadStatus(`${items.length} productos agregados.`, 'ok');
    } catch (err) { setLoadStatus(esc(err.message), 'err'); }
  };

  $('#manualForm').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    addToDraft([{
      codigo: f.get('codigo').trim(), producto: f.get('producto').trim(), lote: f.get('lote').trim(),
      precio: parseNum(f.get('precio')), cantidad: parseNum(f.get('cantidad')), vencimiento: f.get('vencimiento').trim(),
    }]);
    e.target.reset();
    e.target.querySelector('[name=codigo]').focus();
  };

  function renderPreview() {
    const el = $('#loadPreview');
    if (!draft.length) { el.innerHTML = '<p class="muted center">Aún no hay productos.</p>'; return; }
    const total = draft.reduce((s, i) => s + i.cantidad * i.precio, 0);
    const units = draft.reduce((s, i) => s + i.cantidad, 0);
    const toCheck = draft.filter((i) => i.revisar).length;
    const inp = (i, f, cls = '', mode = 'text') => `<input class="cell-in ${cls}" data-id="${i.id}" data-f="${f}" inputmode="${mode}" value="${esc(f === 'precio' ? (i.precio ? fmtMoney(i.precio) : '') : i[f])}" aria-label="${f}">`;
    el.innerHTML = `
      <div class="row-between"><p><b>${draft.length}</b> productos · <b>${units}</b> unidades · Total $ ${fmtMoney(total)}</p>
        ${toCheck ? `<span class="pill warn">${toCheck} por revisar</span>` : ''}</div>
      <p class="small muted">Puedes corregir cualquier dato tocándolo.</p>
      <div class="table-wrap"><table class="preview">
        <thead><tr><th>Código</th><th>Producto</th><th>Lote</th><th class="num">Precio</th><th class="num">Cant.</th><th></th></tr></thead>
        <tbody>${draft.map((i) => `<tr class="${i.revisar ? 'revisar' : ''}">
          <td>${inp(i, 'codigo', 'mono', 'numeric')}</td><td>${inp(i, 'producto', 'wide')}</td><td>${inp(i, 'lote', 'mono')}</td>
          <td>${inp(i, 'precio', 'num', 'decimal')}</td><td>${inp(i, 'cantidad', 'num', 'numeric')}</td>
          <td><button class="icon-btn row-del" data-del="${i.id}" title="Quitar" aria-label="Quitar">${ic('x')}</button></td></tr>`).join('')}
        </tbody></table></div>`;
    el.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = () => { draft = draft.filter((d) => d.id !== b.dataset.del); renderPreview(); };
    });
  }
  $('#loadPreview').addEventListener('change', (e) => {
    const t = e.target;
    if (!t.classList.contains('cell-in')) return;
    const it = draft.find((d) => d.id === t.dataset.id);
    if (!it) return;
    const f = t.dataset.f;
    it[f] = (f === 'precio' || f === 'cantidad') ? parseNum(t.value) : t.value.trim();
    delete it.revisar;
    renderPreview();
  });

  $('#btnSaveOrder').onclick = () => {
    if (!draft.length) return setLoadStatus('Agrega al menos un producto antes de guardar.', 'err');
    if (draft.some((i) => !i.producto || !(i.cantidad > 0))) return setLoadStatus('Hay productos sin nombre o sin cantidad. Corrígelos o quítalos antes de guardar.', 'err');
    const o = newOrder({
      nombre: $('#orderName').value.trim() || 'Pedido ' + new Date().toLocaleDateString('es'),
      sucursal: $('#orderBranch').value.trim(),
      items: draft.map(({ revisar, ...i }) => i),
    });
    db.orders.push(o);
    save();
    openOrder(o.id);
  };

  function newOrder({ id, nombre, sucursal, creado, items, origen = 'central' }) {
    return { id: id || uid(), nombre, sucursal, creado: creado || Date.now(), origen, items, counts: {}, extras: [], evid: {}, log: [], finishedAt: null, reopened: 0 };
  }

  // =========================================================
  // PEDIDO: ENVÍO / IMPORTACIÓN
  // =========================================================
  function openOrder(id) {
    current = getOrder(id);
    if (!current) return renderHome();
    show('order', current.nombre);
    $('#orderTitle').textContent = current.nombre;
    $('#orderMeta').textContent = `${current.sucursal ? current.sucursal + ' · ' : ''}${current.items.length} productos · creado ${fmtDate(current.creado)}`;
    const x = orderStatus(current);
    $('#orderProgress').textContent = current.finishedAt ? `Cerrado ${fmtDate(current.finishedAt)}${current.contadoPor ? ' · contó ' + current.contadoPor : ''}`
      : x.counted ? `${x.counted} de ${current.items.length} productos contados` : 'Aún sin contar';
    $('#orderBar').style.width = (current.finishedAt ? 100 : current.items.length ? (x.counted / current.items.length) * 100 : 0) + '%';
    $('#btnStartCount').innerHTML = ic('scan') + (current.finishedAt ? ' Revisar conteo' : x.counted ? ' Seguir contando' : ' Contar pedido');
    $('#shareInfo').textContent = '';
  }

  // El pedido viaja comprimido, así las cantidades no quedan a la vista.
  function exportPayload(o) {
    const data = { v: 1, id: o.id, n: o.nombre, s: o.sucursal, c: o.creado,
      i: o.items.map((i) => [i.codigo, i.producto, i.lote, i.precio, i.cantidad, i.vencimiento]) };
    return LZString.compressToEncodedURIComponent(JSON.stringify(data));
  }
  function importPayload(str) {
    const d = JSON.parse(LZString.decompressFromEncodedURIComponent(str));
    if (!d || d.v !== 1 || !Array.isArray(d.i)) throw new Error('inválido');
    const existing = getOrder(d.id);
    if (existing) { openOrder(existing.id); return; }
    const o = newOrder({ id: d.id, nombre: d.n, sucursal: d.s, creado: d.c, origen: 'recibido',
      items: d.i.map(([codigo, producto, lote, precio, cantidad, vencimiento]) =>
        ({ id: uid(), codigo, producto, lote, precio, cantidad, vencimiento })) });
    db.orders.push(o);
    save();
    openOrder(o.id);
  }

  $('#btnShareLink').onclick = async () => {
    const url = location.origin + location.pathname + '#p=' + exportPayload(current);
    const text = `Pedido "${current.nombre}" para revisar:`;
    if (navigator.share) {
      try { await navigator.share({ title: current.nombre, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); $('#shareInfo').textContent = 'Enlace copiado. Pégalo en WhatsApp o correo.'; }
    catch (e) { prompt('Copia este enlace:', url); }
    if (url.length > 60000) $('#shareInfo').textContent += ' (El pedido es grande; si el enlace no abre, usa “Descargar archivo”.)';
  };
  $('#btnDownloadOrder').onclick = () => {
    const blob = new Blob([JSON.stringify({ pedido: exportPayload(current) })], { type: 'application/json' });
    download(blob, safeName(current.nombre) + '.pedido');
  };
  $('#btnDeleteOrder').onclick = async () => {
    const r = await ask({ title: '¿Eliminar este pedido?', html: '<p>Se borrará también el conteo.</p>',
      buttons: [{ label: 'Cancelar', value: '' }, { label: 'Eliminar', value: 'del', cls: 'danger' }] });
    if (r.value !== 'del') return;
    Object.values(current.evid || {}).forEach((ev) => ev.fotos.forEach((fid) => Fotos.del(fid)));
    db.orders = db.orders.filter((o) => o.id !== current.id);
    save();
    renderHome();
  };
  $('#btnStartCount').onclick = () => startCount();
  $('#btnShowResults').onclick = () => finishCount();

  function checkHash() {
    const m = location.hash.match(/^#p=(.+)$/);
    if (!m) return false;
    history.replaceState(null, '', location.pathname + location.search);
    try { importPayload(m[1]); return true; }
    catch (e) { alert('El enlace del pedido está incompleto o dañado.'); return false; }
  }

  // =========================================================
  // EVIDENCIA: motivo, nota y fotos por producto
  // Las fotos se guardan en IndexedDB (más espacio que localStorage).
  // =========================================================
  const Fotos = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('revision-fotos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('fotos');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const run = async (mode, fn) => {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction('fotos', mode);
        const req = fn(t.objectStore('fotos'));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      put: (id, blob) => run('readwrite', (st) => st.put(blob, id)),
      get: (id) => run('readonly', (st) => st.get(id)),
      del: (id) => run('readwrite', (st) => st.delete(id)).catch(() => {}),
    };
  })();
  const photoUrls = new Map();
  async function photoUrl(id) {
    if (!photoUrls.has(id)) {
      const blob = await Fotos.get(id);
      photoUrls.set(id, blob ? URL.createObjectURL(blob) : '');
    }
    return photoUrls.get(id);
  }
  function fillPhotos(root) {
    root.querySelectorAll('img[data-photo]:not([src])').forEach(async (img) => {
      const u = await photoUrl(img.dataset.photo);
      if (u) img.src = u; else img.closest('.thumb')?.remove();
    });
  }
  // Achica la foto (máx. 1280 px, JPEG) para que no ocupe tanto.
  async function compressImage(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.72));
  }
  const evOf = (o, id) => (o.evid || {})[id];
  const MOTIVOS = ['Dañado', 'Vencido o por vencer', 'Lote distinto', 'No llegó', 'Llegó de más', 'Mal etiquetado', 'Otro'];

  async function openEvidence(id, titulo, onDone) {
    current.evid = current.evid || {};
    const ev = current.evid[id] || { motivo: '', nota: '', fotos: [] };
    let fotos = [...ev.fotos];
    const nuevas = [];
    const p = ask({ title: titulo,
      html: `<p class="small muted">Deja registro de lo que viste: motivo, una nota y fotos.</p>
        <label>Motivo<select name="motivo"><option value="">Sin motivo</option>${MOTIVOS.map((m) => `<option ${m === ev.motivo ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label>Nota<textarea name="nota" rows="2" placeholder="Ej: caja aplastada, 3 unidades rotas">${esc(ev.nota)}</textarea></label>
        <div class="thumbs edit" id="evPhotos"></div>
        <div class="actions">
          <label class="btn sm">${ic('camera')} Tomar foto<input type="file" accept="image/*" capture="environment" hidden id="evCam"></label>
          <label class="btn sm">${ic('upload')} Subir de la galería<input type="file" accept="image/*" multiple hidden id="evGal"></label>
        </div>`,
      buttons: [{ label: 'Cancelar', value: '' }, { label: 'Guardar', value: 'ok', cls: 'primary' }] });
    const box = $('#evPhotos');
    const draw = () => {
      box.innerHTML = fotos.length ? fotos.map((fid) => `<span class="thumb"><img data-photo="${fid}" alt="Foto de evidencia">
        <button type="button" class="thumb-del" data-fdel="${fid}" aria-label="Quitar foto">${ic('x')}</button></span>`).join('')
        : '<span class="muted small">Sin fotos todavía.</span>';
      fillPhotos(box);
    };
    box.onclick = (e) => {
      const b = e.target.closest('[data-fdel]');
      if (b) { fotos = fotos.filter((x) => x !== b.dataset.fdel); draw(); }
    };
    const add = async (e) => {
      for (const f of e.target.files) {
        try {
          const fid = uid();
          await Fotos.put(fid, await compressImage(f));
          nuevas.push(fid);
          fotos.push(fid);
        } catch (err) { flash(`${ic('alert')}<span>No se pudo guardar la foto.</span>`, 'err'); }
      }
      e.target.value = '';
      draw();
    };
    $('#evCam').onchange = add;
    $('#evGal').onchange = add;
    draw();
    const r = await p;
    if (r.value !== 'ok') { nuevas.forEach((fid) => Fotos.del(fid)); return; }
    ev.fotos.filter((fid) => !fotos.includes(fid)).forEach((fid) => Fotos.del(fid));
    const next = { motivo: r.fields.motivo || '', nota: (r.fields.nota || '').trim(), fotos };
    if (!next.motivo && !next.nota && !fotos.length) delete current.evid[id];
    else current.evid[id] = next;
    save();
    if (onDone) onDone();
  }

  function evButton(o, id, act) {
    const ev = evOf(o, id);
    const n = ev ? ev.fotos.length : 0;
    return `<button class="ev-btn ${ev ? 'on' : ''}" ${act}="evid" title="Foto o nota" aria-label="Agregar foto o nota">${ic('camera')}${n ? `<span>${n}</span>` : ''}</button>`;
  }

  async function viewPhoto(id) {
    const u = await photoUrl(id);
    if (u) ask({ title: 'Foto de evidencia', html: `<img class="ev-big" src="${u}" alt="Foto de evidencia">`, buttons: [{ label: 'Cerrar', value: '' }] });
  }

  // =========================================================
  // CONTEO (SUCURSAL)
  // =========================================================
  function startCount() {
    if (current.finishedAt) {
      ask({ title: 'Este conteo ya fue terminado', html: '<p>¿Quieres reabrirlo para corregir? Quedará registrado que se reabrió.</p>',
        buttons: [{ label: 'Ver diferencias', value: 'res' }, { label: 'Reabrir conteo', value: 'open', cls: 'primary' }] })
        .then((r) => {
          if (r.value === 'open') { current.finishedAt = null; current.reopened = (current.reopened || 0) + 1; save(); startCount(); }
          else if (r.value === 'res') renderResults();
        });
      return;
    }
    show('count', current.nombre);
    $('#countKicker').textContent = [current.sucursal, current.nombre].filter(Boolean).join(' · ');
    $('#search').value = '';
    renderCount();
  }

  const qty = (item) => current.counts[item.id] || 0;

  function itemMatches(i, q) {
    if (!q) return true;
    const hay = normText(`${i.producto} ${i.codigo} ${i.lote}`);
    return q.split(/\s+/).every((t) => hay.includes(t));
  }

  function renderCount() {
    const q = normText($('#search').value);
    const onlyPending = $('#onlyPending').checked;
    let items = current.items.filter((i) => itemMatches(i, q) && (!onlyPending || !qty(i)));
    items.sort((a, b) => a.producto.localeCompare(b.producto, 'es'));
    const list = $('#countList');
    list.innerHTML = items.length ? items.map(itemHtml).join('')
      : '<li class="muted center">No hay productos que coincidan.</li>';
    renderExtras();
    renderProgress();
  }

  function itemHtml(i) {
    const n = qty(i);
    const meta = [
      i.codigo && `<span class="mono">${esc(i.codigo)}</span>`,
      i.lote && `Lote <b class="mono">${esc(i.lote)}</b>`,
      i.vencimiento && `<span class="opt">Vence ${esc(i.vencimiento)}</span>`,
      i.precio ? `<span class="opt">$ ${fmtMoney(i.precio)}</span>` : '',
    ].filter(Boolean).join('<span class="dot"> · </span>');
    return `<li class="item ${n ? 'done' : ''}" data-id="${i.id}">
      <span class="st">${ic('check')}</span>
      <div class="info"><div class="name">${esc(i.producto)}</div><div class="meta">${meta}</div></div>
      ${evButton(current, i.id, 'data-act')}
      <div class="stepper">
        <button class="step" data-act="dec" aria-label="Restar">${ic('minus')}</button>
        <input class="qty" type="number" inputmode="numeric" min="0" value="${n || ''}" placeholder="0" data-act="set" aria-label="Cantidad contada">
        <button class="step" data-act="inc" aria-label="Sumar">${ic('plus')}</button>
      </div>
    </li>`;
  }

  function renderProgress() {
    const total = current.items.length;
    const done = current.items.filter((i) => qty(i) > 0).length;
    const units = Object.values(current.counts).reduce((s, n) => s + n, 0) + current.extras.reduce((s, e) => s + e.cantidad, 0);
    $('#progressBar').style.width = (total ? (done / total) * 100 : 0) + '%';
    $('#progressText').textContent = `${done} de ${total} productos · ${units} unid.`;
  }

  function updateItemRow(item) {
    const li = $(`#countList li[data-id="${item.id}"]`);
    if (!li) return;
    const n = qty(item);
    li.classList.toggle('done', n > 0);
    const input = li.querySelector('.qty');
    if (document.activeElement !== input) input.value = n || '';
  }

  function setCount(item, n, { log = true } = {}) {
    n = Math.max(0, Math.round(n));
    const prev = qty(item);
    if (n === prev) return;
    if (n) current.counts[item.id] = n; else delete current.counts[item.id];
    if (log) current.log.push({ t: 'i', id: item.id, prev });
    current.startedAt = current.startedAt || Date.now();
    if (current.log.length > 300) current.log.shift();
    save();
    updateItemRow(item);
    renderProgress();
  }

  $('#search').oninput = () => renderCount();
  $('#onlyPending').onchange = () => renderCount();

  $('#countList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.tagName === 'INPUT') return;
    const item = current.items.find((i) => i.id === btn.closest('li').dataset.id);
    if (!item) return;
    if (btn.dataset.act === 'evid') return openEvidence(item.id, item.producto + (item.lote ? ' · ' + item.lote : ''), renderCount);
    setCount(item, qty(item) + (btn.dataset.act === 'inc' ? 1 : -1));
  });
  $('#countList').addEventListener('change', (e) => {
    if (!e.target.classList.contains('qty')) return;
    const item = current.items.find((i) => i.id === e.target.closest('li').dataset.id);
    if (item) setCount(item, parseNum(e.target.value));
  });
  $('#countList').addEventListener('focusin', (e) => { if (e.target.classList.contains('qty')) e.target.select(); });

  $('#btnUndo').onclick = () => {
    const last = current.log.pop();
    if (!last) return flash('Nada para deshacer', 'info');
    if (last.t === 'i') {
      const item = current.items.find((i) => i.id === last.id);
      if (item) { setCount(item, last.prev, { log: false }); flash(`Deshecho: ${item.producto}`, 'info'); }
    } else if (last.t === 'e') {
      const ex = current.extras.find((x) => x.id === last.id);
      if (ex) {
        ex.cantidad = last.prev;
        if (!ex.cantidad) current.extras = current.extras.filter((x) => x !== ex);
        save(); renderExtras(); renderProgress();
        flash('Deshecho: ' + ex.producto, 'info');
      }
    }
    save();
  };

  // ---------- Productos que no están en el pedido / lote distinto ----------
  function addExtra({ codigo = '', producto, lote = '', motivo }, amount) {
    const key = normCode(codigo) + '|' + normLote(lote) + '|' + normText(producto);
    let ex = current.extras.find((x) => normCode(x.codigo) + '|' + normLote(x.lote) + '|' + normText(x.producto) === key);
    if (!ex) { ex = { id: uid(), codigo, producto, lote, motivo, cantidad: 0 }; current.extras.push(ex); }
    current.log.push({ t: 'e', id: ex.id, prev: ex.cantidad });
    current.startedAt = current.startedAt || Date.now();
    ex.cantidad += amount;
    save();
    renderExtras();
    renderProgress();
    return ex;
  }

  function renderExtras() {
    const box = $('#extrasBox');
    if (!current.extras.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<h3 class="section-title">${ic('alert')} Recibidos que no estaban en el pedido</h3>
      <div class="card"><ul class="items">${current.extras.map((x) => `<li class="item extra" data-xid="${x.id}">
        <span class="st">${ic('alert')}</span>
        <div class="info"><div class="name">${esc(x.producto)}</div>
          <div class="meta">${[x.codigo && `<span class="mono">${esc(x.codigo)}</span>`, x.lote && `Lote <b class="mono">${esc(x.lote)}</b>`, esc(x.motivo)].filter(Boolean).join(' · ')}</div></div>
        ${evButton(current, x.id, 'data-xact')}
        <div class="stepper">
          <button class="step" data-xact="dec" aria-label="Restar">${ic('minus')}</button>
          <input class="qty" type="number" min="0" value="${x.cantidad}" data-xact="set" aria-label="Cantidad">
          <button class="step" data-xact="inc" aria-label="Sumar">${ic('plus')}</button>
        </div></li>`).join('')}</ul></div>`;
  }
  function changeExtra(xid, fn) {
    const ex = current.extras.find((x) => x.id === xid);
    if (!ex) return;
    current.log.push({ t: 'e', id: ex.id, prev: ex.cantidad });
    ex.cantidad = Math.max(0, Math.round(fn(ex.cantidad)));
    if (!ex.cantidad) current.extras = current.extras.filter((x) => x !== ex);
    save(); renderExtras(); renderProgress();
  }
  $('#extrasBox').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-xact]');
    if (!b) return;
    if (b.dataset.xact === 'evid') {
      const x = current.extras.find((y) => y.id === b.closest('li').dataset.xid);
      return x && openEvidence(x.id, x.producto + (x.lote ? ' · ' + x.lote : ''), renderExtras);
    }
    changeExtra(b.closest('li').dataset.xid, (n) => n + (b.dataset.xact === 'inc' ? 1 : -1));
  });
  $('#extrasBox').addEventListener('change', (e) => {
    if (e.target.dataset.xact === 'set') changeExtra(e.target.closest('li').dataset.xid, () => parseNum(e.target.value));
  });

  $('#btnAddExtra').onclick = async () => {
    const r = await ask({ title: 'Producto que no está en la lista',
      html: `<label>Producto<input name="producto"></label>
        <label>Código de barras<input name="codigo" inputmode="numeric"></label>
        <label>Lote<input name="lote"></label>
        <label>Cantidad<input name="cantidad" type="number" min="1" value="1"></label>`,
      buttons: [{ label: 'Cancelar', value: '' }, { label: 'Agregar', value: 'ok', cls: 'primary' }] });
    if (r.value !== 'ok' || !r.fields.producto.trim()) return;
    addExtra({ codigo: r.fields.codigo.trim(), producto: r.fields.producto.trim(), lote: r.fields.lote.trim(), motivo: 'No estaba en el pedido' },
      Math.max(1, parseNum(r.fields.cantidad)));
  };

  // ---------- Avisos ----------
  let toastTimer;
  function flash(msg, kind = 'ok') {
    const t = $('#toast');
    t.className = 'toast ' + kind;
    t.innerHTML = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 4500 : 2500);
  }
  let audioCtx;
  function beep(ok = true) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = ok ? 1200 : 300;
      g.gain.value = 0.15;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + (ok ? 0.08 : 0.35));
    } catch (e) { /* sin audio */ }
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [120, 80, 120]);
  }

  // ---------- Procesar un código escaneado o tipeado ----------
  let busy = false;
  async function handleCode(raw) {
    if (busy) return;
    busy = true;
    pauseScanner(true);
    try { await processCode(raw); }
    finally { busy = false; pauseScanner(false); }
  }

  async function processCode(raw) {
    const amount = Math.max(1, parseNum($('#scanQty').value) || 1);
    const gs1 = GS1.parse(raw);
    const code = normCode(gs1 ? gs1.gtin : raw);
    const scannedLote = gs1 ? gs1.lote : '';
    const matches = current.items.filter((i) => i.codigo && normCode(i.codigo) === code);

    if (!matches.length) {
      beep(false);
      const r = await ask({ title: 'Código no está en el pedido',
        html: `<p class="mono">${esc(raw)}</p>${scannedLote ? `<p>Lote leído: <b class="mono">${esc(scannedLote)}</b></p>` : ''}
          <p>Si llegó en la cubeta, regístralo como sobrante.</p>
          <label>Nombre del producto<input name="producto" placeholder="Ej: Ibuprofeno 400mg"></label>`,
        buttons: [{ label: 'Ignorar', value: '' }, { label: 'Registrar sobrante', value: 'ok', cls: 'primary' }] });
      if (r.value === 'ok') {
        addExtra({ codigo: gs1 ? gs1.gtin : raw, producto: r.fields.producto.trim() || 'Producto sin nombre (' + raw + ')',
          lote: scannedLote, motivo: 'No estaba en el pedido' }, amount);
        flash(`${ic('alert')}<span>Registrado como sobrante</span>`, 'warn');
      }
      return;
    }

    let target = null;
    if (scannedLote) {
      // El código trae lote (DataMatrix GS1): verificamos contra el pedido.
      target = matches.find((i) => normLote(i.lote) === normLote(scannedLote));
      if (!target) {
        beep(false);
        const expected = matches.map((i) => i.lote || 'sin lote').join(', ');
        addExtra({ codigo: matches[0].codigo, producto: matches[0].producto, lote: scannedLote, motivo: 'Lote distinto al enviado' }, amount);
        flash(`${ic('alert')}<span><b>Lote incorrecto</b> · ${esc(matches[0].producto)}<br>Leído: <b class="mono">${esc(scannedLote)}</b> · En el pedido: <b class="mono">${esc(expected)}</b></span>`, 'err');
        return;
      }
    } else if (matches.length === 1) {
      target = matches[0];
    } else {
      // Mismo producto con varios lotes: preguntamos cuál es.
      const r = await ask({ title: matches[0].producto,
        html: '<p>Este producto viene en varios lotes. ¿Cuál tienes en la mano?</p>' +
          matches.map((i) => `<button class="btn block" value="${i.id}">Lote <b class="mono">${esc(i.lote || 'sin lote')}</b>${i.vencimiento ? ' · vence ' + esc(i.vencimiento) : ''}</button>`).join('') +
          '<label>¿Otro lote? Escríbelo:<input name="otro"></label>',
        buttons: [{ label: 'Cancelar', value: '' }, { label: 'Usar lote escrito', value: 'otro' }] });
      if (r.value === 'otro' && r.fields.otro.trim()) {
        const t = matches.find((i) => normLote(i.lote) === normLote(r.fields.otro));
        if (t) target = t;
        else {
          addExtra({ codigo: matches[0].codigo, producto: matches[0].producto, lote: r.fields.otro.trim(), motivo: 'Lote distinto al enviado' }, amount);
          beep(false);
          flash(`${ic('alert')}<span>El lote no corresponde al pedido. Quedó registrado como diferencia.</span>`, 'err');
          return;
        }
      } else target = matches.find((i) => i.id === r.value);
      if (!target) return;
    }

    setCount(target, qty(target) + amount);
    beep(true);
    const loteOk = scannedLote ? ' · lote verificado' : '';
    flash(`${ic('check')}<span>${esc(target.producto)}${target.lote ? ' · ' + esc(target.lote) : ''}${loteOk} — contados <b>${qty(target)}</b></span>`, 'ok');
    // Lleva el producto a la vista
    const li = $(`#countList li[data-id="${target.id}"]`);
    if (li) { li.classList.add('flash'); li.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => li.classList.remove('flash'), 1200); }
  }

  // Lector de código de barras USB/Bluetooth (o tipear código + Enter) en el buscador.
  $('#search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = $('#search').value.trim();
    if (!v) return;
    const isCode = /^[\]\(]?[\w\u001d()\]]{6,}$/.test(v) && /\d{6,}/.test(v);
    const exact = current.items.some((i) => i.codigo && normCode(i.codigo) === normCode(GS1.parse(v)?.gtin || v));
    if (isCode || exact) {
      e.preventDefault();
      $('#search').value = '';
      renderCount();
      handleCode(v);
    }
  });

  // ---------- Cámara ----------
  let scanner = null, lastCode = '', lastTime = 0;
  $('#btnScan').onclick = () => (scanner ? stopScanner() : startScanner());
  $('#btnStopScan').onclick = () => stopScanner();

  async function startScanner() {
    if (!window.Html5Qrcode) return alert('No se pudo cargar el lector. Revisa tu conexión a internet.');
    $('#scanner').hidden = false;
    $('#btnScan').innerHTML = ic('x') + ' Cerrar';
    const F = Html5QrcodeSupportedFormats;
    scanner = new Html5Qrcode('reader', {
      verbose: false,
      useBarCodeDetectorIfSupported: true,
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.CODE_93, F.ITF, F.CODABAR, F.DATA_MATRIX, F.QR_CODE],
    });
    try {
      await scanner.start({ facingMode: 'environment' },
        { fps: 12, qrbox: (w, h) => ({ width: Math.min(w * 0.85, 360), height: Math.min(h * 0.55, 220) }), aspectRatio: 1.333 },
        (text) => {
          const now = Date.now();
          if (text === lastCode && now - lastTime < 1500) return; // evita contar dos veces el mismo
          lastCode = text; lastTime = now;
          handleCode(text);
        }, () => {});
      try {
        const caps = scanner.getRunningTrackCapabilities();
        $('#btnTorch').hidden = !caps.torch;
      } catch (e) { /* sin linterna */ }
      $('#scanStatus').textContent = 'Apunta al código de barras o DataMatrix…';
    } catch (err) {
      stopScanner();
      alert('No se pudo abrir la cámara. Da permiso de cámara al navegador (la página debe abrirse con https).\n\n' + err);
    }
  }
  let torchOn = false;
  $('#btnTorch').onclick = async () => {
    try { torchOn = !torchOn; await scanner.applyVideoConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { /* no soportado */ }
  };
  function pauseScanner(p) {
    if (!scanner) return;
    try { p ? scanner.pause(true) : scanner.resume(); } catch (e) { /* estado no válido */ }
  }
  async function stopScanner() {
    if (!scanner) return;
    const s = scanner;
    scanner = null;
    try { await s.stop(); s.clear(); } catch (e) { /* ya detenido */ }
    $('#scanner').hidden = true;
    $('#btnScan').innerHTML = ic('scan') + ' Escanear';
    torchOn = false;
  }

  // =========================================================
  // RESULTADOS
  // =========================================================
  $('#btnFinish').onclick = () => finishCount();

  async function finishCount() {
    if (!current.finishedAt) {
      const pending = current.items.filter((i) => !qty(i)).length;
      const r = await ask({ title: '¿Terminaste de contar?',
        html: `<p>${pending ? `Hay <b>${pending}</b> productos sin contar; se tomarán como <b>no recibidos (0)</b>.` : 'Todos los productos tienen conteo.'}</p>
          <label>Contado por<input name="por" placeholder="Nombre de quien contó" value="${esc(lastPerson())}"></label>
          <p class="small muted">Al ver las diferencias el conteo queda cerrado.</p>`,
        buttons: [{ label: 'Seguir contando', value: '' }, { label: 'Sí, ver diferencias', value: 'ok', cls: 'primary' }] });
      if (r.value !== 'ok') return;
      current.finishedAt = Date.now();
      current.contadoPor = (r.fields.por || '').trim();
      try { localStorage.setItem('revision-responsable', current.contadoPor); } catch (e) { /* sin almacenamiento */ }
      save();
    }
    renderResults();
  }

  function lastPerson() {
    try { return localStorage.getItem('revision-responsable') || ''; } catch (e) { return ''; }
  }
  const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'menos de 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

  function computeResults(o) {
    const rows = o.items.map((i) => {
      const contado = o.counts[i.id] || 0;
      const dif = contado - i.cantidad;
      let estado = 'OK';
      if (dif < 0) estado = contado === 0 ? 'No llegó' : 'Faltante';
      else if (dif > 0) estado = 'Sobrante';
      return { id: i.id, codigo: i.codigo, producto: i.producto, lote: i.lote, precio: i.precio, contado, esperado: i.cantidad, dif, estado };
    });
    for (const x of o.extras) {
      rows.push({ id: x.id, codigo: x.codigo, producto: x.producto, lote: x.lote, precio: 0, contado: x.cantidad, esperado: 0, dif: x.cantidad,
        estado: x.motivo === 'Lote distinto al enviado' ? 'Lote distinto' : 'No estaba en pedido' });
    }
    return rows;
  }

  function renderResults() {
    show('results', current.nombre);
    const rows = computeResults(current);
    const diffs = rows.filter((r) => r.dif !== 0);
    const falt = rows.filter((r) => r.dif < 0), sobr = rows.filter((r) => r.dif > 0);
    const uFalt = -falt.reduce((s, r) => s + r.dif, 0), uSobr = sobr.reduce((s, r) => s + r.dif, 0);
    const vFalt = -falt.reduce((s, r) => s + r.dif * r.precio, 0);
    const ok = rows.length - diffs.length;

    const pct = rows.length ? Math.round((ok / rows.length) * 100) : 0;
    const dur = current.startedAt && current.finishedAt ? fmtDur(current.finishedAt - current.startedAt) : '—';
    $('#summary').innerHTML = `
      <div class="page-head">
        <div>
          <span class="kicker">${esc(current.sucursal || 'Sucursal')} · Cerrado ${current.finishedAt ? fmtDate(current.finishedAt) : ''}${current.contadoPor ? ' · contó ' + esc(current.contadoPor) : ''}${current.reopened ? ` · reabierto ${current.reopened}×` : ''}</span>
          <h2 class="page-title">Diferencias · ${esc(current.nombre)}</h2>
        </div>
      </div>
      <div class="kpis five">
        <div class="kpi ${diffs.length ? '' : 'ok'}"><div class="l">Exactitud</div><div class="v">${pct}%</div><div class="s">${ok} de ${rows.length} líneas correctas</div><div class="meter"><span style="width:${pct}%"></span></div></div>
        <div class="kpi ${uFalt ? 'bad' : ''}"><div class="l">Faltan</div><div class="v">${uFalt}</div><div class="s">unid. · ${falt.length} ${falt.length === 1 ? 'producto' : 'productos'}</div></div>
        <div class="kpi ${uSobr ? 'warn' : ''}"><div class="l">Sobran</div><div class="v">${uSobr}</div><div class="s">unid. · ${sobr.length} ${sobr.length === 1 ? 'producto' : 'productos'}</div></div>
        <div class="kpi"><div class="l">Valor faltante</div><div class="v">$ ${fmtMoney(vFalt)}</div><div class="s">a precio del pedido</div></div>
        <div class="kpi"><div class="l">Tiempo de conteo</div><div class="v">${dur}</div><div class="s">primer registro → cierre</div></div>
      </div>`;
    renderResultsTable(rows);
  }

  function renderResultsTable(rows) {
    const only = $('#onlyDiffs').checked;
    const list = (only ? rows.filter((r) => r.dif !== 0 || evOf(current, r.id)) : rows)
      .sort((a, b) => (a.dif === 0) - (b.dif === 0) || a.producto.localeCompare(b.producto, 'es'));
    if (!list.length) {
      $('#resultsTable').innerHTML = `<div class="card good-msg">${ic('check')} Todo correcto: el pedido llegó completo.</div>`;
      return;
    }
    $('#resultsTable').innerHTML = `<div class="card"><div class="table-wrap"><table class="results">
      <thead><tr><th>Producto</th><th class="num">Llegó</th><th class="num">Debería ser</th><th class="num">Dif.</th><th>Estado</th></tr></thead>
      <tbody>${list.map((r) => `<tr data-rid="${r.id}">
        <td><b>${esc(r.producto)}</b><div class="sub"><span class="mono">${esc(r.codigo)}</span>${r.lote ? ` · Lote <span class="mono">${esc(r.lote)}</span>` : ''}</div>${evHtml(r.id)}</td>
        <td class="num">${r.contado} und</td>
        <td class="num">${r.esperado} und</td>
        <td class="num ${r.dif < 0 ? 'd-neg' : r.dif > 0 ? 'd-pos' : ''}">${r.dif > 0 ? '+' : ''}${r.dif}</td>
        <td><div class="state-cell"><span class="pill ${r.dif === 0 ? 'ok' : r.dif < 0 ? 'bad' : 'warn'}">${esc(r.estado)}</span>${evButton(current, r.id, 'data-rev')}</div></td>
      </tr>`).join('')}</tbody></table></div></div>`;
    fillPhotos($('#resultsTable'));
  }

  function evHtml(id) {
    const ev = evOf(current, id);
    if (!ev) return '';
    return `<div class="ev-line">${ev.motivo ? `<b>${esc(ev.motivo)}</b>` : ''}${ev.motivo && ev.nota ? ' · ' : ''}${esc(ev.nota)}</div>
      ${ev.fotos.length ? `<div class="thumbs">${ev.fotos.map((fid) => `<span class="thumb"><img data-photo="${fid}" data-view="${fid}" alt="Foto de evidencia"></span>`).join('')}</div>` : ''}`;
  }
  $('#resultsTable').addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) return viewPhoto(v.dataset.view);
    const b = e.target.closest('[data-rev]');
    if (!b) return;
    const r = computeResults(current).find((x) => x.id === b.closest('tr').dataset.rid);
    if (r) openEvidence(r.id, r.producto + (r.lote ? ' · ' + r.lote : ''), () => renderResultsTable(computeResults(current)));
  });

  $('#onlyDiffs').onchange = () => renderResultsTable(computeResults(current));
  $('#btnBackToCount').onclick = () => startCount();
  $('#btnPrint').onclick = () => window.print();

  function exportRows() {
    return computeResults(current).map((r) => ({
      'Código': r.codigo, 'Producto': r.producto, 'Lote': r.lote, 'Precio': r.precio,
      'Llegó': r.contado, 'Debería ser': r.esperado, 'Diferencia': r.dif, 'Valor diferencia': +(r.dif * r.precio).toFixed(2), 'Estado': r.estado,
      'Motivo': evOf(current, r.id)?.motivo || '', 'Nota': evOf(current, r.id)?.nota || '', 'Fotos': evOf(current, r.id)?.fotos.length || 0,
    }));
  }
  $('#btnExportXlsx').onclick = () => {
    const ws = XLSX.utils.json_to_sheet(exportRows());
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Diferencias');
    const info = [['Pedido', current.nombre], ['Sucursal', current.sucursal || ''], ['Contado por', current.contadoPor || ''],
      ['Inicio conteo', current.startedAt ? fmtDate(current.startedAt) : ''], ['Cierre', current.finishedAt ? fmtDate(current.finishedAt) : ''],
      ['Veces reabierto', current.reopened || 0]];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(info), 'Resumen');
    XLSX.writeFile(wb, safeName(current.nombre) + '-diferencias.xlsx');
  };
  $('#btnExportCsv').onclick = () => {
    const rows = exportRows();
    const head = Object.keys(rows[0] || {});
    const cell = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = '﻿' + [head.join(';'), ...rows.map((r) => head.map((h) => cell(r[h])).join(';'))].join('\r\n');
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), safeName(current.nombre) + '-diferencias.csv');
  };
  $('#btnShareResults').onclick = async () => {
    const rows = computeResults(current).filter((r) => r.dif !== 0 || evOf(current, r.id));
    const lines = rows.map((r) => {
      const ev = evOf(current, r.id);
      const dif = r.dif === 0 ? 'correcto' : r.dif > 0 ? 'sobran ' + r.dif : 'faltan ' + -r.dif;
      return `• ${r.producto}${r.lote ? ' (L ' + r.lote + ')' : ''}: llegó ${r.contado} und | debería ser ${r.esperado} und → ${dif}` +
        `${r.estado === 'Lote distinto' ? ' [lote distinto]' : ''}${ev && ev.motivo ? ' — ' + ev.motivo : ''}${ev && ev.nota ? ': ' + ev.nota : ''}`;
    });
    const nFotos = rows.reduce((s, r) => s + (evOf(current, r.id)?.fotos.length || 0), 0);
    const text = `Revisión ${current.nombre}${current.sucursal ? ' - ' + current.sucursal : ''}\n` +
      (current.contadoPor ? `Contó: ${current.contadoPor}\n` : '') +
      (lines.length ? `Diferencias (${lines.length}):\n${lines.join('\n')}` : 'Todo correcto, sin diferencias.');
    // Adjunta las fotos cuando el equipo lo permite (WhatsApp, correo, etc.).
    const files = [];
    for (const r of rows) {
      const ev = evOf(current, r.id);
      if (!ev) continue;
      let k = 1;
      for (const fid of ev.fotos) {
        const blob = await Fotos.get(fid);
        if (blob) files.push(new File([blob], `${safeName(r.producto)}-${safeName(r.lote || 'sl')}-${k++}.jpg`, { type: 'image/jpeg' }));
      }
    }
    if (navigator.share) {
      try {
        if (files.length && navigator.canShare && navigator.canShare({ files })) await navigator.share({ text, files });
        else await navigator.share({ text });
        return;
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    window.open('https://wa.me/?text=' + encodeURIComponent(text + (nFotos ? `\n(${nFotos} fotos guardadas en la tablet)` : '')), '_blank');
  };

  // ---------- Utilidades ----------
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const safeName = (s) => stripAccents(s || 'pedido').replace(/[^\w\-]+/g, '_').slice(0, 60);

  // ---------- Arranque ----------
  window.addEventListener('hashchange', checkHash);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin modo offline */ });
  }
  if (!checkHash()) renderHome();

  // Exponer funciones para pruebas
  window.__app = { parseDelimited, rowsToItems, normCode, parseNum, computeResults, processCode: (c) => handleCode(c) };
})();

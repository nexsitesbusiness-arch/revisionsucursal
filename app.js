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
  // Montos en pesos chilenos: separador de miles y sin decimales salvo que los tenga.
  const fmtMoney = (n) => (Number(n) || 0).toLocaleString('es-CL', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  // Fechas en hora de Santiago, formato dd-mm-aaaa HH:MM.
  const TZ = 'America/Santiago';
  function fmtDate(ts, withSec = false) {
    const p = {};
    new Intl.DateTimeFormat('es-CL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: withSec ? '2-digit' : undefined, hour12: false })
      .formatToParts(new Date(ts)).forEach((x) => { p[x.type] = x.value; });
    return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}${withSec ? ':' + p.second : ''}`;
  }
  const fmtSecs = (s) => (s == null ? '' : s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);

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

  // Textos según el tipo de documento: pedido (recepción) o inventario (existencias).
  const T = (o) => (o && o.tipo === 'inventario'
    ? { doc: 'inventario', Doc: 'Inventario', llego: 'Contado', debia: 'Sistema', noLlego: 'No encontrado', extra: 'No figura en sistema', contar: 'Contar inventario', ok: 'el conteo coincide con el sistema', cero: 'no encontrados (0)' }
    : { doc: 'pedido', Doc: 'Pedido', llego: 'Llegó', debia: 'Debería ser', noLlego: 'No llegó', extra: 'No estaba en pedido', contar: 'Contar pedido', ok: 'el pedido llegó completo', cero: 'no recibidos (0)' });

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
  let current = null; // pedido o inventario abierto
  let me = null; // usuario con sesión iniciada
  // Roles: admin (todo), qf (revisa y verifica desviaciones), auxiliar (solo cuenta, a ciegas).
  const role = () => (me ? (me.rol === 'sucursal' ? 'auxiliar' : me.rol) : null);
  const isAdmin = () => role() === 'admin';
  const isStaff = () => role() === 'admin' || role() === 'qf';
  const views = ['login', 'home', 'load', 'order', 'count', 'results', 'users', 'catalog', 'inv', 'log'];
  function show(view, title) {
    const prev = views.find((v) => !$('#view-' + v).hidden);
    if (prev !== view || (viewTimer && current && viewTimer.docId !== current.id)) {
      closeViewTimer();
      if (TIMED[view] && me) viewTimer = { view, t: Date.now(), docId: current ? current.id : null, doc: current ? current.nombre : null, sucursal: current ? current.sucursal : null };
    }
    views.forEach((v) => { $('#view-' + v).hidden = v !== view; });
    $('#title').textContent = title || '';
    if (view !== 'count') stopScanner();
    window.scrollTo(0, 0);
  }
  $('#btnHome').onclick = () => { if (me) renderHome(); };

  // ---------- Bitácora ----------
  // Registra una acción del usuario actual. Nunca incluye contraseñas.
  function audit(accion, extra = {}) {
    if (!window.Bitacora) return;
    const o = extra.doc === undefined && current ? current : null;
    Bitacora.log(Object.assign({
      usuarioId: me ? me.id : null, usuario: me ? me.usuario : (extra.usuario || null), nombre: me ? me.nombre : null, rol: me ? role() : null,
      accion, docId: o ? o.id : null, doc: o ? o.nombre : null, sucursal: o ? o.sucursal || null : null,
    }, extra));
  }
  // Tiempo en pantallas de trabajo (conteo y reporte): se registra al salir.
  let viewTimer = null;
  const TIMED = { count: 'Tiempo en conteo', results: 'Tiempo en reporte de desviaciones', log: 'Tiempo en bitácora' };
  function closeViewTimer() {
    if (!viewTimer) return;
    const seg = Math.round((Date.now() - viewTimer.t) / 1000);
    if (seg >= 2) audit(TIMED[viewTimer.view], { docId: viewTimer.docId, doc: viewTimer.doc, sucursal: viewTimer.sucursal, duracionSeg: seg });
    viewTimer = null;
  }
  window.addEventListener('pagehide', closeViewTimer);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { const v = viewTimer; closeViewTimer(); if (v) viewTimer = { ...v, t: Date.now(), paused: true }; }
    else if (viewTimer && viewTimer.paused) viewTimer = { ...viewTimer, t: Date.now(), paused: false };
  });

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
        dlg.querySelectorAll('#dlgBody [name]').forEach((el) => { if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) return; fields[el.name] = el.value; });
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
      if (!isStaff()) return { counted, key: 'done', tag: '<span class="pill ok">Finalizado</span>', diffs: 0 };
      const d = computeResults(o).filter((r) => r.dif !== 0).length;
      const tag = o.verifiedAt ? `<span class="pill ok">Aprobado${d ? ' · ' + d + ' dif.' : ''}</span>`
        : d ? `<span class="pill bad">${d} ${d === 1 ? 'desviación' : 'desviaciones'} · por verificar</span>` : '<span class="pill ok">Sin desviaciones</span>';
      return { counted, key: 'done', tag, diffs: d };
    }
    return { counted, key: counted ? 'counting' : 'new', tag: counted ? '<span class="pill warn">En conteo</span>' : '<span class="pill">Sin contar</span>', diffs: 0 };
  }

  function renderHome() {
    current = null;
    show('home');
    $('#homeKicker').textContent = me ? rolName(role()) + ' · ' + me.nombre : 'Inicio';
    const st = db.orders.map(orderStatus);
    const open = st.filter((x) => x.key !== 'done').length;
    const done = st.filter((x) => x.key === 'done').length;
    const withDiffs = st.filter((x) => x.diffs > 0).length;
    const nInv = db.orders.filter((o) => o.tipo === 'inventario').length;
    $('#homeStats').innerHTML = !isStaff() ? `
      <div class="kpi"><div class="l">Por contar</div><div class="v">${st.filter((x) => x.key === 'new').length}</div><div class="s">sin empezar</div></div>
      <div class="kpi"><div class="l">En conteo</div><div class="v">${st.filter((x) => x.key === 'counting').length}</div><div class="s">empezados</div></div>
      <div class="kpi ok"><div class="l">Finalizados</div><div class="v">${done}</div><div class="s">entregados al QF</div></div>` : `
      <div class="kpi"><div class="l">Documentos</div><div class="v">${db.orders.length}</div><div class="s">${db.orders.length - nInv} pedidos · ${nInv} inventarios</div></div>
      <div class="kpi"><div class="l">En revisión</div><div class="v">${open}</div><div class="s">abiertos</div></div>
      <div class="kpi ok"><div class="l">Cerrados</div><div class="v">${done}</div><div class="s">conteos terminados</div></div>
      <div class="kpi ${withDiffs ? 'bad' : ''}"><div class="l">Por verificar</div><div class="v">${db.orders.filter((o) => o.finishedAt && !o.verifiedAt && orderStatus(o).diffs).length}</div><div class="s">${withDiffs} con desviaciones</div></div>`;

    const list = $('#orderList');
    if (!db.orders.length) {
      list.innerHTML = `<div class="empty">Todavía no hay pedidos ni inventarios. ${isAdmin() ? 'Usa <b>Nuevo pedido</b> o <b>Nuevo inventario</b>, o abre' : 'Abre'} el enlace o archivo que te enviaron.
        ${isAdmin() ? `<div class="actions" style="justify-content:center;margin-top:14px"><button class="btn" id="btnDemo">${ic('box')} Cargar pedido de ejemplo</button></div>` : ''}</div>`;
      if ($('#btnDemo')) $('#btnDemo').onclick = () => openOrder(createDemo().id);
      return;
    }
    list.innerHTML = `<div class="table-wrap"><table class="orders">
      <thead><tr><th>Documento</th><th>Sucursal</th><th>Avance</th><th>Estado</th><th class="num">Fecha</th></tr></thead>
      <tbody>${db.orders.slice().sort((a, b) => b.creado - a.creado).map((o) => {
        const x = orderStatus(o);
        const pct = o.finishedAt ? 100 : (o.items.length ? Math.round((x.counted / o.items.length) * 100) : 0);
        return `<tr class="click" data-id="${o.id}">
          <td><b>${esc(o.nombre || T(o).Doc)}</b><div class="sub"><span class="pill type">${T(o).Doc}</span> ${o.items.length} productos${o.contadoPor ? ' · contó ' + esc(o.contadoPor) : ''}</div></td>
          <td class="c-branch">${esc(o.sucursal || '—')}</td>
          <td class="c-progress"><span class="sub">${o.finishedAt ? 'Cerrado' : `${x.counted} de ${o.items.length}`}</span><div class="mini-bar"><span style="width:${pct}%"></span></div></td>
          <td class="c-state">${x.tag}</td>
          <td class="num c-date sub">${fmtDate(o.finishedAt || o.creado)}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
    list.querySelectorAll('tr[data-id]').forEach((r) => { r.onclick = () => openOrder(r.dataset.id); });
  }

  // Pedido de ejemplo para probar la app sin preparar archivos.
  function createDemo() {
    const items = [
      ['7790001000011', 'Paracetamol 500 mg x 20 comp', 'L2405A', 2.5, 30, '2027-05-31'],
      ['7790001000028', 'Ibuprofeno 400 mg x 10 comp', 'IB7781', 3.1, 24, '2027-02-28'],
      ['7790001000028', 'Ibuprofeno 400 mg x 10 comp', 'IB7790', 3.1, 12, '2027-08-31'],
      ['7790001000035', 'Amoxicilina 500 mg x 12 caps', 'AMX330', 6.8, 15, '2026-12-31'],
      ['7790001000042', 'Omeprazol 20 mg x 14 caps', 'OM1120', 4.25, 20, '2027-03-31'],
      ['7790001000059', 'Alcohol en gel 250 ml', 'AG0915', 1.9, 40, '2028-01-31'],
    ].map(([codigo, producto, lote, precio, cantidad, vencimiento]) => ({ id: uid(), codigo, producto, lote, precio, cantidad, vencimiento }));
    const o = newOrder({ nombre: 'Pedido de ejemplo', sucursal: 'Sucursal Centro', items });
    db.orders.push(o);
    save();
    return o;
  }

  // Solo tema claro (estándar del proyecto). Se limpia la preferencia antigua de modo oscuro.
  try { localStorage.removeItem('revision-tema'); } catch (e) { /* sin almacenamiento */ }

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

  const MAX_MB = 25;
  const tooBig = (f) => f.size > MAX_MB * 1024 * 1024;
  async function importFile(f, isPhoto = false) {
    if (tooBig(f)) throw new Error(`El archivo pesa más de ${MAX_MB} MB. Revisa que sea el correcto.`);
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

  // Plantilla en Excel con los encabezados y dos filas de ejemplo.
  $('#btnTemplate').onclick = () => {
    const rows = [
      ['Código', 'Producto', 'Lote', 'Precio', 'Cantidad', 'Vencimiento'],
      ['7790001000011', 'Paracetamol 500 mg x 20 comp', 'L2405A', 2.5, 30, '2027-05-31'],
      ['7790001000028', 'Ibuprofeno 400 mg x 10 comp', 'IB7781', 3.1, 24, '2027-02-28'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 16 }, { wch: 34 }, { wch: 10 }, { wch: 9 }, { wch: 10 }, { wch: 13 }];
    // Código como texto, para que Excel no lo convierta a 7,79E+12.
    for (let r = 1; r < rows.length; r++) { const cell = ws[XLSX.utils.encode_cell({ r, c: 0 })]; cell.t = 's'; cell.z = '@'; }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pedido');
    XLSX.writeFile(wb, 'plantilla-pedido.xlsx');
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
    audit('Creó pedido', { docId: o.id, doc: o.nombre, sucursal: o.sucursal || null, detalle: `${o.items.length} productos` });
    openOrder(o.id);
  };

  function newOrder({ id, nombre, sucursal, creado, items, origen = 'central', tipo = 'pedido', fechaSistema = '' }) {
    return { id: id || uid(), tipo, nombre, sucursal, fechaSistema, creado: creado || Date.now(), creadoPor: me ? me.nombre : '', origen, items,
      counts: {}, extras: [], evid: {}, log: [], finishedAt: null, reopened: 0 };
  }

  // =========================================================
  // PEDIDO: ENVÍO / IMPORTACIÓN
  // =========================================================
  function openOrder(id) {
    current = getOrder(id);
    if (!current) return renderHome();
    show('order', current.nombre);
    audit(`Abrió ${T(current).doc}`, { detalle: current.finishedAt ? 'finalizado' : 'abierto' });
    $('#orderTitle').textContent = current.nombre;
    $('#orderMeta').textContent = `${T(current).Doc}${current.sucursal ? ' · ' + current.sucursal : ''}${current.fechaSistema ? ' · existencias al ' + current.fechaSistema : ''} · ${current.items.length} productos`;
    $('#shareWhat').textContent = current.tipo === 'inventario' ? 'del sistema' : 'enviadas';
    const x = orderStatus(current);
    $('#orderProgress').textContent = current.finishedAt ? `Finalizado ${fmtDate(current.finishedAt)}${current.contadoPor ? ' · contó ' + current.contadoPor : ''}${current.verifiedAt ? ' · aprobado por ' + (current.verifiedBy || 'QF') : isStaff() ? ' · por verificar' : ' · en revisión del QF'}`
      : x.counted ? `${x.counted} de ${current.items.length} productos contados` : 'Aún sin contar';
    $('#orderBar').style.width = (current.finishedAt ? 100 : current.items.length ? (x.counted / current.items.length) * 100 : 0) + '%';
    $('#btnStartCount').innerHTML = ic('scan') + (current.finishedAt ? (isStaff() ? ' Reabrir conteo' : ' Conteo finalizado') : x.counted ? ' Seguir contando' : ' ' + T(current).contar);
    $('#btnShowResults').innerHTML = ic('chart') + (current.tipo === 'inventario' ? ' Reporte de desviaciones' : ' Ver diferencias');
    $('#shareInfo').textContent = '';
  }

  // El pedido viaja comprimido, así las cantidades no quedan a la vista.
  function exportPayload(o) {
    const data = { v: 1, id: o.id, n: o.nombre, s: o.sucursal, c: o.creado, t: o.tipo || 'pedido', f: o.fechaSistema || '',
      i: o.items.map((i) => [i.codigo, i.producto, i.lote, i.precio, i.cantidad, i.vencimiento, i.sku || '', i.categoria || '']) };
    return LZString.compressToEncodedURIComponent(JSON.stringify(data));
  }
  function importPayload(str) {
    const d = JSON.parse(LZString.decompressFromEncodedURIComponent(str));
    if (!d || d.v !== 1 || !Array.isArray(d.i)) throw new Error('inválido');
    const existing = getOrder(d.id);
    if (existing) { openOrder(existing.id); return; }
    const o = newOrder({ id: d.id, nombre: d.n, sucursal: d.s, creado: d.c, origen: 'recibido', tipo: d.t || 'pedido', fechaSistema: d.f || '',
      items: d.i.map(([codigo, producto, lote, precio, cantidad, vencimiento, sku, categoria]) =>
        ({ id: uid(), codigo, producto, lote, precio, cantidad, vencimiento, sku: sku || '', categoria: categoria || '' })) });
    db.orders.push(o);
    save();
    audit(`Abrió ${T(o).doc} recibido`, { docId: o.id, doc: o.nombre, sucursal: o.sucursal || null, detalle: `${o.items.length} productos` });
    openOrder(o.id);
  }

  $('#btnShareLink').onclick = async () => {
    const url = location.origin + location.pathname + '#p=' + exportPayload(current);
    audit('Compartió enlace del documento');
    const text = `${T(current).Doc} "${current.nombre}" para contar:`;
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
    audit('Descargó archivo del documento');
  };
  $('#btnDeleteOrder').onclick = async () => {
    const r = await ask({ title: `¿Eliminar este ${T(current).doc}?`, html: '<p>Se borrará también el conteo y sus fotos.</p>',
      buttons: [{ label: 'Cancelar', value: '' }, { label: 'Eliminar', value: 'del', cls: 'danger' }] });
    if (r.value !== 'del') return;
    Object.values(current.evid || {}).forEach((ev) => ev.fotos.forEach((fid) => Fotos.del(fid)));
    audit(`Eliminó ${T(current).doc}`, { detalle: `${current.items.length} productos` });
    db.orders = db.orders.filter((o) => o.id !== current.id);
    save();
    renderHome();
  };
  $('#btnStartCount').onclick = () => startCount();
  $('#btnShowResults').onclick = () => finishCount();

  function checkHash() {
    const m = location.hash.match(/^#p=(.+)$/);
    if (!m) return false;
    if (!me) return false; // se procesa después de iniciar sesión
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
    audit('Registró evidencia', { detalle: `${next.motivo || 'sin motivo'}${next.nota ? ' · ' + next.nota : ''} · ${fotos.length} foto(s)`, producto: titulo });
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
      if (!isStaff()) {
        info('Conteo finalizado', 'Este conteo ya fue entregado. Lo revisa el QF; si hay que recontar algo, te lo indicará.');
        return;
      }
      if (current.verifiedAt && !isAdmin()) {
        info('Inventario aprobado', `Fue aprobado por ${esc(current.verifiedBy || 'el QF')}. Solo un administrador puede reabrirlo.`).then(() => renderResults());
        return;
      }
      ask({ title: 'Este conteo ya fue terminado', html: '<p>¿Quieres reabrirlo para corregir? Quedará registrado que se reabrió.</p>',
        buttons: [{ label: 'Ver diferencias', value: 'res' }, { label: 'Reabrir conteo', value: 'open', cls: 'primary' }] })
        .then((r) => {
          if (r.value === 'open') { audit('Reabrió conteo'); current.finishedAt = null; current.verifiedAt = null; current.reopened = (current.reopened || 0) + 1; save(); startCount(); }
          else if (r.value === 'res') renderResults();
        });
      return;
    }
    show('count', current.nombre);
    audit('Abrió conteo');
    $('#countKicker').textContent = [current.sucursal, current.tipo === 'inventario' && current.fechaSistema ? 'existencias al ' + current.fechaSistema : current.nombre].filter(Boolean).join(' · ');
    $('#countTitle').textContent = current.tipo === 'inventario' ? 'Conteo del inventario' : 'Conteo del pedido';
    $('#search').value = '';
    const cats = [...new Set(current.items.map((i) => i.categoria).filter(Boolean))].sort();
    const sel = $('#catFilter');
    sel.hidden = cats.length < 2;
    sel.innerHTML = '<option value="">Todas las categorías</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
    renderCount();
  }

  const qty = (item) => current.counts[item.id] || 0;

  function itemMatches(i, q) {
    if (!q) return true;
    const hay = i._hay || (i._hay = normText(`${i.producto} ${i.codigo} ${i.lote} ${i.sku || ''}`));
    return q.split(/\s+/).every((t) => hay.includes(t));
  }

  function renderCount() {
    const q = normText($('#search').value);
    const onlyPending = $('#onlyPending').checked;
    const cat = $('#catFilter').hidden ? '' : $('#catFilter').value;
    let items = current.items.filter((i) => itemMatches(i, q) && (!onlyPending || !qty(i)) && (!cat || i.categoria === cat));
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
      i.sku && `<b class="mono">${esc(i.sku)}</b>`,
      i.codigo && `<span class="mono">${esc(i.codigo)}</span>`,
      i.lote && `Lote <b class="mono">${esc(i.lote)}</b>`,
      i.categoria && `<span class="opt">${esc(i.categoria)}</span>`,
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
    $('#progressText').textContent = `${done.toLocaleString('es')} de ${total.toLocaleString('es')} productos · ${units.toLocaleString('es')} unid.`;
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
    if (log) {
      current.log.push({ t: 'i', id: item.id, prev });
      audit('Registró cantidad', { producto: item.producto, sku: item.sku || item.codigo || null, detalle: `${prev} → ${n}` });
    }
    current.startedAt = current.startedAt || Date.now();
    if (current.log.length > 300) current.log.shift();
    save();
    updateItemRow(item);
    renderProgress();
  }

  let searchTimer;
  $('#search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderCount, current && current.items.length > 300 ? 150 : 0); };
  $('#catFilter').onchange = () => renderCount();
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
    if (current.log.length) audit('Deshizo el último registro');
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
  function addExtra({ codigo = '', sku = '', producto, lote = '', motivo }, amount) {
    const key = normCode(codigo) + '|' + normLote(lote) + '|' + normText(producto);
    let ex = current.extras.find((x) => normCode(x.codigo) + '|' + normLote(x.lote) + '|' + normText(x.producto) === key);
    if (!ex) { ex = { id: uid(), codigo, sku, producto, lote, motivo, cantidad: 0 }; current.extras.push(ex); }
    current.log.push({ t: 'e', id: ex.id, prev: ex.cantidad });
    current.startedAt = current.startedAt || Date.now();
    ex.cantidad += amount;
    audit('Agregó producto fuera de la lista', { producto: ex.producto, sku: ex.sku || ex.codigo || null, detalle: `${ex.cantidad - amount} → ${ex.cantidad}${ex.lote ? ' · lote ' + ex.lote : ''}` });
    save();
    renderExtras();
    renderProgress();
    return ex;
  }

  function renderExtras() {
    const box = $('#extrasBox');
    if (!current.extras.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<h3 class="section-title">${ic('alert')} ${isStaff() ? (current.tipo === 'inventario' ? 'Encontrados que no figuran en el sistema' : 'Recibidos que no estaban en el pedido') : 'Agregados por ti'}</h3>
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
    const antes = ex.cantidad;
    ex.cantidad = Math.max(0, Math.round(fn(ex.cantidad)));
    audit('Cambió cantidad de producto agregado', { producto: ex.producto, sku: ex.sku || ex.codigo || null, detalle: `${antes} → ${ex.cantidad}` });
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
    addExtra({ codigo: r.fields.codigo.trim(), producto: r.fields.producto.trim(), lote: r.fields.lote.trim(), motivo: T(current).extra },
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
    let matches = current.items.filter((i) => (i.codigo && normCode(i.codigo) === code) || (i.sku && normCode(i.sku) === code));
    const cat = catalogFind(code);
    if (!matches.length && cat) matches = current.items.filter((i) => (i.sku && normCode(i.sku) === normCode(cat.sku)) || (i.codigo && cat.ean && normCode(i.codigo) === normCode(cat.ean)));

    if (!matches.length) {
      beep(false);
      const t = T(current);
      const r = await ask({ title: isStaff() ? `Código no está en el ${t.doc}` : 'Producto que no está en la lista',
        html: `<p class="mono">${esc(raw)}</p>${cat ? `<p>Según el maestro es <b>${esc(cat.nombre)}</b> (material <span class="mono">${esc(cat.sku)}</span>).</p>` : ''}
          ${scannedLote ? `<p>Lote leído: <b class="mono">${esc(scannedLote)}</b></p>` : ''}
          <p>${!isStaff() ? 'Si el producto está aquí, agrégalo para contarlo.' : current.tipo === 'inventario' ? 'Si el producto está en la sucursal, regístralo como sobrante.' : 'Si llegó en la cubeta, regístralo como sobrante.'}</p>
          <label>Nombre del producto<input name="producto" placeholder="Ej: Ibuprofeno 400mg" value="${esc(cat ? cat.nombre : '')}"></label>`,
        buttons: [{ label: 'Ignorar', value: '' }, { label: isStaff() ? 'Registrar sobrante' : 'Agregar y contar', value: 'ok', cls: 'primary' }] });
      if (r.value === 'ok') {
        addExtra({ codigo: cat && cat.ean ? cat.ean : (gs1 ? gs1.gtin : raw), sku: cat ? cat.sku : '', producto: r.fields.producto.trim() || 'Producto sin nombre (' + raw + ')',
          lote: scannedLote, motivo: t.extra }, amount);
        flash(isStaff() ? `${ic('alert')}<span>Registrado como sobrante</span>` : `${ic('check')}<span>Agregado a la lista</span>`, isStaff() ? 'warn' : 'ok');
      }
      return;
    }

    let target = null;
    if (scannedLote) {
      // El código trae lote (DataMatrix GS1): verificamos contra el pedido.
      target = matches.find((i) => normLote(i.lote) === normLote(scannedLote));
      if (!target) {
        const expected = matches.map((i) => i.lote || 'sin lote').join(', ');
        addExtra({ codigo: matches[0].codigo, producto: matches[0].producto, lote: scannedLote, motivo: 'Lote distinto al enviado' }, amount);
        // El auxiliar no recibe aviso de error: solo confirma lo registrado.
        if (!isStaff()) { beep(true); flash(`${ic('check')}<span>${esc(matches[0].producto)} · lote ${esc(scannedLote)} — registrado</span>`, 'ok'); return; }
        beep(false);
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
          if (!isStaff()) { beep(true); flash(`${ic('check')}<span>Lote ${esc(r.fields.otro.trim())} — registrado</span>`, 'ok'); return; }
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
    const c = normCode(GS1.parse(v)?.gtin || v);
    const exact = current.items.some((i) => (i.codigo && normCode(i.codigo) === c) || (i.sku && normCode(i.sku) === c)) || !!catalogFind(c);
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
        html: `<p>${pending ? `Hay <b>${pending}</b> productos sin contar; se tomarán como <b>${T(current).cero}</b>.` : 'Todos los productos tienen conteo.'}</p>
          <label>Contado por<input name="por" placeholder="Nombre de quien contó" value="${esc(me ? me.nombre : lastPerson())}" ${me ? 'readonly' : ''}></label>
          <p class="small muted">${isStaff() ? 'Al ver las diferencias el conteo queda cerrado.' : 'Al finalizar ya no podrás cambiar las cantidades. El QF revisará el conteo.'}</p>`,
        buttons: [{ label: 'Seguir contando', value: '' }, { label: isStaff() ? 'Sí, ver diferencias' : 'Sí, finalizar', value: 'ok', cls: 'primary' }] });
      if (r.value !== 'ok') return;
      current.finishedAt = Date.now();
      current.contadoPor = (r.fields.por || '').trim();
      audit('Finalizó conteo', { detalle: `${current.items.filter((i) => qty(i) > 0).length} productos con cantidad · ${current.items.filter((i) => !qty(i)).length} sin contar · ${current.extras.length} agregados` });
      try { localStorage.setItem('revision-responsable', current.contadoPor); } catch (e) { /* sin almacenamiento */ }
      save();
    }
    if (!isStaff()) {
      // El auxiliar solo recibe la confirmación; las desviaciones las ve el QF.
      const n = current.items.filter((i) => qty(i) > 0).length + current.extras.length;
      await ask({ title: 'Conteo finalizado', html: `<div class="done-ok">${ic('check')}</div>
        <p class="center">Quedó registrado tu conteo de <b>${n.toLocaleString('es')}</b> productos.<br>El QF revisará las desviaciones.</p>`,
        buttons: [{ label: 'Volver al inicio', value: 'ok', cls: 'primary' }] });
      return renderHome();
    }
    renderResults();
  }

  function lastPerson() {
    try { return localStorage.getItem('revision-responsable') || ''; } catch (e) { return ''; }
  }
  const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'menos de 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

  // Costo unitario: el del pedido o, si no tiene, el del maestro / lista de precios.
  function priceFor(sku, ean) {
    const p = (sku && catalogIndex().sku.get(normCode(sku))) || (ean && catalogIndex().ean.get(normCode(ean)));
    return p && p.precio ? p.precio : 0;
  }
  // Revisión del QF por producto: { decision: 'correcta' | 'corregida', cantidad, obs, por, ts, seg, origen }.
  // Compatibilidad: los recuentos antiguos (o.recount) se leen como "corregida".
  function reviewOf(o, id) {
    const r = (o.review || {})[id];
    if (r) return r;
    const old = (o.recount || {})[id];
    return old != null ? { decision: 'corregida', cantidad: old, obs: '', por: o.recountBy || '', ts: null, seg: null, origen: 'diferencia' } : null;
  }
  const sampledIds = (o) => new Set((o.samples || []).flatMap((m) => m.ids));

  function computeResults(o) {
    const t = T(o);
    const sampled = sampledIds(o);
    const mk = (base, contadoAux, esperado, estadoExtra) => {
      const rv = reviewOf(o, base.id);
      const recuento = rv && rv.decision === 'corregida' ? rv.cantidad : null;
      const contado = recuento ?? contadoAux;
      const dif = contado - esperado;
      const difAux = contadoAux - esperado;
      let estado = estadoExtra || 'OK';
      if (!estadoExtra) {
        if (dif < 0) estado = contado === 0 ? t.noLlego : 'Faltante';
        else if (dif > 0) estado = 'Sobrante';
      }
      const precio = base.precio || priceFor(base.sku, base.codigo);
      return { ...base, contadoAux, recuento, review: rv, muestra: sampled.has(base.id), contado, esperado, dif, difAux, estado, precio,
        valor: +(dif * precio).toFixed(2), valorAux: +(difAux * precio).toFixed(2) };
    };
    const rows = o.items.map((i) => mk({ id: i.id, codigo: i.codigo, sku: i.sku || '', categoria: i.categoria || '', producto: i.producto, lote: i.lote, precio: i.precio },
      o.counts[i.id] || 0, i.cantidad));
    for (const x of o.extras) {
      rows.push(mk({ id: x.id, codigo: x.codigo, sku: x.sku || '', categoria: '', producto: x.producto, lote: x.lote, precio: 0 },
        x.cantidad, 0, x.motivo === 'Lote distinto al enviado' ? 'Lote distinto' : t.extra));
    }
    return rows;
  }
  // Lo que el QF debe revisar: toda desviación del conteo del auxiliar y toda la muestra aleatoria.
  const mustReview = (r) => r.difAux !== 0 || r.muestra;

  // Clasificación ABC de las desviaciones del conteo: A = 80 % del valor, B = siguiente 15 %, C = resto.
  // Sin costos, se ordena por unidades de diferencia.
  function classifyABC(rows) {
    const diffs = rows.filter((r) => r.difAux !== 0);
    const byValue = diffs.some((r) => r.precio > 0);
    const key = (r) => (byValue ? Math.abs(r.valorAux) : Math.abs(r.difAux));
    diffs.sort((a, b) => key(b) - key(a));
    const total = diffs.reduce((s, r) => s + key(r), 0) || 1;
    let acc = 0;
    for (const r of diffs) {
      const before = acc / total;
      r.abc = before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C';
      acc += key(r);
    }
    rows.forEach((r) => { if (r.difAux === 0) r.abc = ''; });
    return { byValue, order: diffs, key };
  }

  function renderResults() {
    if (!isStaff()) { audit('Intento de ver el reporte de desviaciones', { resultado: 'denegado' }); return renderHome(); }
    show('results', current.nombre);
    $('#abcFilter').value = '';
    $('#reportSearch').value = '';
    audit('Abrió reporte de desviaciones');
    renderSummary();
    renderResultsTable();
  }

  function renderSummary() {
    const rows = computeResults(current);
    const { byValue, order } = classifyABC(rows);
    const t = T(current);
    const falt = rows.filter((r) => r.dif < 0), sobr = rows.filter((r) => r.dif > 0);
    const uFalt = -falt.reduce((s, r) => s + r.dif, 0), uSobr = sobr.reduce((s, r) => s + r.dif, 0);
    const vFalt = -falt.reduce((s, r) => s + r.valor, 0), vSobr = sobr.reduce((s, r) => s + r.valor, 0);
    const ok = rows.length - order.length;
    const pct = rows.length ? Math.round((ok / rows.length) * 100) : 0;
    const nA = order.filter((r) => r.abc === 'A'), nB = order.filter((r) => r.abc === 'B'), nC = order.filter((r) => r.abc === 'C');
    const req = rows.filter(mustReview);
    const done = req.filter((r) => r.review).length;
    const doneA = nA.filter((r) => r.review).length;
    const samp = rows.filter((r) => r.muestra);
    const vPct = req.length ? Math.round((done / req.length) * 100) : 100;
    const dur = current.startedAt && current.finishedAt ? fmtDur(current.finishedAt - current.startedAt) : '—';
    const money = (v) => (Math.abs(v) >= 1e6 ? '$ ' + (v / 1e6).toLocaleString('es-CL', { maximumFractionDigits: 1 }) + ' M' : '$ ' + Math.round(v).toLocaleString('es-CL'));
    const prod = (n) => `${n.toLocaleString('es-CL')} ${n === 1 ? 'producto' : 'productos'}`;
    $('#summary').innerHTML = `
      <div class="page-head">
        <div>
          <span class="kicker">${t.Doc} · ${esc(current.sucursal || 'Sucursal')}${current.fechaSistema ? ' · existencias al ' + esc(current.fechaSistema) : ''} · finalizado ${current.finishedAt ? fmtDate(current.finishedAt) : ''}${current.contadoPor ? ' · contó ' + esc(current.contadoPor) : ''} · ${dur}${current.reopened ? ` · reabierto ${current.reopened}×` : ''}</span>
          <h2 class="page-title">Reporte de desviaciones</h2>
        </div>
        ${current.verifiedAt ? `<span class="pill ok big-pill">${ic('check')} Aprobado por ${esc(current.verifiedBy || 'QF')} · ${fmtDate(current.verifiedAt)}</span>` : ''}
      </div>
      ${byValue || !order.length ? '' : `<div class="load-status warn" style="margin-bottom:14px">${ic('alert')}<span>Sin costos cargados: el orden ABC se calcula por <b>unidades</b> de diferencia. Para ordenarlo por valor, carga los costos en Menú → Maestro de productos.</span></div>`}
      <div class="kpis five">
        <div class="kpi ${order.length ? '' : 'ok'}"><div class="l">Exactitud del conteo</div><div class="v">${pct}%</div><div class="s">${ok.toLocaleString('es-CL')} de ${rows.length.toLocaleString('es-CL')} líneas sin desviación</div><div class="meter"><span style="width:${pct}%"></span></div></div>
        <div class="kpi ${uFalt ? 'bad' : ''}"><div class="l">Faltan</div><div class="v">${byValue ? money(vFalt) : uFalt.toLocaleString('es-CL')}</div><div class="s">${uFalt.toLocaleString('es-CL')} unid. · ${prod(falt.length)}</div></div>
        <div class="kpi ${uSobr ? 'warn' : ''}"><div class="l">Sobran</div><div class="v">${byValue ? money(vSobr) : uSobr.toLocaleString('es-CL')}</div><div class="s">${uSobr.toLocaleString('es-CL')} unid. · ${prod(sobr.length)}</div></div>
        <div class="kpi"><div class="l">Desviaciones ABC</div><div class="v abc-v"><span class="abc A">A ${nA.length}</span><span class="abc B">B ${nB.length}</span><span class="abc C">C ${nC.length}</span></div><div class="s">${byValue ? 'por valor' : 'por unidades'} · A = 80 % del total</div></div>
        <div class="kpi ${vPct === 100 ? 'ok' : ''}"><div class="l">Revisión QF</div><div class="v">${done.toLocaleString('es-CL')} / ${req.length.toLocaleString('es-CL')}</div><div class="s">Clase A: ${doneA} de ${nA.length}${samp.length ? ` · aleatorias: ${samp.filter((r) => r.review).length} de ${samp.length}` : ''}</div><div class="meter"><span style="width:${vPct}%"></span></div></div>
      </div>`;
    $('#btnApprove').hidden = !!current.verifiedAt;
    $('#btnRandom').hidden = !!current.verifiedAt;
  }

  function renderResultsTable() {
    const rows = computeResults(current);
    const { key } = classifyABC(rows);
    const f = $('#abcFilter').value;
    const q = normText($('#reportSearch').value);
    const rank = { A: 0, B: 1, C: 2, '': 3 };
    let list;
    if (q) list = rows.filter((r) => normText(`${r.producto} ${r.sku} ${r.codigo} ${r.lote} ${r.categoria}`).includes(q));
    else {
      const pass = {
        '': (r) => mustReview(r) || r.review || evOf(current, r.id),
        pend: (r) => mustReview(r) && !r.review,
        rev: (r) => !!r.review,
        A: (r) => r.abc === 'A', B: (r) => r.abc === 'B', C: (r) => r.abc === 'C',
        muestra: (r) => r.muestra,
        todo: () => true,
      }[f] || (() => true);
      list = rows.filter(pass);
    }
    list.sort((a, b) => rank[a.abc] - rank[b.abc] || key(b) - key(a) || a.producto.localeCompare(b.producto, 'es'));
    if (!list.length) {
      const msg = q ? `No hay productos que coincidan con “${esc($('#reportSearch').value)}”.`
        : f === 'pend' ? 'No quedan desviaciones pendientes de revisión.' : f === 'muestra' ? 'Aún no hay revisión aleatoria. Usa el botón Revisión aleatoria.'
          : f ? 'No hay productos en esta vista.' : 'Todo correcto: ' + T(current).ok + '.';
      $('#resultsTable').innerHTML = `<div class="card good-msg">${ic('check')} ${msg}</div>`;
      return;
    }
    const t = T(current);
    const locked = !!current.verifiedAt;
    const shown = list.slice(0, 400);
    $('#resultsTable').innerHTML = `<div class="card"><div class="table-wrap"><table class="results">
      <thead><tr><th>Clase</th><th>Producto</th><th class="num">${t.debia}</th><th class="num">Contado</th><th class="num">Dif.</th><th class="num">Valor</th><th>Revisión QF</th></tr></thead>
      <tbody>${shown.map((r) => {
        const rv = r.review;
        const revTxt = rv ? (rv.decision === 'corregida' ? `Corregida a ${rv.cantidad}` : 'Cantidad correcta') : '';
        return `<tr data-rid="${r.id}" class="${rv ? 'verified' : ''}">
        <td data-label="Clase">${r.abc ? `<span class="abc ${r.abc}">${r.abc}</span>` : ''}</td>
        <td data-label="Producto" class="c-prod"><b>${esc(r.producto)}</b><div class="sub">${[r.sku && `<span class="mono">${esc(r.sku)}</span>`, r.codigo && `<span class="mono">${esc(r.codigo)}</span>`, r.lote && `Lote <span class="mono">${esc(r.lote)}</span>`, r.categoria && esc(r.categoria)].filter(Boolean).join(' · ')}</div>
          <div class="state-cell" style="margin-top:6px"><span class="pill ${r.dif === 0 ? 'ok' : r.dif < 0 ? 'bad' : 'warn'}">${esc(r.estado)}</span>${r.muestra ? '<span class="pill sample">Aleatoria</span>' : ''}</div>${evHtml(r.id)}</td>
        <td data-label="${t.debia}" class="num">${r.esperado.toLocaleString('es-CL')}</td>
        <td data-label="Contado" class="num">${r.contadoAux.toLocaleString('es-CL')}${r.recuento !== null ? `<div class="sub">QF: ${r.recuento.toLocaleString('es-CL')}</div>` : ''}</td>
        <td data-label="Dif." class="num ${r.dif < 0 ? 'd-neg' : r.dif > 0 ? 'd-pos' : ''}">${r.dif > 0 ? '+' : ''}${r.dif.toLocaleString('es-CL')}</td>
        <td data-label="Valor" class="num">${r.precio ? '$ ' + Math.round(r.valor).toLocaleString('es-CL') : '<span class="muted">—</span>'}</td>
        <td data-label="Revisión QF"><div class="rev-cell">
          ${rv ? `<span class="pill ok">${ic('check')} ${esc(revTxt)}</span><span class="sub">${esc(rv.por || '')}${rv.ts ? ' · ' + fmtDate(rv.ts) : ''}${rv.seg ? ' · ' + fmtSecs(rv.seg) : ''}</span>${rv.obs ? `<span class="obs">“${esc(rv.obs)}”</span>` : ''}`
            : mustReview(r) ? '<span class="pill warn">Pendiente</span>' : ''}
          <div class="state-cell">${locked ? '' : `<button class="btn sm ${rv ? 'ghost' : 'primary'}" data-review="${r.id}">${ic(rv ? 'edit' : 'check')} ${rv ? 'Editar' : 'Revisar'}</button>`}${evButton(current, r.id, 'data-rev')}</div>
        </div></td>
      </tr>`;
      }).join('')}</tbody></table></div>
      ${list.length > shown.length ? `<p class="small muted" style="padding:10px 14px;margin:0">Mostrando ${shown.length} de ${list.length.toLocaleString('es-CL')}. Usa el buscador o los filtros, o exporta a Excel para ver todo.</p>` : ''}</div>`;
    fillPhotos($('#resultsTable'));
  }

  // ---------- Revisión de un producto por el QF (se mide el tiempo que lo tuvo abierto) ----------
  async function openReview(id, draft = null, startT = null) {
    const rows = computeResults(current);
    classifyABC(rows);
    const r = rows.find((x) => x.id === id);
    if (!r || current.verifiedAt || !isStaff()) return;
    const origen = r.difAux !== 0 ? 'diferencia' : r.muestra ? 'aleatoria' : 'búsqueda';
    const t0 = startT || Date.now();
    const rv = r.review;
    const pre = draft || (rv ? { decision: rv.decision, cantidad: rv.cantidad, obs: rv.obs } : {});
    const ev = evOf(current, r.id);
    const t = T(current);
    const masMenos = r.difAux > 0 ? `realmente hay <b>${r.difAux} más</b> de lo que dice ${t.debia.toLowerCase()}` : r.difAux < 0 ? `realmente hay <b>${-r.difAux} menos</b> de lo que dice ${t.debia.toLowerCase()}` : 'el conteo coincide';
    const p = ask({ title: r.producto,
      html: `<p class="small muted">${[r.sku && 'Material ' + esc(r.sku), r.codigo && 'EAN ' + esc(r.codigo), r.lote && 'Lote ' + esc(r.lote), r.categoria && esc(r.categoria)].filter(Boolean).join(' · ')}${r.abc ? ` · <span class="abc ${r.abc}">${r.abc}</span>` : ''}${r.muestra ? ' · <span class="pill sample">Aleatoria</span>' : ''}</p>
        <div class="rev-facts">
          <div><span>${t.debia}</span><b>${r.esperado.toLocaleString('es-CL')}</b></div>
          <div><span>Contó ${esc(current.contadoPor || 'auxiliar')}</span><b>${r.contadoAux.toLocaleString('es-CL')}</b></div>
          <div><span>Diferencia</span><b class="${r.difAux < 0 ? 'd-neg' : r.difAux > 0 ? 'd-pos' : ''}">${r.difAux > 0 ? '+' : ''}${r.difAux}</b></div>
          <div><span>Valor</span><b>${r.precio ? '$ ' + Math.round(r.valorAux).toLocaleString('es-CL') : '—'}</b></div>
        </div>
        ${ev ? `<p class="small"><b>Evidencia del conteo:</b> ${esc(ev.motivo || '')}${ev.motivo && ev.nota ? ' · ' : ''}${esc(ev.nota || '')}${ev.fotos.length ? ` · ${ev.fotos.length} foto(s)` : ''}</p>` : ''}
        <div class="choice-list">
          <label class="choice"><input type="radio" name="decision" value="correcta" ${pre.decision === 'correcta' ? 'checked' : ''}>
            <span><b>La cantidad contada es correcta</b><small>Lo verifiqué: ${masMenos}.</small></span></label>
          <label class="choice"><input type="radio" name="decision" value="corregida" ${pre.decision === 'corregida' ? 'checked' : ''}>
            <span><b>Corregir la cantidad</b><small>Al recontar, la cantidad real es:</small>
            <input class="choice-qty" name="cantidad" type="number" inputmode="numeric" min="0" placeholder="Cantidad" value="${pre.decision === 'corregida' && pre.cantidad != null ? esc(pre.cantidad) : ''}"></span></label>
        </div>
        <label>Observación<textarea name="obs" rows="2" placeholder="Ej: 2 cajas estaban en bodega; producto vencido apartado">${esc(pre.obs || '')}</textarea></label>
        <p class="rev-timer" id="revTimer">Revisando desde hace 0 s</p>`,
      buttons: [{ label: 'Cancelar', value: '' }, { label: 'Guardar revisión', value: 'ok', cls: 'primary' }] });
    const tick = setInterval(() => { const el = $('#revTimer'); if (el) el.textContent = 'Revisando desde hace ' + fmtSecs(Math.round((Date.now() - t0) / 1000)); }, 1000);
    // Escribir una cantidad marca la opción "Corregir".
    const qtyIn = $('#dlgBody [name=cantidad]');
    qtyIn.addEventListener('input', () => { $('#dlgBody [value=corregida]').checked = true; });
    const res = await p;
    clearInterval(tick);
    // Si falta algo, se avisa y se vuelve a abrir con lo ya escrito (el tiempo sigue corriendo).
    if (res.value === 'ok' && (!res.fields.decision || (res.fields.decision === 'corregida' && String(res.fields.cantidad || '').trim() === ''))) {
      const keep = res.fields;
      const back = await ask({ title: 'Falta completar', html: `<p>${!keep.decision ? 'Elige si la cantidad es correcta o si hay que corregirla.' : 'Escribe la cantidad real que encontraste al recontar.'}</p>`,
        buttons: [{ label: 'Descartar', value: '' }, { label: 'Volver a la revisión', value: 'back', cls: 'primary' }] });
      if (back.value === 'back') return openReview(id, keep, t0);
      res.value = '';
    }
    const seg = Math.round((Date.now() - t0) / 1000);
    const base = { producto: r.producto, sku: r.sku || r.codigo || null, duracionSeg: seg };
    if (res.value !== 'ok') {
      audit('Vio producto sin guardar revisión', { ...base, detalle: `origen: ${origen}` });
      return;
    }
    const f = res.fields;
    const nueva = { decision: f.decision, cantidad: f.decision === 'corregida' ? Math.max(0, Math.round(parseNum(f.cantidad))) : null,
      obs: (f.obs || '').trim(), por: me.nombre, porId: me.id, ts: Date.now(), seg: (rv && rv.seg ? rv.seg : 0) + seg, origen };
    current.review = current.review || {};
    current.review[id] = nueva;
    if (current.recount) delete current.recount[id];
    save();
    audit(rv ? 'Modificó revisión de producto' : 'Revisó producto', { ...base,
      detalle: `${nueva.decision === 'corregida' ? `corregida a ${nueva.cantidad}` : 'cantidad correcta'} · ${t.debia.toLowerCase()} ${r.esperado}, contado ${r.contadoAux}${rv ? ` (antes: ${rv.decision === 'corregida' ? 'corregida a ' + rv.cantidad : 'correcta'})` : ''} · origen: ${origen}${nueva.obs ? ' · obs: ' + nueva.obs : ''}` });
    renderSummary();
    renderResultsTable();
  }

  $('#resultsTable').addEventListener('click', (e) => {
    const b = e.target.closest('[data-review]');
    if (b) openReview(b.dataset.review);
  });
  $('#abcFilter').onchange = () => { audit('Filtró reporte', { detalle: $('#abcFilter').options[$('#abcFilter').selectedIndex].textContent }); renderResultsTable(); };
  let searchLogTimer, lastLogged = '';
  $('#reportSearch').oninput = () => {
    renderResultsTable();
    clearTimeout(searchLogTimer);
    const v = $('#reportSearch').value.trim();
    if (v.length >= 3 && v !== lastLogged) searchLogTimer = setTimeout(() => { lastLogged = v; audit('Buscó producto en el reporte', { detalle: v }); }, 1200);
  };

  // ---------- Revisión aleatoria ----------
  $('#btnRandom').onclick = async () => {
    const rows = computeResults(current).filter((r) => !r.review && !r.muestra && current.items.some((i) => i.id === r.id));
    const withPrice = rows.some((r) => r.precio > 0);
    const keyOf = (r) => (withPrice ? r.precio : r.esperado);
    const sorted = rows.slice().sort((a, b) => keyOf(b) - keyOf(a));
    const n = sorted.length;
    const tiers = { alto: sorted.slice(0, Math.ceil(n * 0.2)), medio: sorted.slice(Math.ceil(n * 0.2), Math.ceil(n * 0.5)), bajo: sorted.slice(Math.ceil(n * 0.5)), todos: sorted };
    const label = withPrice ? { alto: 'Más caros', medio: 'Costo medio', bajo: 'Más baratos' } : { alto: 'Más unidades', medio: 'Unidades medias', bajo: 'Menos unidades' };
    const r = await ask({ title: 'Revisión aleatoria',
      html: `<p class="small muted">La app elige productos al azar para recontar, incluidos los que no tuvieron diferencia. ${withPrice ? 'Los grupos se arman por costo unitario.' : 'Sin costos cargados, los grupos se arman por cantidad en sistema.'}</p>
        <div class="choice-list">
          ${['alto', 'medio', 'bajo', 'todos'].map((k, i) => `<label class="choice"><input type="radio" name="estrato" value="${k}" ${i === 0 ? 'checked' : ''}>
            <span><b>${k === 'todos' ? 'Cualquiera' : label[k]}</b><small>${k === 'alto' ? '20 % superior' : k === 'medio' ? '30 % siguiente' : k === 'bajo' ? '50 % restante' : 'todo el documento'} · ${tiers[k].length.toLocaleString('es-CL')} productos disponibles</small></span></label>`).join('')}
        </div>
        <label>¿Cuántos productos?<input name="cantidad" type="number" min="1" max="200" value="10"></label>`,
      buttons: [{ label: 'Cancelar', value: '' }, { label: 'Elegir al azar', value: 'ok', cls: 'primary' }] });
    if (r.value !== 'ok') return;
    const pool = tiers[r.fields.estrato] || [];
    const k = Math.min(pool.length, Math.max(1, Math.round(parseNum(r.fields.cantidad) || 10)));
    if (!k) return info('Sin productos', 'No quedan productos disponibles en ese grupo.');
    // Selección al azar sin repetir (Fisher-Yates con números aleatorios del navegador).
    const arr = pool.slice();
    const rnd = new Uint32Array(arr.length);
    crypto.getRandomValues(rnd);
    for (let i = arr.length - 1; i > 0; i--) { const j = rnd[i] % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    const pick = arr.slice(0, k);
    current.samples = current.samples || [];
    const estrato = r.fields.estrato === 'todos' ? 'cualquiera' : label[r.fields.estrato].toLowerCase();
    current.samples.push({ id: uid(), ts: Date.now(), por: me.nombre, porId: me.id, estrato, ids: pick.map((x) => x.id) });
    save();
    audit('Creó revisión aleatoria', { detalle: `${k} productos · grupo: ${estrato} · ${pick.slice(0, 15).map((x) => x.sku || x.producto).join(', ')}${k > 15 ? '…' : ''}` });
    $('#abcFilter').value = 'muestra';
    $('#reportSearch').value = '';
    renderSummary();
    renderResultsTable();
  };

  $('#btnApprove').onclick = async () => {
    const rows = computeResults(current);
    classifyABC(rows);
    const pend = rows.filter((r) => mustReview(r) && !r.review);
    if (pend.length) {
      const r = await ask({ title: 'Aún no se puede aprobar',
        html: `<p>Faltan <b>${pend.length.toLocaleString('es-CL')}</b> productos por revisar (${pend.filter((x) => x.abc === 'A').length} de clase A${pend.some((x) => x.muestra) ? `, ${pend.filter((x) => x.muestra).length} de la revisión aleatoria` : ''}).</p><p>Todas las desviaciones deben quedar revisadas antes de aprobar.</p>`,
        buttons: [{ label: 'Cerrar', value: '' }, { label: 'Ver pendientes', value: 'ver', cls: 'primary' }] });
      audit('Intento de aprobar con revisiones pendientes', { resultado: 'denegado', detalle: `${pend.length} pendientes` });
      if (r.value === 'ver') { $('#abcFilter').value = 'pend'; $('#reportSearch').value = ''; renderResultsTable(); }
      return;
    }
    const r = await ask({ title: `Aprobar ${T(current).doc}`,
      html: `<p>Todas las desviaciones están revisadas.</p><p>Al aprobar, el reporte queda cerrado con las cantidades finales y a nombre de <b>${esc(me.nombre)}</b>.</p>`,
      buttons: [{ label: 'Cancelar', value: '' }, { label: 'Aprobar', value: 'ok', cls: 'primary' }] });
    if (r.value !== 'ok') return;
    current.verifiedAt = Date.now();
    current.verifiedBy = me.nombre;
    save();
    audit(`Aprobó ${T(current).doc}`, { detalle: `${rows.filter((x) => x.review).length} productos revisados` });
    renderSummary();
    renderResultsTable();
  };
  $('#btnDocLog').onclick = () => renderLog({ docId: current.id });

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
    if (r) openEvidence(r.id, r.producto + (r.lote ? ' · ' + r.lote : ''), () => renderResultsTable());
  });

  $('#btnBackToCount').onclick = () => startCount();
  $('#btnPrint').onclick = () => { audit('Imprimió reporte'); window.print(); };

  // Evita que Excel ejecute fórmulas escondidas en textos (=, +, -, @ al inicio).
  const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v);
  const safeRow = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, safeCell(v)]));
  function exportRows() {
    const inv = current.tipo === 'inventario';
    const t = T(current);
    const rows = computeResults(current);
    const { byValue } = classifyABC(rows);
    const rank = { A: 0, B: 1, C: 2, '': 3 };
    const key = (r) => (byValue ? Math.abs(r.valor) : Math.abs(r.dif));
    return rows.sort((a, b) => rank[a.abc] - rank[b.abc] || key(b) - key(a)).map((r) => {
      const ev = evOf(current, r.id);
      const base = inv
        ? { 'Clase ABC': r.abc, 'Material': r.sku, 'Código de barras': r.codigo, 'Producto': r.producto, 'Categoría': r.categoria }
        : { 'Clase ABC': r.abc, 'Código': r.codigo, 'Producto': r.producto, 'Lote': r.lote };
      const rv = r.review;
      return safeRow(Object.assign(base, { [t.debia]: r.esperado, 'Contado auxiliar': r.contadoAux, 'Recuento QF': r.recuento ?? '', 'Cantidad final': r.contado,
        'Diferencia': r.dif, 'Costo unitario': r.precio || '', 'Valor diferencia': r.precio ? r.valor : '', 'Estado': r.estado,
        'Revisión QF': rv ? (rv.decision === 'corregida' ? 'Corregida' : 'Cantidad correcta') : (mustReview(r) ? 'Pendiente' : ''),
        'Observación QF': rv?.obs || '', 'Revisado por': rv?.por || '', 'Fecha revisión': rv?.ts ? fmtDate(rv.ts) : '', 'Tiempo de revisión (s)': rv?.seg ?? '',
        'Revisión aleatoria': r.muestra ? 'Sí' : '',
        'Motivo (conteo)': ev?.motivo || '', 'Nota (conteo)': ev?.nota || '', 'Fotos': ev?.fotos.length || 0 }));
    });
  }
  $('#btnExportXlsx').onclick = () => {
    const ws = XLSX.utils.json_to_sheet(exportRows());
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Diferencias');
    const info = [[T(current).Doc, safeCell(current.nombre)], ['Sucursal', current.sucursal || ''], ...(current.fechaSistema ? [['Existencias al', current.fechaSistema]] : []), ['Contado por', current.contadoPor || ''],
      ['Inicio conteo', current.startedAt ? fmtDate(current.startedAt) : ''], ['Cierre', current.finishedAt ? fmtDate(current.finishedAt) : ''],
      ['Veces reabierto', current.reopened || 0], ['Aprobado por', current.verifiedBy || ''], ['Aprobado el', current.verifiedAt ? fmtDate(current.verifiedAt) : '']];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(info), 'Resumen');
    XLSX.writeFile(wb, safeName(current.nombre) + '-diferencias.xlsx');
    audit('Exportó reporte a Excel', { detalle: `${exportRows().length} filas` });
  };
  $('#btnExportCsv').onclick = () => {
    const rows = exportRows();
    const head = Object.keys(rows[0] || {});
    const cell = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = '﻿' + [head.join(';'), ...rows.map((r) => head.map((h) => cell(r[h])).join(';'))].join('\r\n');
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), safeName(current.nombre) + '-diferencias.csv');
    audit('Exportó reporte a CSV', { detalle: `${rows.length} filas` });
  };
  $('#btnShareResults').onclick = async () => {
    const all = computeResults(current);
    const { byValue } = classifyABC(all);
    const rows = all.filter((r) => r.dif !== 0 || evOf(current, r.id))
      .sort((a, b) => ({ A: 0, B: 1, C: 2, '': 3 }[a.abc] - { A: 0, B: 1, C: 2, '': 3 }[b.abc]) || (byValue ? Math.abs(b.valor) - Math.abs(a.valor) : Math.abs(b.dif) - Math.abs(a.dif)));
    const lines = rows.map((r) => {
      const ev = evOf(current, r.id);
      const dif = r.dif === 0 ? 'correcto' : r.dif > 0 ? 'sobran ' + r.dif : 'faltan ' + -r.dif;
      return `• ${r.abc ? '[' + r.abc + '] ' : ''}${r.producto}${r.sku ? ' [' + r.sku + ']' : ''}${r.lote ? ' (L ' + r.lote + ')' : ''}: ${T(current).llego.toLowerCase()} ${r.contado} und | ${T(current).debia.toLowerCase()} ${r.esperado} und → ${dif}` +
        `${r.estado === 'Lote distinto' ? ' [lote distinto]' : ''}${ev && ev.motivo ? ' — ' + ev.motivo : ''}${ev && ev.nota ? ': ' + ev.nota : ''}`;
    });
    const nFotos = rows.reduce((s, r) => s + (evOf(current, r.id)?.fotos.length || 0), 0);
    audit('Compartió reporte', { detalle: `${lines.length} líneas · ${nFotos} fotos` });
    const text = `${current.tipo === 'inventario' ? 'Inventario' : 'Revisión'} ${current.nombre}${current.sucursal ? ' - ' + current.sucursal : ''}\n` +
      (current.contadoPor ? `Contó: ${current.contadoPor}\n` : '') +
      (current.verifiedBy ? `Aprobado por: ${current.verifiedBy}\n` : '') +
      (lines.length ? `Desviaciones (${lines.length}, orden ABC):\n${lines.slice(0, 80).join('\n')}${lines.length > 80 ? `\n… y ${lines.length - 80} más (ver Excel)` : ''}` : 'Todo correcto, sin diferencias.');
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


  // =========================================================
  // USUARIOS Y SESIÓN
  // Las contraseñas se guardan cifradas (PBKDF2) en este equipo; nunca en texto.
  // =========================================================
  const USERS_KEY = 'revision-usuarios-v1';
  const SESSION_KEY = 'revision-sesion-v1';
  let users = loadJSON(USERS_KEY, []);
  users.forEach((u) => { if (u.rol === 'sucursal') u.rol = 'auxiliar'; });
  function loadJSON(key, def) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? def; } catch (e) { return def; }
  }
  function saveUsers() { localStorage.setItem(USERS_KEY, JSON.stringify(users)); }
  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const randHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
  // Contraseñas: mínimo 6 caracteres y no de las más comunes.
  const COMMON = ['123456', '1234567', '12345678', '123456789', '111111', '000000', 'password', 'contraseña', 'contrasena', 'qwerty', 'abc123', 'admin', 'admin123', 'farmacia', 'sucursal'];
  function passProblem(p, usuario = '') {
    if (p.length < 6) return 'La contraseña debe tener al menos 6 caracteres.';
    if (COMMON.includes(p.toLowerCase()) || (usuario && p.toLowerCase().includes(usuario.toLowerCase()))) return 'Esa contraseña es muy fácil de adivinar. Usa otra.';
    return '';
  }
  // Bloqueo temporal tras 5 intentos fallidos (por usuario, en este equipo).
  const LOCK_KEY = 'revision-intentos-v1';
  const lockInfo = (u) => loadJSON(LOCK_KEY, {})[u] || { n: 0, hasta: 0 };
  function setLock(u, v) { const all = loadJSON(LOCK_KEY, {}); if (v) all[u] = v; else delete all[u]; try { localStorage.setItem(LOCK_KEY, JSON.stringify(all)); } catch (e) { /* sin almacenamiento */ } }
  async function hashPass(pass, salt) {
    if (!crypto.subtle) throw new Error('Este navegador no permite guardar contraseñas de forma segura (abre la app con https).');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 120000, hash: 'SHA-256' }, key, 256);
    return toB64(bits);
  }
  async function makeUser({ nombre, usuario, pass, rol = 'auxiliar', sucursal = '' }) {
    const salt = randHex(16);
    return { id: uid(), nombre: nombre.trim(), usuario: usuario.trim().toLowerCase(), rol, sucursal: sucursal.trim(), salt, hash: await hashPass(pass, salt), creado: Date.now() };
  }
  const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const rolName = (r) => ({ admin: 'Administrador', qf: 'QF', auxiliar: 'Auxiliar', sucursal: 'Auxiliar' }[r] || r);

  function setSession(u) {
    me = u;
    try { if (u) localStorage.setItem(SESSION_KEY, u.id); else localStorage.removeItem(SESSION_KEY); } catch (e) { /* sin almacenamiento */ }
    document.body.classList.remove('role-admin', 'role-qf', 'role-auxiliar');
    if (u) document.body.classList.add('role-' + role());
    const b = $('#btnUser');
    b.hidden = !u;
    if (u) b.innerHTML = `<span class="avatar">${esc(initials(u.nombre))}</span><span class="uname">${esc(u.nombre)}</span>`;
  }

  function showLogin() {
    setSession(null);
    current = null;
    const setup = !users.length;
    show('login');
    $('#loginTitle').textContent = setup ? 'Configurar la app' : 'Iniciar sesión';
    $('#loginSub').textContent = setup ? 'Crea el usuario administrador. Con él podrás crear los usuarios de cada sucursal.' : 'Ingresa con tu usuario y contraseña.';
    $('#setupFields').hidden = !setup;
    $('#setupFields2').hidden = !setup;
    $('#setupImport').hidden = !setup;
    $('#btnLoginText').textContent = setup ? 'Crear administrador y entrar' : 'Entrar';
    $('#loginPass').autocomplete = setup ? 'new-password' : 'current-password';
    $('#loginError').hidden = true;
    $('#loginForm').reset();
    $('#loginDemo').hidden = !window.REVISION_DEMO;
    $('#loginDemo').innerHTML = 'Demo: administrador <b>admin</b> / <b>admin123</b> · QF <b>qf</b> / <b>qf123</b> · auxiliar <b>renca</b> / <b>1234</b>';
    setTimeout(() => (setup ? $('#setupNombre') : $('#loginUser')).focus(), 50);
  }
  function loginError(msg) { const e = $('#loginError'); e.textContent = msg; e.hidden = false; }

  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const usuario = $('#loginUser').value.trim().toLowerCase();
    const pass = $('#loginPass').value;
    const btn = $('#btnLogin');
    btn.disabled = true;
    try {
      if (!users.length) {
        const nombre = $('#setupNombre').value.trim();
        if (!nombre || !usuario) return loginError('Completa el nombre y el usuario.');
        const pp = passProblem(pass, usuario);
        if (pp) return loginError(pp);
        if (pass !== $('#setupPass2').value) return loginError('Las contraseñas no coinciden.');
        const u = await makeUser({ nombre, usuario, pass, rol: 'admin' });
        users.push(u);
        saveUsers();
        setSession(u);
        audit('Configuró la app y creó el administrador', { detalle: u.usuario });
        return afterLogin(u);
      }
      const lk = lockInfo(usuario);
      if (lk.hasta > Date.now()) {
        audit('Inicio de sesión bloqueado', { usuario, resultado: 'denegado', detalle: 'demasiados intentos fallidos' });
        return loginError(`Demasiados intentos fallidos. Espera ${Math.ceil((lk.hasta - Date.now()) / 60000)} min y vuelve a intentar.`);
      }
      const u = users.find((x) => x.usuario === usuario);
      if (!u || (await hashPass(pass, u.salt)) !== u.hash) {
        const n = lk.n + 1;
        setLock(usuario, { n, hasta: n >= 5 ? Date.now() + 5 * 60000 : 0 });
        audit('Inicio de sesión fallido', { usuario, resultado: 'denegado', detalle: `intento ${n}${n >= 5 ? ' · bloqueado 5 min' : ''}` });
        return loginError(n >= 5 ? 'Demasiados intentos fallidos. Espera 5 min y vuelve a intentar.' : 'Usuario o contraseña incorrectos.');
      }
      setLock(usuario, null);
      afterLogin(u);
    } catch (err) { loginError(err.message); }
    finally { btn.disabled = false; }
  };

  // Cierre de sesión por inactividad (30 min), útil en tablets compartidas.
  const IDLE_MS = 30 * 60000;
  let lastActivity = Date.now();
  ['pointerdown', 'keydown', 'scroll'].forEach((ev) => document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true, capture: true }));
  setInterval(() => {
    if (me && Date.now() - lastActivity > IDLE_MS) {
      closeViewTimer();
      audit('Sesión cerrada por inactividad');
      if ($('#dlg').open) $('#dlg').close('');
      showLogin();
      loginError('Tu sesión se cerró por inactividad. Vuelve a entrar.');
    }
  }, 30000);

  function afterLogin(u, restored = false) {
    lastActivity = Date.now();
    setSession(u);
    audit(restored ? 'Retomó sesión abierta' : 'Inicio de sesión');
    if (!checkHash()) renderHome();
  }

  // ---------- Menú de usuario ----------
  $('#btnUser').onclick = async () => {
    if (!me) return;
    const opts = [
      ...(isAdmin() ? [['users', 'users', 'Usuarios'], ['catalog', 'list', 'Maestro de productos']] : []),
      ...(isStaff() ? [['log', 'history', 'Bitácora']] : []),
      ...(isAdmin() ? [['export', 'download', 'Exportar configuración'], ['import', 'upload', 'Importar configuración']] : []),
      ['pass', 'lock', 'Cambiar mi contraseña'], ['logout', 'logout', 'Cerrar sesión'],
    ];
    const r = await ask({ title: 'Mi cuenta',
      html: `<div class="menu-who"><span class="avatar">${esc(initials(me.nombre))}</span><div><b>${esc(me.nombre)}</b><div class="small muted">${esc(me.usuario)} · ${rolName(me.rol)}${me.sucursal ? ' · ' + esc(me.sucursal) : ''}</div></div></div>
        <div class="menu-list">${opts.map(([v, i, l]) => `<button class="btn" value="${v}">${ic(i)} ${l}</button>`).join('')}</div>`,
      buttons: [{ label: 'Cerrar', value: '' }] });
    if (r.value === 'logout') { closeViewTimer(); audit('Cierre de sesión'); showLogin(); }
    else if (r.value === 'users') renderUsers();
    else if (r.value === 'log') renderLog();
    else if (r.value === 'catalog') renderCatalog();
    else if (r.value === 'export') exportConfig();
    else if (r.value === 'import') pickFile('.json', (f) => importConfig(f));
    else if (r.value === 'pass') changePassword(me);
  };

  function pickFile(accept, cb) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept;
    inp.onchange = () => { if (inp.files[0]) cb(inp.files[0]); };
    inp.click();
  }

  async function changePassword(u, byAdmin = false) {
    const r = await ask({ title: byAdmin ? `Nueva contraseña para ${u.nombre}` : 'Cambiar mi contraseña',
      html: `${byAdmin ? '' : '<label>Contraseña actual<input name="actual" type="password" autocomplete="current-password"></label>'}
        <label>Nueva contraseña<input name="nueva" type="password" autocomplete="new-password"></label>
        <label>Repite la nueva contraseña<input name="nueva2" type="password" autocomplete="new-password"></label>`,
      buttons: [{ label: 'Cancelar', value: '' }, { label: 'Guardar', value: 'ok', cls: 'primary' }] });
    if (r.value !== 'ok') return;
    const f = r.fields;
    if (!byAdmin && (await hashPass(f.actual, u.salt)) !== u.hash) return info('No se cambió', 'La contraseña actual no es correcta.');
    const pp = passProblem(f.nueva, u.usuario);
    if (pp) return info('No se cambió', pp);
    if (f.nueva !== f.nueva2) return info('No se cambió', 'Las contraseñas no coinciden.');
    u.salt = randHex(16);
    u.hash = await hashPass(f.nueva, u.salt);
    saveUsers();
    audit(byAdmin ? 'Cambió la contraseña de otro usuario' : 'Cambió su contraseña', { detalle: byAdmin ? u.usuario : null });
    info('Contraseña actualizada', byAdmin ? `${esc(u.nombre)} ya puede entrar con la nueva contraseña.` : 'Usa la nueva contraseña la próxima vez que entres.');
  }
  const info = (title, html) => ask({ title, html: `<p>${html}</p>`, buttons: [{ label: 'Aceptar', value: 'ok', cls: 'primary' }] });

  // ---------- Administración de usuarios ----------
  function renderUsers() {
    if (!isAdmin()) return renderHome();
    show('users', 'Usuarios');
    $('#usersList').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Sucursal</th><th></th></tr></thead>
      <tbody>${users.map((u) => `<tr data-uid="${u.id}">
        <td><b>${esc(u.nombre)}</b>${u.id === me.id ? ' <span class="pill">tú</span>' : ''}</td>
        <td class="mono">${esc(u.usuario)}</td>
        <td><span class="pill ${u.rol === 'admin' ? 'type' : ''}">${rolName(u.rol)}</span></td>
        <td>${esc(u.sucursal || '—')}</td>
        <td><div class="row-actions">
          <button class="btn sm ghost" data-uact="edit">${ic('edit')} Editar</button>
          <button class="btn sm ghost" data-uact="pass">${ic('lock')} Contraseña</button>
          ${u.id !== me.id ? `<button class="btn sm ghost danger" data-uact="del">${ic('trash')}</button>` : ''}
        </div></td></tr>`).join('')}</tbody></table></div>`;
  }
  $('#btnNewUser').onclick = () => editUser(null);
  $('#usersList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-uact]');
    if (!b) return;
    const u = users.find((x) => x.id === b.closest('tr').dataset.uid);
    if (!u) return;
    if (b.dataset.uact === 'edit') editUser(u);
    else if (b.dataset.uact === 'pass') changePassword(u, true);
    else if (b.dataset.uact === 'del') deleteUser(u);
  });
  async function editUser(u) {
    const r = await ask({ title: u ? 'Editar usuario' : 'Nuevo usuario',
      html: `<label>Nombre completo<input name="nombre" value="${esc(u ? u.nombre : '')}"></label>
        <label>Usuario (para entrar)<input name="usuario" value="${esc(u ? u.usuario : '')}" autocapitalize="none" spellcheck="false"></label>
        <label>Rol<select name="rol">
          <option value="auxiliar" ${!u || u.rol === 'auxiliar' ? 'selected' : ''}>Auxiliar: solo digita cantidades</option>
          <option value="qf" ${u && u.rol === 'qf' ? 'selected' : ''}>QF: revisa y verifica las desviaciones</option>
          <option value="admin" ${u && u.rol === 'admin' ? 'selected' : ''}>Administrador: todo</option></select></label>
        <label>Sucursal (opcional)<input name="sucursal" value="${esc(u ? u.sucursal : '')}" placeholder="Ej: CL0007 RENCA"></label>
        ${u ? '' : '<label>Contraseña inicial<input name="pass" type="password" autocomplete="new-password"></label>'}`,
      buttons: [{ label: 'Cancelar', value: '' }, { label: 'Guardar', value: 'ok', cls: 'primary' }] });
    if (r.value !== 'ok') return;
    const f = r.fields;
    const usuario = f.usuario.trim().toLowerCase();
    if (!f.nombre.trim() || !usuario) return info('No se guardó', 'Completa el nombre y el usuario.');
    if (!/^[a-z0-9._\-@]+$/.test(usuario)) return info('No se guardó', 'El usuario solo puede tener letras sin tilde, números, punto, guion o @.');
    if (users.some((x) => x.usuario === usuario && x !== u)) return info('No se guardó', `Ya existe el usuario <b>${esc(usuario)}</b>.`);
    if (u) {
      if (u.id === me.id && f.rol !== 'admin') return info('No se guardó', 'No puedes quitarte el rol de administrador a ti mismo.');
      const antes = `${u.usuario} · ${rolName(u.rol)}`;
      Object.assign(u, { nombre: f.nombre.trim(), usuario, rol: f.rol, sucursal: f.sucursal.trim() });
      audit('Editó usuario', { detalle: `${antes} → ${u.usuario} · ${rolName(u.rol)}${u.sucursal ? ' · ' + u.sucursal : ''}` });
      if (u.id === me.id) setSession(u);
    } else {
      const pp = passProblem(f.pass || '', usuario);
      if (pp) return info('No se guardó', pp);
      users.push(await makeUser({ nombre: f.nombre, usuario, pass: f.pass, rol: f.rol, sucursal: f.sucursal }));
      audit('Creó usuario', { detalle: `${usuario} · ${rolName(f.rol)}${f.sucursal.trim() ? ' · ' + f.sucursal.trim() : ''}` });
    }
    saveUsers();
    renderUsers();
  }
  async function deleteUser(u) {
    if (u.rol === 'admin' && users.filter((x) => x.rol === 'admin').length < 2) return info('No se eliminó', 'Debe quedar al menos un administrador.');
    const r = await ask({ title: `¿Eliminar a ${u.nombre}?`, html: '<p>Ya no podrá entrar en este equipo. Sus conteos se mantienen.</p>',
      buttons: [{ label: 'Cancelar', value: '' }, { label: 'Eliminar', value: 'del', cls: 'danger' }] });
    if (r.value !== 'del') return;
    users = users.filter((x) => x !== u);
    audit('Eliminó usuario', { detalle: `${u.usuario} · ${rolName(u.rol)}` });
    saveUsers();
    renderUsers();
  }

  // ---------- Exportar / importar configuración (usuarios + maestro) ----------
  function exportConfig() {
    const data = { tipo: 'revision-config', v: 1, exportado: Date.now(), usuarios: users, catalogo: catalog };
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'configuracion-revision.json');
    audit('Exportó configuración', { detalle: `${users.length} usuarios · ${(catalog.items || []).length} productos` });
  }
  async function importConfig(file) {
    let d;
    try { d = JSON.parse(await file.text()); } catch (e) { d = null; }
    if (!d || d.tipo !== 'revision-config' || !Array.isArray(d.usuarios)) return info('No se pudo importar', 'El archivo no es una configuración de esta app.');
    for (const u of d.usuarios) {
      if (!u || !u.usuario || !u.hash || !u.salt) continue;
      const i = users.findIndex((x) => x.usuario === u.usuario);
      if (i >= 0) users[i] = u; else users.push(u);
    }
    saveUsers();
    if (d.catalogo && Array.isArray(d.catalogo.items) && d.catalogo.items.length) setCatalog(d.catalogo);
    await info('Configuración importada', `${d.usuarios.length} usuarios${d.catalogo && d.catalogo.items ? ' y ' + d.catalogo.items.length + ' productos del maestro' : ''}. ${me ? '' : 'Ahora inicia sesión.'}`);
    audit('Importó configuración', { detalle: `${d.usuarios.length} usuarios` });
    if (me) renderHome(); else showLogin();
  }
  $('#fileConfigSetup').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importConfig(f); };

  // =========================================================
  // MAESTRO DE PRODUCTOS
  // Relaciona código de material con código de barras (EAN).
  // =========================================================
  const CATALOG_KEY = 'revision-catalogo-v1';
  let catalog = loadJSON(CATALOG_KEY, { items: [] });
  let catIdx = null;
  function setCatalog(c) {
    catalog = c;
    catIdx = null;
    try { localStorage.setItem(CATALOG_KEY, JSON.stringify(c)); }
    catch (e) { info('No se pudo guardar el maestro', 'No hay espacio suficiente en este equipo.'); }
  }
  function catalogIndex() {
    if (!catIdx) {
      catIdx = { ean: new Map(), sku: new Map() };
      for (const p of catalog.items || []) {
        if (p.ean) catIdx.ean.set(normCode(p.ean), p);
        if (p.sku) catIdx.sku.set(normCode(p.sku), p);
      }
    }
    return catIdx;
  }
  // Busca por código de barras o por código de material.
  const catalogFind = (code) => { const x = catalogIndex(); return x.ean.get(code) || x.sku.get(code) || null; };

  const CAT_RULES = [
    ['ean', /ean|upc|barra|gtin/],
    ['sku', /^material$|^sku|cod.*material|material.*cod|^codigo$|^cod\.?$|^articulo$/],
    ['nombre', /texto|descrip|nombre|producto/],
    ['unidad', /unidad|^um$|medida/],
    ['precio', /precio|costo|valor|^pmp$|^cpp$/],
    ['grupo', /nivel|grupo|categ|familia|linea/],
  ];
  function parseCatalogRows(rows) {
    let hIdx = -1, map = null;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const m = {};
      rows[i].forEach((h, k) => {
        const n = normText(h);
        for (const [key, re] of CAT_RULES) if (m[key] === undefined && n && re.test(n)) { m[key] = k; break; }
      });
      if (m.nombre !== undefined && (m.sku !== undefined || m.ean !== undefined)) { hIdx = i; map = m; break; }
    }
    if (!map) throw new Error('No encontré las columnas del maestro. Debe tener al menos Material (o código de barras) y el nombre del producto.');
    const items = [];
    for (const r of rows.slice(hIdx + 1)) {
      const nombre = String(r[map.nombre] ?? '').trim();
      if (!nombre) continue;
      const ean = map.ean !== undefined ? String(r[map.ean] ?? '').replace(/\.0+$/, '').trim() : '';
      items.push({ sku: map.sku !== undefined ? String(r[map.sku] ?? '').trim() : '', nombre, ean: /^\d{6,14}$/.test(ean) ? ean : '',
        unidad: map.unidad !== undefined ? String(r[map.unidad] ?? '').trim() : '', grupo: map.grupo !== undefined ? String(r[map.grupo] ?? '').trim() : '',
        precio: map.precio !== undefined ? parseNum(r[map.precio]) : 0 });
    }
    return items;
  }

  function renderCatalog() {
    if (!isAdmin()) return renderHome();
    show('catalog', 'Maestro de productos');
    const items = catalog.items || [];
    $('#catalogStats').innerHTML = `
      <div class="kpi"><div class="l">Productos</div><div class="v">${items.length.toLocaleString('es')}</div><div class="s">en el maestro</div></div>
      <div class="kpi ok"><div class="l">Con código de barras</div><div class="v">${items.filter((p) => p.ean).length.toLocaleString('es')}</div><div class="s">se pueden escanear</div></div>
      <div class="kpi ${items.length && items.some((p) => !p.ean) ? 'warn' : ''}"><div class="l">Sin código de barras</div><div class="v">${items.filter((p) => !p.ean).length.toLocaleString('es')}</div><div class="s">se buscan por nombre</div></div>
      <div class="kpi ${items.some((p) => p.precio) ? 'ok' : 'warn'}"><div class="l">Con costo</div><div class="v">${items.filter((p) => p.precio).length.toLocaleString('es')}</div><div class="s">para el orden ABC por valor</div></div>
      <div class="kpi"><div class="l">Actualizado</div><div class="v" style="font-size:18px">${catalog.actualizado ? fmtDate(catalog.actualizado) : '—'}</div><div class="s">${esc(catalog.archivo || 'sin cargar')}</div></div>`;
    renderCatalogList();
  }
  function renderCatalogList() {
    const items = catalog.items || [];
    if (!items.length) { $('#catalogList').innerHTML = '<div class="empty">Aún no hay maestro. Sube el Excel con los productos (Material, Texto breve de material, Código EAN/UPC).</div>'; return; }
    const q = normText($('#catalogSearch').value);
    const found = q ? items.filter((p) => normText(`${p.nombre} ${p.sku} ${p.ean}`).includes(q)) : items;
    $('#catalogList').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Material</th><th>Producto</th><th>Código de barras</th><th>Unidad</th><th class="num">Costo</th></tr></thead>
      <tbody>${found.slice(0, 150).map((p) => `<tr><td class="mono">${esc(p.sku)}</td><td>${esc(p.nombre)}</td><td class="mono">${esc(p.ean) || '<span class="muted">—</span>'}</td><td>${esc(p.unidad)}</td><td class="num">${p.precio ? '$ ' + fmtMoney(p.precio) : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>
      <p class="small muted" style="padding:10px 14px;margin:0">${found.length > 150 ? `Mostrando 150 de ${found.length.toLocaleString('es')}. Usa el buscador para encontrar otros.` : `${found.length} productos`}</p>`;
  }
  $('#catalogSearch').oninput = () => renderCatalogList();
  $('#fileCatalog').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const st = $('#catalogStatus');
    try {
      const rows = await readSheetRows(f);
      const items = parseCatalogRows(rows);
      if (!items.length) throw new Error('El archivo no tiene productos.');
      setCatalog({ items, actualizado: Date.now(), archivo: f.name });
      audit('Cargó maestro de productos', { docId: null, doc: null, detalle: `${items.length} productos · ${f.name}` });
      renderCatalog();
      st.className = 'load-status ok'; st.hidden = false;
      st.innerHTML = `${ic('check')}<span>Maestro cargado: ${items.length.toLocaleString('es')} productos de ${esc(f.name)}.</span>`;
    } catch (err) {
      st.className = 'load-status err'; st.hidden = false;
      st.innerHTML = `${ic('alert')}<span>${esc(err.message)}</span>`;
    }
  };
  // Lista de precios/costos: Material (o código de barras) + Precio/Costo. Se agrega al maestro.
  $('#filePrices').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const st = $('#catalogStatus');
    try {
      const rows = await readSheetRows(f);
      let hIdx = -1, cCode = -1, cEan = -1, cPrice = -1, cName = -1;
      for (let i = 0; i < Math.min(rows.length, 15) && hIdx < 0; i++) {
        rows[i].forEach((h, k) => {
          const n = normText(h);
          if (cPrice < 0 && /precio|costo|valor|^pmp$|^cpp$/.test(n)) cPrice = k;
          else if (cEan < 0 && /ean|upc|barra|gtin/.test(n)) cEan = k;
          else if (cCode < 0 && /material|cod|sku|articulo/.test(n)) cCode = k;
          else if (cName < 0 && /texto|descrip|nombre|producto/.test(n)) cName = k;
        });
        if (cPrice >= 0 && (cCode >= 0 || cEan >= 0)) hIdx = i; else { cCode = cEan = cPrice = cName = -1; }
      }
      if (hIdx < 0) throw new Error('No encontré las columnas. La lista debe tener Material (o código de barras) y Precio o Costo.');
      const items = (catalog.items || []).slice();
      const bySku = new Map(items.map((p) => [normCode(p.sku), p]));
      const byEan = new Map(items.filter((p) => p.ean).map((p) => [normCode(p.ean), p]));
      let upd = 0, added = 0;
      for (const r of rows.slice(hIdx + 1)) {
        const precio = parseNum(r[cPrice]);
        if (!precio) continue;
        const sku = cCode >= 0 ? String(r[cCode] ?? '').trim() : '';
        const ean = cEan >= 0 ? String(r[cEan] ?? '').trim() : '';
        let p = (sku && bySku.get(normCode(sku))) || (ean && byEan.get(normCode(ean)));
        if (p) { p.precio = precio; upd++; }
        else if (sku || ean) { p = { sku, ean, nombre: cName >= 0 ? String(r[cName] ?? '').trim() : '', unidad: '', grupo: '', precio }; items.push(p); added++; }
      }
      if (!upd && !added) throw new Error('No encontré precios válidos en el archivo.');
      setCatalog({ ...catalog, items, actualizado: Date.now(), precios: f.name });
      audit('Cargó costos', { docId: null, doc: null, detalle: `${upd} actualizados · ${added} agregados · ${f.name}` });
      renderCatalog();
      st.className = 'load-status ok'; st.hidden = false;
      st.innerHTML = `${ic('check')}<span>Costos cargados: ${upd.toLocaleString('es')} productos actualizados${added ? `, ${added} agregados` : ''}.</span>`;
    } catch (err) {
      st.className = 'load-status err'; st.hidden = false;
      st.innerHTML = `${ic('alert')}<span>${esc(err.message)}</span>`;
    }
  };

  async function readSheetRows(f) {
    if (tooBig(f)) throw new Error(`El archivo pesa más de ${MAX_MB} MB. Revisa que sea el correcto.`);
    if (/\.(csv|txt)$/i.test(f.name)) return parseDelimited(await f.text());
    const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  }

  // =========================================================
  // NUEVO INVENTARIO (desde el reporte de existencias)
  // =========================================================
  let invDraft = null;
  $('#btnNewInventory').onclick = () => {
    invDraft = null;
    show('inv', 'Nuevo inventario');
    $('#invStatus').hidden = true;
    $('#invPreview').innerHTML = (catalog.items || []).length ? ''
      : `<div class="load-status warn">${ic('alert')}<span>Aún no cargas el <b>maestro de productos</b>. Sin él no se puede escanear por código de barras; solo buscar por nombre o código. Cárgalo desde el menú de usuario → Maestro de productos.</span></div>`;
    $('#invFoot').hidden = true;
  };
  const INV_RULES = [
    ['categoria', /categ|familia|grupo|linea|nivel/],
    ['cantidad', /cant|existenc|stock|saldo|unidades|^qty/],
    ['ean', /ean|upc|barra|gtin/],
    ['sku', /cod|material|sku|articulo/],
    ['producto', /nombre|descrip|producto|texto/],
  ];
  function parseInventoryRows(rows) {
    let hIdx = -1, map = null;
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const m = {};
      rows[i].forEach((h, k) => {
        const n = normText(h);
        for (const [key, re] of INV_RULES) if (m[key] === undefined && n && re.test(n)) { m[key] = k; break; }
      });
      if (m.producto !== undefined && m.cantidad !== undefined) { hIdx = i; map = m; break; }
    }
    if (!map) throw new Error('No encontré las columnas Código, Nombre y Cantidad en el archivo.');
    const items = [];
    for (const r of rows.slice(hIdx + 1)) {
      const producto = String(r[map.producto] ?? '').trim();
      if (!producto) continue;
      items.push({ sku: map.sku !== undefined ? String(r[map.sku] ?? '').trim() : '', ean: map.ean !== undefined ? String(r[map.ean] ?? '').trim() : '',
        producto, cantidad: parseNum(r[map.cantidad]), categoria: map.categoria !== undefined ? String(r[map.categoria] ?? '').trim() : '' });
    }
    return { sucursal: '', fecha: '', items };
  }
  $('#fileInventory').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const st = $('#invStatus');
    st.className = 'load-status busy'; st.hidden = false;
    st.innerHTML = `<span class="spinner"></span><span>Leyendo ${esc(f.name)}…</span>`;
    try {
      if (tooBig(f)) throw new Error(`El archivo pesa más de ${MAX_MB} MB. Revisa que sea el correcto.`);
      const rep = /\.pdf$/i.test(f.name) ? Importar.parseExistencias(await Importar.fromPdf(f)) : parseInventoryRows(await readSheetRows(f));
      if (!rep.items.length) throw new Error('No encontré productos en el reporte. Revisa que sea el reporte de existencias.');
      // Completa el código de barras con el maestro.
      for (const it of rep.items) {
        let p = it.sku ? catalogIndex().sku.get(normCode(it.sku)) : null;
        if (!p && /^\d{8,14}$/.test(it.sku)) { p = catalogIndex().ean.get(normCode(it.sku)); if (p) { it.ean = it.sku; it.sku = p.sku; } }
        if (!it.ean && p) it.ean = p.ean;
      }
      invDraft = { ...rep, archivo: f.name };
      renderInvPreview();
      st.className = 'load-status ok';
      st.innerHTML = `${ic('check')}<span>${rep.items.length.toLocaleString('es')} productos leídos de ${esc(f.name)}.</span>`;
    } catch (err) {
      st.className = 'load-status err';
      st.innerHTML = `${ic('alert')}<span>${esc(err.message)}</span>`;
    }
  };
  function renderInvPreview() {
    const d = invDraft;
    const units = d.items.reduce((s, i) => s + i.cantidad, 0);
    const withEan = d.items.filter((i) => i.ean).length;
    const cats = {};
    for (const i of d.items) { const c = i.categoria || 'Sin categoría'; (cats[c] = cats[c] || { n: 0, u: 0 }); cats[c].n++; cats[c].u += i.cantidad; }
    const pctEan = d.items.length ? Math.round((withEan / d.items.length) * 100) : 0;
    $('#invPreview').innerHTML = `
      <div class="card pad">
        <h3 class="card-title">Datos del inventario</h3>
        <div class="grid2">
          <label class="field">Sucursal<input id="invSucursal" value="${esc(d.sucursal)}" placeholder="Ej: CL0007 RENCA"></label>
          <label class="field">Existencias al<input id="invFecha" value="${esc(d.fecha)}" placeholder="dd/mm/aaaa"></label>
        </div>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="l">Productos</div><div class="v">${d.items.length.toLocaleString('es')}</div><div class="s">líneas del reporte</div></div>
        <div class="kpi"><div class="l">Unidades</div><div class="v">${units.toLocaleString('es')}</div><div class="s">según el sistema</div></div>
        <div class="kpi"><div class="l">Categorías</div><div class="v">${Object.keys(cats).length}</div><div class="s">${esc(Object.keys(cats).slice(0, 2).join(', '))}${Object.keys(cats).length > 2 ? '…' : ''}</div></div>
        <div class="kpi ${pctEan < 80 ? 'warn' : 'ok'}"><div class="l">Se pueden escanear</div><div class="v">${pctEan}%</div><div class="s">${withEan.toLocaleString('es')} con código de barras</div></div>
      </div>
      ${withEan < d.items.length ? `<p class="small muted">${(d.items.length - withEan).toLocaleString('es')} productos no tienen código de barras en el maestro: se cuentan buscándolos por nombre o código.</p>` : ''}
      <div class="card"><div class="table-wrap"><table class="cat-table">
        <thead><tr><th>Categoría</th><th class="num">Productos</th><th class="num">Unidades</th></tr></thead>
        <tbody>${Object.entries(cats).map(([c, v]) => `<tr><td>${esc(c)}</td><td class="num">${v.n.toLocaleString('es')}</td><td class="num">${v.u.toLocaleString('es')}</td></tr>`).join('')}</tbody>
      </table></div></div>`;
    $('#invFoot').hidden = false;
  }
  $('#btnSaveInventory').onclick = () => {
    if (!invDraft) return;
    const sucursal = $('#invSucursal').value.trim();
    const fecha = $('#invFecha').value.trim();
    const o = newOrder({
      tipo: 'inventario',
      nombre: `Inventario ${sucursal || ''} ${fecha || new Date().toLocaleDateString('es')}`.replace(/\s+/g, ' ').trim(),
      sucursal, fechaSistema: fecha,
      items: invDraft.items.map((i) => ({ id: uid(), sku: i.sku, codigo: i.ean || '', producto: i.producto, categoria: i.categoria, cantidad: i.cantidad, lote: '', precio: 0, vencimiento: '' })),
    });
    db.orders.push(o);
    save();
    audit('Creó inventario', { docId: o.id, doc: o.nombre, sucursal: o.sucursal || null, detalle: `${o.items.length} productos · ${invDraft.archivo || ''}` });
    invDraft = null;
    openOrder(o.id);
  };

  // =========================================================
  // BITÁCORA (pantalla para administrador y QF)
  // =========================================================
  let logRows = [];
  let logLimit = 200;
  async function renderLog(filter = {}) {
    if (!isStaff()) { audit('Intento de ver la bitácora', { resultado: 'denegado' }); return renderHome(); }
    const fromDoc = filter.docId ? current : null;
    current = fromDoc;
    show('log', 'Bitácora');
    audit('Vio la bitácora', { docId: fromDoc ? fromDoc.id : null, doc: fromDoc ? fromDoc.nombre : null, detalle: fromDoc ? 'filtrada por documento' : null });
    $('#logStatus').hidden = true;
    logRows = (await Bitacora.all()).reverse();
    logLimit = 200;
    const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    const fill = (sel, label, vals, fmt = (v) => v) => {
      sel.innerHTML = `<option value="">${label}</option>` + vals.map((v) => `<option value="${esc(v)}">${esc(fmt(v))}</option>`).join('');
    };
    const names = {};
    logRows.forEach((r) => { if (r.usuario) names[r.usuario] = r.nombre ? `${r.nombre} (${r.usuario})` : r.usuario; });
    fill($('#logUser'), 'Todos los usuarios', uniq(logRows.map((r) => r.usuario)), (v) => names[v] || v);
    fill($('#logAction'), 'Todas las acciones', uniq(logRows.map((r) => r.accion)));
    const docs = {};
    logRows.forEach((r) => { if (r.docId) docs[r.docId] = r.doc || r.docId; });
    $('#logDoc').innerHTML = '<option value="">Todos los documentos</option>' + Object.entries(docs).map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('');
    $('#logUser').value = ''; $('#logAction').value = ''; $('#logDoc').value = filter.docId || '';
    $('#logFrom').value = ''; $('#logTo').value = ''; $('#logText').value = '';
    renderLogList();
  }
  // Fecha local de Santiago (aaaa-mm-dd) para comparar con los filtros de fecha.
  const dayKey = (ts) => { const p = {}; new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ts)).forEach((x) => { p[x.type] = x.value; }); return `${p.year}-${p.month}-${p.day}`; };
  function filteredLog() {
    const u = $('#logUser').value, a = $('#logAction').value, d = $('#logDoc').value;
    const from = $('#logFrom').value, to = $('#logTo').value, q = normText($('#logText').value);
    return logRows.filter((r) => (!u || r.usuario === u) && (!a || r.accion === a) && (!d || r.docId === d)
      && (!from || dayKey(r.ts) >= from) && (!to || dayKey(r.ts) <= to)
      && (!q || normText(`${r.producto || ''} ${r.sku || ''} ${r.detalle || ''} ${r.doc || ''} ${r.nombre || ''} ${r.accion}`).includes(q)));
  }
  function renderLogList() {
    const list = filteredLog();
    const people = new Set(list.map((r) => r.usuario).filter(Boolean));
    const reviews = list.filter((r) => /Revisó producto|Modificó revisión/.test(r.accion));
    const segRev = reviews.reduce((s, r) => s + (r.duracionSeg || 0), 0);
    const denied = list.filter((r) => r.resultado === 'denegado').length;
    $('#logStats').innerHTML = `
      <div class="kpi"><div class="l">Registros</div><div class="v">${list.length.toLocaleString('es-CL')}</div><div class="s">de ${logRows.length.toLocaleString('es-CL')} en total</div></div>
      <div class="kpi"><div class="l">Usuarios</div><div class="v">${people.size}</div><div class="s">con actividad en el filtro</div></div>
      <div class="kpi"><div class="l">Productos revisados</div><div class="v">${reviews.length.toLocaleString('es-CL')}</div><div class="s">${reviews.length ? 'promedio ' + fmtSecs(Math.round(segRev / reviews.length)) + ' por producto' : 'sin revisiones'}</div></div>
      <div class="kpi ${denied ? 'bad' : ''}"><div class="l">Accesos denegados</div><div class="v">${denied}</div><div class="s">intentos fallidos o sin permiso</div></div>`;
    if (!list.length) { $('#logList').innerHTML = '<div class="empty">No hay registros con estos filtros.</div>'; return; }
    const shown = list.slice(0, logLimit);
    $('#logList').innerHTML = `<div class="table-wrap"><table class="log">
      <thead><tr><th>Fecha y hora</th><th>Usuario</th><th>Acción</th><th>Documento</th><th>Producto</th><th>Detalle</th><th class="num">Tiempo</th></tr></thead>
      <tbody>${shown.map((r) => `<tr>
        <td class="when mono">${fmtDate(r.ts, true)}</td>
        <td>${esc(r.nombre || r.usuario || '—')}${r.rol ? `<div class="sub">${esc(rolName(r.rol))}</div>` : ''}</td>
        <td>${esc(r.accion)}${r.resultado && r.resultado !== 'ok' ? ` <span class="pill denegado">${esc(r.resultado)}</span>` : ''}</td>
        <td>${esc(r.doc || '')}${r.sucursal ? `<div class="sub">${esc(r.sucursal)}</div>` : ''}</td>
        <td>${esc(r.producto || '')}${r.sku ? `<div class="sub mono">${esc(r.sku)}</div>` : ''}</td>
        <td class="small">${esc(r.detalle || '')}<div class="sub">${esc(r.equipo || '')}</div></td>
        <td class="num">${r.duracionSeg != null ? fmtSecs(r.duracionSeg) : ''}</td>
      </tr>`).join('')}</tbody></table></div>
      ${list.length > shown.length ? `<div class="actions" style="justify-content:center;padding:12px"><button class="btn" id="btnLogMore">Mostrar 200 más (quedan ${(list.length - shown.length).toLocaleString('es-CL')})</button></div>` : ''}`;
    const more = $('#btnLogMore');
    if (more) more.onclick = () => { logLimit += 200; renderLogList(); };
  }
  ['logUser', 'logAction', 'logDoc', 'logFrom', 'logTo'].forEach((id) => { $('#' + id).onchange = () => { logLimit = 200; renderLogList(); }; });
  $('#logText').oninput = () => { logLimit = 200; renderLogList(); };
  $('#btnLogVerify').onclick = async () => {
    const st = $('#logStatus');
    st.className = 'load-status busy'; st.hidden = false;
    st.innerHTML = '<span class="spinner"></span><span>Verificando la cadena de registros…</span>';
    const r = await Bitacora.verify();
    audit('Verificó integridad de la bitácora', { resultado: r.ok ? 'ok' : 'error', detalle: r.ok ? `${r.total} registros íntegros` : r.motivo });
    st.className = 'load-status ' + (r.ok ? 'ok' : 'err');
    st.innerHTML = r.ok ? `${ic('check')}<span>Bitácora íntegra: ${r.total.toLocaleString('es-CL')} registros sin alteraciones.</span>`
      : `${ic('alert')}<span><b>Se detectó una alteración:</b> ${esc(r.motivo)}${r.malo ? ` (registro del ${fmtDate(r.malo.ts, true)})` : ''}.</span>`;
  };
  $('#btnLogExport').onclick = () => {
    const list = filteredLog();
    const rows = list.map((r) => ({ 'N°': r.n || r.id, 'Fecha y hora (Santiago)': fmtDate(r.ts, true), 'Usuario': r.usuario || '', 'Nombre': r.nombre || '', 'Rol': r.rol ? rolName(r.rol) : '',
      'Acción': r.accion, 'Resultado': r.resultado || '', 'Documento': r.doc || '', 'Sucursal': r.sucursal || '', 'Producto': r.producto || '', 'Código': r.sku || '',
      'Detalle': r.detalle || '', 'Tiempo (s)': r.duracionSeg ?? '', 'Equipo': r.equipo || '', 'Hash': r.hash || '' })).map(safeRow);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Bitácora');
    XLSX.writeFile(wb, `bitacora-${dayKey(Date.now())}.xlsx`);
    audit('Exportó la bitácora', { detalle: `${rows.length} registros` });
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
  if (!window.REVISION_DEMO && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin modo offline */ });
  }
  (async () => {
    // Demo: usuarios de prueba para entrar sin configurar nada.
    if (window.REVISION_DEMO) {
      const demo = [['Administrador', 'admin', 'admin123', 'admin'], ['QF Renca', 'qf', 'qf123', 'qf'], ['Auxiliar Renca', 'renca', '1234', 'auxiliar']];
      for (const [nombre, usuario, pass, rol] of demo) {
        if (!users.some((u) => u.usuario === usuario)) users.push(await makeUser({ nombre, usuario, pass, rol, sucursal: rol === 'admin' ? '' : 'CL0007 RENCA' }));
      }
      saveUsers();
    }
    if (window.REVISION_DEMO && !db.orders.length) createDemo();
    const sid = loadJSON(SESSION_KEY, null) || (() => { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } })();
    const u = users.find((x) => x.id === sid);
    if (u) afterLogin(u, true); else showLogin();
  })();

  // Exponer funciones para pruebas
  window.__app = { parseDelimited, rowsToItems, normCode, parseNum, computeResults, processCode: (c) => handleCode(c), parseCatalogRows };
})();

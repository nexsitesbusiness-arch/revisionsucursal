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
  const isAdmin = () => !!me && me.rol === 'admin';
  const views = ['login', 'home', 'load', 'order', 'count', 'results', 'users', 'catalog', 'inv'];
  function show(view, title) {
    views.forEach((v) => { $('#view-' + v).hidden = v !== view; });
    $('#title').textContent = title || '';
    if (view !== 'count') stopScanner();
    window.scrollTo(0, 0);
  }
  $('#btnHome').onclick = () => { if (me) renderHome(); };

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
    $('#homeKicker').textContent = me ? (isAdmin() ? 'Central' : 'Sucursal') + ' · ' + me.nombre : 'Inicio';
    const st = db.orders.map(orderStatus);
    const open = st.filter((x) => x.key !== 'done').length;
    const done = st.filter((x) => x.key === 'done').length;
    const withDiffs = st.filter((x) => x.diffs > 0).length;
    const nInv = db.orders.filter((o) => o.tipo === 'inventario').length;
    $('#homeStats').innerHTML = `
      <div class="kpi"><div class="l">Documentos</div><div class="v">${db.orders.length}</div><div class="s">${db.orders.length - nInv} pedidos · ${nInv} inventarios</div></div>
      <div class="kpi"><div class="l">En revisión</div><div class="v">${open}</div><div class="s">abiertos</div></div>
      <div class="kpi ok"><div class="l">Cerrados</div><div class="v">${done}</div><div class="s">conteos terminados</div></div>
      <div class="kpi ${withDiffs ? 'bad' : ''}"><div class="l">Con diferencias</div><div class="v">${withDiffs}</div><div class="s">de ${done} cerrados</div></div>`;

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

  // ---------- Modo claro / oscuro ----------
  function applyTheme(id) {
    document.documentElement.dataset.theme = id;
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = id === 'nocturno' ? '#0b0f14' : '#13233a';
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
    $('#orderTitle').textContent = current.nombre;
    $('#orderMeta').textContent = `${T(current).Doc}${current.sucursal ? ' · ' + current.sucursal : ''}${current.fechaSistema ? ' · existencias al ' + current.fechaSistema : ''} · ${current.items.length} productos`;
    $('#shareWhat').textContent = current.tipo === 'inventario' ? 'del sistema' : 'enviadas';
    const x = orderStatus(current);
    $('#orderProgress').textContent = current.finishedAt ? `Cerrado ${fmtDate(current.finishedAt)}${current.contadoPor ? ' · contó ' + current.contadoPor : ''}`
      : x.counted ? `${x.counted} de ${current.items.length} productos contados` : 'Aún sin contar';
    $('#orderBar').style.width = (current.finishedAt ? 100 : current.items.length ? (x.counted / current.items.length) * 100 : 0) + '%';
    $('#btnStartCount').innerHTML = ic('scan') + (current.finishedAt ? ' Revisar conteo' : x.counted ? ' Seguir contando' : ' ' + T(current).contar);
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
    openOrder(o.id);
  }

  $('#btnShareLink').onclick = async () => {
    const url = location.origin + location.pathname + '#p=' + exportPayload(current);
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
  };
  $('#btnDeleteOrder').onclick = async () => {
    const r = await ask({ title: `¿Eliminar este ${T(current).doc}?`, html: '<p>Se borrará también el conteo y sus fotos.</p>',
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
      if (!isAdmin()) {
        ask({ title: 'Este conteo ya fue terminado', html: '<p>Solo un administrador puede reabrirlo para corregir.</p>',
          buttons: [{ label: 'Cerrar', value: '' }, { label: 'Ver diferencias', value: 'res', cls: 'primary' }] })
          .then((r) => { if (r.value === 'res') renderResults(); });
        return;
      }
      ask({ title: 'Este conteo ya fue terminado', html: '<p>¿Quieres reabrirlo para corregir? Quedará registrado que se reabrió.</p>',
        buttons: [{ label: 'Ver diferencias', value: 'res' }, { label: 'Reabrir conteo', value: 'open', cls: 'primary' }] })
        .then((r) => {
          if (r.value === 'open') { current.finishedAt = null; current.reopened = (current.reopened || 0) + 1; save(); startCount(); }
          else if (r.value === 'res') renderResults();
        });
      return;
    }
    show('count', current.nombre);
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
    if (log) current.log.push({ t: 'i', id: item.id, prev });
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
      const r = await ask({ title: `Código no está en el ${t.doc}`,
        html: `<p class="mono">${esc(raw)}</p>${cat ? `<p>Según el maestro es <b>${esc(cat.nombre)}</b> (material <span class="mono">${esc(cat.sku)}</span>).</p>` : ''}
          ${scannedLote ? `<p>Lote leído: <b class="mono">${esc(scannedLote)}</b></p>` : ''}
          <p>${current.tipo === 'inventario' ? 'Si el producto está en la sucursal, regístralo como sobrante.' : 'Si llegó en la cubeta, regístralo como sobrante.'}</p>
          <label>Nombre del producto<input name="producto" placeholder="Ej: Ibuprofeno 400mg" value="${esc(cat ? cat.nombre : '')}"></label>`,
        buttons: [{ label: 'Ignorar', value: '' }, { label: 'Registrar sobrante', value: 'ok', cls: 'primary' }] });
      if (r.value === 'ok') {
        addExtra({ codigo: cat && cat.ean ? cat.ean : (gs1 ? gs1.gtin : raw), sku: cat ? cat.sku : '', producto: r.fields.producto.trim() || 'Producto sin nombre (' + raw + ')',
          lote: scannedLote, motivo: t.extra }, amount);
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
    const t = T(o);
    const rows = o.items.map((i) => {
      const contado = o.counts[i.id] || 0;
      const dif = contado - i.cantidad;
      let estado = 'OK';
      if (dif < 0) estado = contado === 0 ? t.noLlego : 'Faltante';
      else if (dif > 0) estado = 'Sobrante';
      return { id: i.id, codigo: i.codigo, sku: i.sku || '', categoria: i.categoria || '', producto: i.producto, lote: i.lote, precio: i.precio, contado, esperado: i.cantidad, dif, estado };
    });
    for (const x of o.extras) {
      rows.push({ id: x.id, codigo: x.codigo, sku: x.sku || '', categoria: '', producto: x.producto, lote: x.lote, precio: 0, contado: x.cantidad, esperado: 0, dif: x.cantidad,
        estado: x.motivo === 'Lote distinto al enviado' ? 'Lote distinto' : t.extra });
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
          <span class="kicker">${T(current).Doc} · ${esc(current.sucursal || 'Sucursal')}${current.fechaSistema ? ' · existencias al ' + esc(current.fechaSistema) : ''} · Cerrado ${current.finishedAt ? fmtDate(current.finishedAt) : ''}${current.contadoPor ? ' · contó ' + esc(current.contadoPor) : ''}${current.reopened ? ` · reabierto ${current.reopened}×` : ''}</span>
          <h2 class="page-title">Diferencias · ${esc(current.nombre)}</h2>
        </div>
      </div>
      <div class="kpis five">
        <div class="kpi ${diffs.length ? '' : 'ok'}"><div class="l">Exactitud</div><div class="v">${pct}%</div><div class="s">${ok.toLocaleString('es')} de ${rows.length.toLocaleString('es')} líneas correctas</div><div class="meter"><span style="width:${pct}%"></span></div></div>
        <div class="kpi ${uFalt ? 'bad' : ''}"><div class="l">Faltan</div><div class="v">${uFalt.toLocaleString('es')}</div><div class="s">unid. · ${falt.length} ${falt.length === 1 ? 'producto' : 'productos'}</div></div>
        <div class="kpi ${uSobr ? 'warn' : ''}"><div class="l">Sobran</div><div class="v">${uSobr.toLocaleString('es')}</div><div class="s">unid. · ${sobr.length} ${sobr.length === 1 ? 'producto' : 'productos'}</div></div>
        ${current.tipo === 'inventario'
          ? `<div class="kpi"><div class="l">Unidades</div><div class="v">${rows.reduce((s, r) => s + r.contado, 0).toLocaleString('es')}</div><div class="s">contadas de ${rows.reduce((s, r) => s + r.esperado, 0).toLocaleString('es')} en sistema</div></div>`
          : `<div class="kpi"><div class="l">Valor faltante</div><div class="v">$ ${fmtMoney(vFalt)}</div><div class="s">a precio del pedido</div></div>`}
        <div class="kpi"><div class="l">Tiempo de conteo</div><div class="v">${dur}</div><div class="s">primer registro → cierre</div></div>
      </div>`;
    renderResultsTable(rows);
  }

  function renderResultsTable(rows) {
    const only = $('#onlyDiffs').checked;
    const list = (only ? rows.filter((r) => r.dif !== 0 || evOf(current, r.id)) : rows)
      .sort((a, b) => (a.dif === 0) - (b.dif === 0) || a.producto.localeCompare(b.producto, 'es'));
    if (!list.length) {
      $('#resultsTable').innerHTML = `<div class="card good-msg">${ic('check')} Todo correcto: ${T(current).ok}.</div>`;
      return;
    }
    $('#resultsTable').innerHTML = `<div class="card"><div class="table-wrap"><table class="results">
      <thead><tr><th>Producto</th><th class="num">${T(current).llego}</th><th class="num">${T(current).debia}</th><th class="num">Dif.</th><th>Estado</th></tr></thead>
      <tbody>${list.map((r) => `<tr data-rid="${r.id}">
        <td><b>${esc(r.producto)}</b><div class="sub">${[r.sku && `<span class="mono">${esc(r.sku)}</span>`, r.codigo && `<span class="mono">${esc(r.codigo)}</span>`, r.lote && `Lote <span class="mono">${esc(r.lote)}</span>`, r.categoria && esc(r.categoria)].filter(Boolean).join(' · ')}</div>${evHtml(r.id)}</td>
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
    const inv = current.tipo === 'inventario';
    const t = T(current);
    return computeResults(current).map((r) => {
      const ev = evOf(current, r.id);
      const base = inv
        ? { 'Material': r.sku, 'Código de barras': r.codigo, 'Producto': r.producto, 'Categoría': r.categoria }
        : { 'Código': r.codigo, 'Producto': r.producto, 'Lote': r.lote, 'Precio': r.precio };
      return Object.assign(base, { [t.llego]: r.contado, [t.debia]: r.esperado, 'Diferencia': r.dif },
        inv ? {} : { 'Valor diferencia': +(r.dif * r.precio).toFixed(2) },
        { 'Estado': r.estado, 'Motivo': ev?.motivo || '', 'Nota': ev?.nota || '', 'Fotos': ev?.fotos.length || 0 });
    });
  }
  $('#btnExportXlsx').onclick = () => {
    const ws = XLSX.utils.json_to_sheet(exportRows());
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Diferencias');
    const info = [[T(current).Doc, current.nombre], ['Sucursal', current.sucursal || ''], ...(current.fechaSistema ? [['Existencias al', current.fechaSistema]] : []), ['Contado por', current.contadoPor || ''],
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
      return `• ${r.producto}${r.sku ? ' [' + r.sku + ']' : ''}${r.lote ? ' (L ' + r.lote + ')' : ''}: ${T(current).llego.toLowerCase()} ${r.contado} und | ${T(current).debia.toLowerCase()} ${r.esperado} und → ${dif}` +
        `${r.estado === 'Lote distinto' ? ' [lote distinto]' : ''}${ev && ev.motivo ? ' — ' + ev.motivo : ''}${ev && ev.nota ? ': ' + ev.nota : ''}`;
    });
    const nFotos = rows.reduce((s, r) => s + (evOf(current, r.id)?.fotos.length || 0), 0);
    const text = `${current.tipo === 'inventario' ? 'Inventario' : 'Revisión'} ${current.nombre}${current.sucursal ? ' - ' + current.sucursal : ''}\n` +
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


  // =========================================================
  // USUARIOS Y SESIÓN
  // Las contraseñas se guardan cifradas (PBKDF2) en este equipo; nunca en texto.
  // =========================================================
  const USERS_KEY = 'revision-usuarios-v1';
  const SESSION_KEY = 'revision-sesion-v1';
  let users = loadJSON(USERS_KEY, []);
  function loadJSON(key, def) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? def; } catch (e) { return def; }
  }
  function saveUsers() { localStorage.setItem(USERS_KEY, JSON.stringify(users)); }
  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  async function hashPass(pass, salt) {
    if (!crypto.subtle) throw new Error('Este navegador no permite guardar contraseñas de forma segura (abre la app con https).');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 120000, hash: 'SHA-256' }, key, 256);
    return toB64(bits);
  }
  async function makeUser({ nombre, usuario, pass, rol = 'sucursal', sucursal = '' }) {
    const salt = uid() + uid();
    return { id: uid(), nombre: nombre.trim(), usuario: usuario.trim().toLowerCase(), rol, sucursal: sucursal.trim(), salt, hash: await hashPass(pass, salt), creado: Date.now() };
  }
  const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const rolName = (r) => (r === 'admin' ? 'Administrador' : 'Sucursal');

  function setSession(u) {
    me = u;
    try { if (u) localStorage.setItem(SESSION_KEY, u.id); else localStorage.removeItem(SESSION_KEY); } catch (e) { /* sin almacenamiento */ }
    document.body.classList.toggle('role-sucursal', !!u && u.rol !== 'admin');
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
    $('#loginDemo').innerHTML = 'Demo: administrador <b>admin</b> / <b>admin123</b> · sucursal <b>renca</b> / <b>1234</b>';
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
        if (pass.length < 6) return loginError('La contraseña debe tener al menos 6 caracteres.');
        if (pass !== $('#setupPass2').value) return loginError('Las contraseñas no coinciden.');
        const u = await makeUser({ nombre, usuario, pass, rol: 'admin' });
        users.push(u);
        saveUsers();
        return afterLogin(u);
      }
      const u = users.find((x) => x.usuario === usuario);
      if (!u || (await hashPass(pass, u.salt)) !== u.hash) return loginError('Usuario o contraseña incorrectos.');
      afterLogin(u);
    } catch (err) { loginError(err.message); }
    finally { btn.disabled = false; }
  };

  function afterLogin(u) {
    setSession(u);
    if (!checkHash()) renderHome();
  }

  // ---------- Menú de usuario ----------
  $('#btnUser').onclick = async () => {
    if (!me) return;
    const opts = [
      ...(isAdmin() ? [['users', 'users', 'Usuarios'], ['catalog', 'list', 'Maestro de productos'], ['export', 'download', 'Exportar configuración'], ['import', 'upload', 'Importar configuración']] : []),
      ['pass', 'lock', 'Cambiar mi contraseña'], ['logout', 'logout', 'Cerrar sesión'],
    ];
    const r = await ask({ title: 'Mi cuenta',
      html: `<div class="menu-who"><span class="avatar">${esc(initials(me.nombre))}</span><div><b>${esc(me.nombre)}</b><div class="small muted">${esc(me.usuario)} · ${rolName(me.rol)}${me.sucursal ? ' · ' + esc(me.sucursal) : ''}</div></div></div>
        <div class="menu-list">${opts.map(([v, i, l]) => `<button class="btn" value="${v}">${ic(i)} ${l}</button>`).join('')}</div>`,
      buttons: [{ label: 'Cerrar', value: '' }] });
    if (r.value === 'logout') showLogin();
    else if (r.value === 'users') renderUsers();
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
    if (f.nueva.length < 4) return info('No se cambió', 'La nueva contraseña debe tener al menos 4 caracteres.');
    if (f.nueva !== f.nueva2) return info('No se cambió', 'Las contraseñas no coinciden.');
    u.salt = uid() + uid();
    u.hash = await hashPass(f.nueva, u.salt);
    saveUsers();
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
        <label>Rol<select name="rol"><option value="sucursal" ${u && u.rol === 'sucursal' ? 'selected' : ''}>Sucursal: solo cuenta</option><option value="admin" ${u && u.rol === 'admin' ? 'selected' : ''}>Administrador: todo</option></select></label>
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
      Object.assign(u, { nombre: f.nombre.trim(), usuario, rol: f.rol, sucursal: f.sucursal.trim() });
      if (u.id === me.id) setSession(u);
    } else {
      if ((f.pass || '').length < 4) return info('No se guardó', 'La contraseña inicial debe tener al menos 4 caracteres.');
      users.push(await makeUser({ nombre: f.nombre, usuario, pass: f.pass, rol: f.rol, sucursal: f.sucursal }));
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
    saveUsers();
    renderUsers();
  }

  // ---------- Exportar / importar configuración (usuarios + maestro) ----------
  function exportConfig() {
    const data = { tipo: 'revision-config', v: 1, exportado: Date.now(), usuarios: users, catalogo: catalog };
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'configuracion-revision.json');
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
        unidad: map.unidad !== undefined ? String(r[map.unidad] ?? '').trim() : '', grupo: map.grupo !== undefined ? String(r[map.grupo] ?? '').trim() : '' });
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
      <div class="kpi"><div class="l">Actualizado</div><div class="v" style="font-size:18px">${catalog.actualizado ? fmtDate(catalog.actualizado) : '—'}</div><div class="s">${esc(catalog.archivo || 'sin cargar')}</div></div>`;
    renderCatalogList();
  }
  function renderCatalogList() {
    const items = catalog.items || [];
    if (!items.length) { $('#catalogList').innerHTML = '<div class="empty">Aún no hay maestro. Sube el Excel con los productos (Material, Texto breve de material, Código EAN/UPC).</div>'; return; }
    const q = normText($('#catalogSearch').value);
    const found = q ? items.filter((p) => normText(`${p.nombre} ${p.sku} ${p.ean}`).includes(q)) : items;
    $('#catalogList').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Material</th><th>Producto</th><th>Código de barras</th><th>Unidad</th></tr></thead>
      <tbody>${found.slice(0, 150).map((p) => `<tr><td class="mono">${esc(p.sku)}</td><td>${esc(p.nombre)}</td><td class="mono">${esc(p.ean) || '<span class="muted">—</span>'}</td><td>${esc(p.unidad)}</td></tr>`).join('')}</tbody></table></div>
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
      renderCatalog();
      st.className = 'load-status ok'; st.hidden = false;
      st.innerHTML = `${ic('check')}<span>Maestro cargado: ${items.length.toLocaleString('es')} productos de ${esc(f.name)}.</span>`;
    } catch (err) {
      st.className = 'load-status err'; st.hidden = false;
      st.innerHTML = `${ic('alert')}<span>${esc(err.message)}</span>`;
    }
  };
  async function readSheetRows(f) {
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
    invDraft = null;
    openOrder(o.id);
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
    if (window.REVISION_DEMO && !users.length) {
      users.push(await makeUser({ nombre: 'Administrador', usuario: 'admin', pass: 'admin123', rol: 'admin' }));
      users.push(await makeUser({ nombre: 'Sucursal Renca', usuario: 'renca', pass: '1234', rol: 'sucursal', sucursal: 'CL0007 RENCA' }));
      saveUsers();
    }
    if (window.REVISION_DEMO && !db.orders.length) createDemo();
    const sid = loadJSON(SESSION_KEY, null) || (() => { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } })();
    const u = users.find((x) => x.id === sid);
    if (u) afterLogin(u); else showLogin();
  })();

  // Exponer funciones para pruebas
  window.__app = { parseDelimited, rowsToItems, normCode, parseNum, computeResults, processCode: (c) => handleCode(c), parseCatalogRows };
})();

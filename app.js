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
  const stripAccents = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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
    } else {
      // Un solo tipo de separador: si se repite o le siguen exactamente 3 dígitos, es de miles
      // ("3.990", "3,990", "1.250.000"); si no, es decimal ("2,5", "3.99").
      const sep = lc > -1 ? ',' : ld > -1 ? '.' : '';
      if (sep) {
        const parts = s.split(sep);
        s = parts.length > 2 || /^\d{3}$/.test(parts[1]) ? parts.join('') : parts.join('.');
      }
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
    // Con servidor, los documentos se guardan allá (no en el equipo).
    if (SERVER) { if (current) scheduleSync(current); return; }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db, (k, v) => (k === '_hay' ? undefined : v))); }
    catch (e) { alert('No se pudo guardar en este dispositivo: ' + e.message); }
  }
  const getOrder = (id) => db.orders.find((o) => o.id === id);

  // =========================================================
  // MODO SERVIDOR (PHP + MySQL). Si la app encuentra la API, la usa;
  // si no (demo, sin servidor), funciona sola en el equipo como antes.
  // =========================================================
  let SERVER = false;
  let serverInfo = null;
  let csrf = '';
  async function detectServer() {
    if (window.REVISION_DEMO) return null;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch('api/estado.php', { cache: 'no-store', credentials: 'same-origin', signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null;
      const d = await r.json();
      return d && d.modo === 'servidor' ? d : null;
    } catch (e) { return null; }
  }
  async function api(path, { method = 'GET', body, raw } = {}) {
    const opt = { method, credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (method !== 'GET') opt.headers['X-CSRF-Token'] = csrf;
    if (raw) opt.body = raw;
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body, (k, v) => (k === '_hay' ? undefined : v)); }
    let res;
    try { res = await fetch('api/' + path, opt); }
    catch (e) { throw Object.assign(new Error('No hay conexión con el servidor. Revisa la señal e intenta de nuevo.'), { offline: true }); }
    const isJson = (res.headers.get('content-type') || '').includes('json');
    const data = isJson ? await res.json() : await res.blob();
    if (isJson && data && data.csrf) csrf = data.csrf;
    if (res.status === 401 && me && !/login|setup/.test(path)) sessionExpired();
    if (!res.ok) throw Object.assign(new Error((isJson && data && data.error) || 'Error del servidor.'), { status: res.status, data });
    return data;
  }
  async function refreshCsrf() { const s = await api('sesion.php'); csrf = s.csrf || csrf; return s; }
  function sessionExpired() {
    setSession(null);
    showLogin();
    loginError('Tu sesión terminó. Vuelve a entrar.');
  }

  // Sincronización de documentos con el servidor (guardado diferido y control de versión).
  const syncTimers = new Map();
  const pendingSync = new Set();
  function scheduleSync(o, delay = 700) {
    pendingSync.add(o.id);
    clearTimeout(syncTimers.get(o.id));
    syncTimers.set(o.id, setTimeout(() => syncDoc(o.id), delay));
  }
  async function syncDoc(id) {
    const o = getOrder(id);
    if (!o || !SERVER || !me) return;
    clearTimeout(syncTimers.get(id));
    try {
      const r = await api('documentos.php?id=' + encodeURIComponent(id), { method: 'PUT', body: { version: o._version, documento: o } });
      pendingSync.delete(id);
      // El servidor manda en estos campos (quién finalizó, aprobó, etc.).
      ['_version', 'finishedAt', 'contadoPor', 'verifiedAt', 'verifiedBy', 'reopened'].forEach((k) => { if (k in r.documento) o[k] = r.documento[k]; });
      setSyncState('');
    } catch (e) {
      if (e.status === 409 && e.data && e.data.documento) {
        // Otro equipo cambió el documento: se carga la versión del servidor.
        pendingSync.delete(id);
        replaceDoc(e.data.documento);
        info('Documento actualizado', 'Otro equipo modificó este documento. Se cargó la versión más reciente; revisa y vuelve a registrar lo último si hace falta.');
      } else if (e.offline) {
        setSyncState('Sin conexión: los cambios se guardarán al volver la señal.');
        scheduleSync(o, 15000);
      } else if (e.status !== 401) {
        pendingSync.delete(id);
        info('No se guardó', esc(e.message));
      }
    }
  }
  async function flushSyncs() { await Promise.all([...pendingSync].map((id) => syncDoc(id))); }
  function setSyncState(msg) {
    if (msg) flash(`${ic('alert')}<span>${esc(msg)}</span>`, 'warn');
  }
  function replaceDoc(d) {
    d = normDoc(d);
    const i = db.orders.findIndex((x) => x.id === d.id);
    if (i >= 0) db.orders[i] = d; else db.orders.unshift(d);
    if (current && current.id === d.id) {
      current = d;
      if (!$('#view-count').hidden) renderCount();
      else if (!$('#view-results').hidden) { renderSummary(); renderResultsTable(); }
      else if (!$('#view-order').hidden) openOrder(d.id);
    }
  }
  // Crea un documento nuevo (en el servidor o en el equipo).
  async function persistNewDoc(o) {
    if (!SERVER) { db.orders.push(o); save(); return o; }
    const r = await api('documentos.php', { method: 'POST', body: { documento: o } });
    const d = normDoc(r.documento);
    db.orders.unshift(d);
    return d;
  }
  // Defensa extra: los mapas por producto siempre como objetos.
  function normDoc(d) {
    ['counts', 'evid', 'review', 'recount', 'venc'].forEach((k) => { if (Array.isArray(d[k]) || (k in d && !d[k])) d[k] = {}; });
    ['extras', 'log', 'samples'].forEach((k) => { if (k in d && !Array.isArray(d[k])) d[k] = []; });
    return d;
  }
  async function loadServerData() {
    const [c, d] = await Promise.all([api('catalogo.php'), api('documentos.php')]);
    catalog = c.catalogo || { items: [] };
    catIdx = null;
    db.orders = (d.documentos || []).map(normDoc);
  }

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
  // Con servidor, estas acciones las registra el propio servidor (no se duplican).
  const SERVER_LOGGED = new Set(['Inicio de sesión', 'Cierre de sesión', 'Inicio de sesión fallido', 'Inicio de sesión bloqueado', 'Configuró la app y creó el administrador',
    'Creó usuario', 'Editó usuario', 'Eliminó usuario', 'Cambió su contraseña', 'Cambió la contraseña de otro usuario', 'Vio la bitácora', 'Sesión cerrada por inactividad']);
  const QUEUE_KEY = 'revision-bitacora-cola';
  let auditQueue = (() => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (e) { return []; } })();
  let flushTimer = null;
  function audit(accion, extra = {}) {
    const o = extra.doc === undefined && current ? current : null;
    const e = Object.assign({
      usuarioId: me ? me.id : null, usuario: me ? me.usuario : (extra.usuario || null), nombre: me ? me.nombre : null, rol: me ? role() : null,
      accion, docId: o ? o.id : null, doc: o ? o.nombre : null, sucursal: o ? o.sucursal || null : null,
    }, extra);
    if (SERVER) {
      if (SERVER_LOGGED.has(accion) || !me) return;
      auditQueue.push({ ...e, ts: Date.now() });
      try { localStorage.setItem(QUEUE_KEY, JSON.stringify(auditQueue)); } catch (x) { /* sin almacenamiento */ }
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushAudit, 1500);
      return;
    }
    if (window.Bitacora) Bitacora.log(e);
  }
  // Envía la bitácora pendiente; si no hay señal, queda en cola y se reintenta.
  async function flushAudit() {
    clearTimeout(flushTimer);
    if (!SERVER || !me || !auditQueue.length) return;
    const batch = auditQueue.slice(0, 200);
    try {
      await api('bitacora.php', { method: 'POST', body: { eventos: batch } });
      auditQueue.splice(0, batch.length);
      try { localStorage.setItem(QUEUE_KEY, JSON.stringify(auditQueue)); } catch (x) { /* sin almacenamiento */ }
      if (auditQueue.length) flushTimer = setTimeout(flushAudit, 300);
    } catch (err) { if (err.status !== 401) flushTimer = setTimeout(flushAudit, 20000); }
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
  // Con servidor, la lista trae solo un resumen (o._resumen): se usan sus totales.
  const nItems = (o) => (o._resumen ? o.n_items || 0 : o.items.length);
  function orderStatus(o) {
    const counted = o._resumen ? o.contados || 0 : o.items.filter((i) => (o.counts[i.id] || 0) > 0).length;
    if (o.finishedAt) {
      if (!isStaff()) return { counted, key: 'done', tag: '<span class="pill ok">Finalizado</span>', diffs: 0 };
      const d = o._resumen ? o.desviaciones || 0 : computeResults(o).filter((r) => r.dif !== 0).length;
      const tag = o.verifiedAt ? `<span class="pill ok">Aprobado${d ? ' · ' + d + ' dif.' : ''}</span>`
        : d ? `<span class="pill bad">${d} ${d === 1 ? 'desviación' : 'desviaciones'} · por verificar</span>` : '<span class="pill ok">Sin desviaciones</span>';
      return { counted, key: 'done', tag, diffs: d };
    }
    return { counted, key: counted ? 'counting' : 'new', tag: counted ? '<span class="pill warn">En conteo</span>' : '<span class="pill">Sin contar</span>', diffs: 0 };
  }

  let homeFetch = 0;
  function renderHome(refresh = true) {
    current = null;
    show('home');
    // Con servidor, se trae el estado actualizado (por ejemplo, conteos que terminó otro equipo).
    if (SERVER && refresh && me) {
      const k = ++homeFetch;
      flushSyncs().then(() => api('documentos.php')).then((d) => {
        if (k !== homeFetch || $('#view-home').hidden) return;
        db.orders = (d.documentos || []).map(normDoc);
        renderHome(false);
      }).catch(() => {});
    }
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
      list.innerHTML = `<div class="empty">Todavía no hay pedidos ni inventarios. ${isAdmin() ? 'Usa <b>Nuevo pedido</b> o <b>Nuevo inventario</b>, o abre el enlace o archivo que te enviaron.' : isStaff() ? 'Para tomar inventario, descarga de SPOS el reporte de inventario en PDF y usa <b>Nuevo inventario</b>.' : 'Cuando la QF cargue un inventario o llegue un pedido, aparecerá aquí.'}
        ${isAdmin() ? `<div class="actions" style="justify-content:center;margin-top:14px;flex-wrap:wrap"><button class="btn primary" id="btnDemoFull">${ic('box')} Cargar ejemplo (Cefalmin y Naproxeno)</button><button class="btn" id="btnDemo">${ic('box')} Cargar pedido de ejemplo</button></div>
          <p class="small muted center" style="margin-top:8px">El ejemplo con Cefalmin y Naproxeno carga el maestro con costos, un inventario de CL0099 CENTRO y un pedido, listos para escanear.</p>` : ''}</div>`;
      if ($('#btnDemoFull')) $('#btnDemoFull').onclick = async () => {
        const before = db.orders.length;
        createDemo();
        const nuevos = db.orders.slice(before);
        if (SERVER) {
          db.orders = db.orders.slice(0, before);
          try { for (const o of nuevos) await persistNewDoc(o); } catch (e) { return info('No se pudo crear', esc(e.message)); }
        }
        audit('Cargó datos de ejemplo', { detalle: 'maestro, inventario y pedido con Cefalmin y Naproxeno' });
        renderHome(true);
      };
      if ($('#btnDemo')) $('#btnDemo').onclick = async () => {
        let o = createSamplePedido();
        if (SERVER) {
          db.orders = db.orders.filter((x) => x !== o);
          try { o = await persistNewDoc(o); } catch (e) { return info('No se pudo crear', esc(e.message)); }
        }
        openOrder(o.id);
      };
      return;
    }
    list.innerHTML = `<div class="table-wrap"><table class="orders">
      <thead><tr><th>Documento</th><th>Sucursal</th><th>Avance</th><th>Estado</th><th class="num">Fecha</th></tr></thead>
      <tbody>${db.orders.slice().sort((a, b) => b.creado - a.creado).map((o) => {
        const x = orderStatus(o);
        const pct = o.finishedAt ? 100 : (nItems(o) ? Math.round((x.counted / nItems(o)) * 100) : 0);
        return `<tr class="click" data-id="${o.id}">
          <td><b>${esc(o.nombre || T(o).Doc)}</b><div class="sub"><span class="pill type">${T(o).Doc}</span> ${nItems(o).toLocaleString('es-CL')} productos${o.contadoPor ? ' · contó ' + esc(o.contadoPor) : ''}</div></td>
          <td class="c-branch">${esc(o.sucursal || '—')}</td>
          <td class="c-progress"><span class="sub">${o.finishedAt ? 'Cerrado' : `${x.counted.toLocaleString('es-CL')} de ${nItems(o).toLocaleString('es-CL')}`}</span><div class="mini-bar"><span style="width:${pct}%"></span></div></td>
          <td class="c-state">${x.tag}</td>
          <td class="num c-date sub">${fmtDate(o.finishedAt || o.creado)}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
    list.querySelectorAll('tr[data-id]').forEach((r) => { r.onclick = () => openOrder(r.dataset.id); });
  }

  // Pedido de ejemplo para probar la app sin preparar archivos.
  // Demo: maestro con costos, un inventario de la sucursal (como el reporte de SPOS) y un pedido que llega.
  // Productos y códigos ficticios (EAN-13 válidos, para poder imprimirlos y escanearlos).
  const DEMO_SUC = 'CL0099 CENTRO';
  const DEMO_PROD = [
    // material, nombre, categoría, EAN, costo, existencia según sistema
    ['100990', 'CEFALMIN COMPRIMIDOS X20', 'MEDICAMENTOS', '7800038041210', 3990, 24],
    ['100995', 'NAPROXENO COMPRIMIDOS', 'MEDICAMENTOS', '7800007176394', 2490, 15],
    ['100871', 'ATORVASTATINA 20 MG X30 COMP', 'MEDICAMENTOS', '7801234500037', 8990, 12],
    ['100872', 'LOSARTAN 50 MG X30 COMP', 'MEDICAMENTOS', '7801234500044', 3290, 25],
    ['101302', 'PARACETAMOL 500 MG X16 COMP', 'MEDICAMENTOS', '7801234500099', 990, 30],
    ['100246', 'ENOXAPARINA 40 MG JERINGA X2', 'REFRIGERADOS', '7801234500020', 21500, 8],
    ['100245', 'INSULINA GLARGINA 100 UI/ML LAPICERA', 'REFRIGERADOS', '7801234500013', 38900, 6],
    ['101455', 'OMEPRAZOL 20 MG X28 CAPS', 'DIGESTIVO', '7801234500112', 1890, 10],
    ['102010', 'VITAMINA C 1 G X10 EFERV', 'SUPLEMENTOS', '7801234500136', 2290, 22],
    ['103001', 'ALCOHOL GEL 250 ML', 'CUIDADO PERSONAL', '7801234500167', 1290, 35],
  ];
  // Pedido de ejemplo del botón "Cargar pedido de ejemplo" (app normal).
  function createSamplePedido() {
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
    if (!SERVER) save();
    return o;
  }
  function createDemo() {
    if (!(catalog.items || []).length) {
      setCatalog({ items: DEMO_PROD.map(([sku, nombre, grupo, ean, precio]) => ({ sku, nombre, ean, unidad: 'UN', grupo, precio })), actualizado: Date.now(), archivo: 'maestro de ejemplo' });
    }
    const inv = newOrder({ tipo: 'inventario', nombre: `Inventario ${DEMO_SUC} (ejemplo)`, sucursal: DEMO_SUC, fechaSistema: new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago' }).format(Date.now()),
      items: DEMO_PROD.map(([sku, producto, categoria, codigo, precio, cantidad]) => ({ id: uid(), sku, codigo, producto, categoria, cantidad, lote: '', precio, vencimiento: '' })) });
    const ped = newOrder({ nombre: 'Pedido 4512 (ejemplo)', sucursal: DEMO_SUC, items: [
      ['7801234500099', 'PARACETAMOL 500 MG X16 COMP', 'P5521', 990, 30, '2027-05-31'],
      ['7800007176394', 'NAPROXENO COMPRIMIDOS', 'NX2501', 2490, 10, '2027-06-30'],
      ['7800038041210', 'CEFALMIN COMPRIMIDOS X20', 'CF2411', 3990, 12, '2027-01-31'],
      ['7801234500013', 'INSULINA GLARGINA 100 UI/ML LAPICERA', 'IN2409', 38900, 6, '2027-03-31'],
      ['7801234500112', 'OMEPRAZOL 20 MG X28 CAPS', 'O3302', 1890, 20, '2027-02-28'],
      ['7801234500167', 'ALCOHOL GEL 250 ML', 'AG0915', 1290, 40, '2028-01-31'],
    ].map(([codigo, producto, lote, precio, cantidad, vencimiento]) => ({ id: uid(), codigo, producto, lote, precio, cantidad, vencimiento })) });
    db.orders.push(inv, ped);
    if (!SERVER) save();
    return ped;
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

  $('#btnSaveOrder').onclick = async () => {
    if (!draft.length) return setLoadStatus('Agrega al menos un producto antes de guardar.', 'err');
    if (draft.some((i) => !i.producto || !(i.cantidad > 0))) return setLoadStatus('Hay productos sin nombre o sin cantidad. Corrígelos o quítalos antes de guardar.', 'err');
    const o = newOrder({
      nombre: $('#orderName').value.trim() || 'Pedido ' + new Date().toLocaleDateString('es'),
      sucursal: $('#orderBranch').value.trim(),
      items: draft.map(({ revisar, ...i }) => i),
    });
    let saved;
    try { saved = await persistNewDoc(o); } catch (e) { return setLoadStatus(esc(e.message), 'err'); }
    audit('Creó pedido', { docId: saved.id, doc: saved.nombre, sucursal: saved.sucursal || null, detalle: `${saved.items.length} productos` });
    openOrder(saved.id);
  };

  function newOrder({ id, nombre, sucursal, creado, items, origen = 'central', tipo = 'pedido', fechaSistema = '' }) {
    return { id: id || uid(), tipo, nombre, sucursal, fechaSistema, creado: creado || Date.now(), creadoPor: me ? me.nombre : '', origen, items,
      counts: {}, extras: [], evid: {}, log: [], finishedAt: null, reopened: 0 };
  }

  // =========================================================
  // PEDIDO: ENVÍO / IMPORTACIÓN
  // =========================================================
  async function openOrder(id) {
    // Con servidor, el detalle completo se pide al abrir el documento.
    const cached = getOrder(id);
    if (SERVER && cached && cached._resumen) {
      try { replaceDoc((await api('documentos.php?id=' + encodeURIComponent(id))).documento); }
      catch (e) { return info('No se pudo abrir', esc(e.message)); }
    }
    current = getOrder(id);
    if (!current) return renderHome();
    show('order', current.nombre);
    audit(`Abrió ${T(current).doc}`, { detalle: current.finishedAt ? 'finalizado' : 'abierto' });
    $('#orderTitle').textContent = current.nombre;
    $('#orderMeta').textContent = `${T(current).Doc}${current.sucursal ? ' · ' + current.sucursal : ''}${current.fechaSistema ? ' · reporte al ' + current.fechaSistema : ''} · ${current.items.length} productos`;
    $('#shareWhat').textContent = current.tipo === 'inventario' ? 'del sistema' : 'enviadas';
    const x = orderStatus(current);
    $('#orderProgress').textContent = current.finishedAt ? `Finalizado ${fmtDate(current.finishedAt)}${current.contadoPor ? ' · contó ' + current.contadoPor : ''}${current.verifiedAt ? ' · aprobado por ' + (current.verifiedBy || 'QF') : isStaff() ? ' · por verificar' : ' · en revisión del QF'}`
      : x.counted ? `${x.counted} de ${current.items.length} productos contados` : 'Aún sin contar';
    $('#orderBar').style.width = (current.finishedAt ? 100 : current.items.length ? (x.counted / current.items.length) * 100 : 0) + '%';
    $('#btnStartCount').innerHTML = ic('scan') + (current.finishedAt ? (isStaff() ? ' Reabrir conteo' : ' Conteo finalizado') : x.counted ? ' Seguir contando' : ' ' + T(current).contar);
    $('#btnShowResults').innerHTML = ic('chart') + (current.tipo === 'inventario' ? ' Reporte de desviaciones' : ' Ver diferencias');
    $('#shareInfo').textContent = '';
    // Eliminar: el administrador siempre; la QF, un inventario mal cargado mientras nadie ha contado.
    $('#dangerZone').hidden = !canDeleteDoc(current);
    $('#btnDeleteOrder').innerHTML = ic('trash') + ' Eliminar ' + T(current).doc;
  }
  function canDeleteDoc(o) {
    if (isAdmin()) return true;
    return role() === 'qf' && o.tipo === 'inventario' && !o.finishedAt && !Object.keys(o.counts || {}).length && !(o.extras || []).length;
  }
  // Misma sucursal: compara el código (ej. CL0007) si ambos lo traen; si no, el texto completo.
  function sameBranch(a, b) {
    const n = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const code = (s) => (n(s).match(/\b[a-z]{2}\d{3,}\b/) || [])[0];
    if (!n(a) || !n(b)) return true;
    return code(a) && code(b) ? code(a) === code(b) : n(a) === n(b);
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
    if (SERVER) return info('Documento recibido', 'Con servidor, los pedidos e inventarios ya están en el sistema: búscalos en el inicio.');
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
    if (SERVER) {
      try { await api('documentos.php?id=' + encodeURIComponent(current.id), { method: 'DELETE' }); }
      catch (e) { return info('No se eliminó', esc(e.message)); }
    }
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
  // Foto desde el equipo; con servidor, si no está guardada aquí, se descarga (con permiso del servidor).
  async function getPhoto(id) {
    let blob = await Fotos.get(id).catch(() => null);
    if (!blob && SERVER) {
      try { blob = await api('evidencia.php?id=' + encodeURIComponent(id)); if (blob instanceof Blob) Fotos.put(id, blob).catch(() => {}); else blob = null; }
      catch (e) { blob = null; }
    }
    return blob;
  }
  function delPhoto(id) {
    Fotos.del(id);
    if (SERVER) api('evidencia.php?id=' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
  }
  async function photoUrl(id) {
    if (!photoUrls.has(id)) {
      const blob = await getPhoto(id);
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
          const blob = await compressImage(f);
          const fid = SERVER ? (await api('evidencia.php?doc=' + encodeURIComponent(current.id), { method: 'POST', raw: blob })).id : uid();
          await Fotos.put(fid, blob);
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
    if (r.value !== 'ok') { nuevas.forEach((fid) => delPhoto(fid)); return; }
    ev.fotos.filter((fid) => !fotos.includes(fid)).forEach((fid) => delPhoto(fid));
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
    $('#countKicker').textContent = [current.sucursal, current.tipo === 'inventario' && current.fechaSistema ? 'reporte al ' + current.fechaSistema : current.nombre].filter(Boolean).join(' · ');
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
    const items = current.items.filter((i) => itemMatches(i, q) && (!onlyPending || !qty(i)) && (!cat || i.categoria === cat));
    items.sort((a, b) => COLLATOR.compare(a.producto, b.producto));
    countView = { items, shown: 0 };
    const list = $('#countList');
    if (!items.length) list.innerHTML = '<li class="muted center">No hay productos que coincidan.</li>';
    else { list.innerHTML = ''; showMoreCount(PAGE_FIRST); }
    renderExtras();
    renderProgress();
  }

  // Lista larga (inventarios de miles de productos): se dibuja por tandas a medida que se baja.
  const COLLATOR = new Intl.Collator('es', { sensitivity: 'base' });
  const PAGE_FIRST = 60, PAGE_MORE = 200;
  let countView = { items: [], shown: 0 };
  const moreObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((en) => { if (en.some((e) => e.isIntersecting)) showMoreCount(PAGE_MORE); }, { rootMargin: '800px 0px' })
    : null;
  function showMoreCount(n) {
    const list = $('#countList');
    const { items } = countView;
    const from = countView.shown, to = Math.min(items.length, from + n);
    if (to <= from) return;
    list.querySelector('li.more')?.remove();
    list.insertAdjacentHTML('beforeend', items.slice(from, to).map(itemHtml).join('')
      + (to < items.length ? `<li class="more muted center"><button class="btn ghost" type="button" data-more>Mostrar más (${(items.length - to).toLocaleString('es')} restantes)</button></li>` : ''));
    countView.shown = to;
    const more = list.querySelector('li.more');
    if (more && moreObserver) { moreObserver.disconnect(); moreObserver.observe(more); }
  }
  // Asegura que un producto esté dibujado (por ejemplo, al escanearlo).
  function ensureRendered(id) {
    const idx = countView.items.findIndex((i) => i.id === id);
    if (idx >= countView.shown) showMoreCount(idx - countView.shown + 1);
  }

  function itemHtml(i) {
    const n = qty(i);
    const meta = [
      i.sku && `<b class="mono">${esc(i.sku)}</b>`,
      i.codigo && `<span class="mono">${esc(i.codigo)}</span>`,
      i.lote && `Lote <b class="mono">${esc(i.lote)}</b>`,
      i.categoria && `<span class="opt">${esc(i.categoria)}</span>`,
      isStaff() && i.vencimiento && (daysTo(i.vencimiento) !== null && daysTo(i.vencimiento) <= VENC_DIAS ? `<b class="venc-soon">Vence ${esc(fmtDay(i.vencimiento))}</b>` : `<span class="opt">Vence ${esc(fmtDay(i.vencimiento))}</span>`),
      isStaff() && (current.venc || {})[i.id] && `<b class="venc-soon">Leído: vence ${esc(fmtDay(current.venc[i.id]))}</b>`,
      // El auxiliar cuenta a ciegas: nunca ve costos.
      i.precio && isStaff() ? `<span class="opt">$ ${fmtMoney(i.precio)}</span>` : '',
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

  // ---------- Tramos de conteo y pausas ----------
  // Cada registro extiende el tramo actual. Si pasan más de PAUSA_MIN minutos sin registrar nada,
  // lo siguiente abre un tramo nuevo: la diferencia entre tramos es una pausa.
  const PAUSA_MIN = 5;
  function markActivity() {
    if (!current || current.finishedAt) return;
    const now = Date.now();
    const t = current.tramos || (current.tramos = []);
    const last = t[t.length - 1];
    if (last && now - last.fin <= PAUSA_MIN * 60000) { last.fin = now; last.n = (last.n || 0) + 1; return; }
    if (last) audit('Retomó el conteo tras una pausa', { detalle: `pausa de ${fmtDur(now - last.fin)} · tramo ${t.length + 1}` });
    t.push({ ini: now, fin: now, n: 1, por: me ? me.nombre : '' });
  }
  function tiempoConteo(o) {
    const t = (o.tramos || []).filter((x) => x && x.ini);
    if (!t.length) return null;
    const ini = t[0].ini, fin = Math.max(t[t.length - 1].fin, o.finishedAt || 0);
    const activo = t.reduce((s, x) => s + (x.fin - x.ini), 0);
    const pausas = t.slice(1).map((x, i) => x.ini - t[i].fin);
    return { ini, fin, total: fin - ini, activo, pausas, tramos: t };
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
    markActivity();
    save();
    updateItemRow(item);
    renderProgress();
  }

  let searchTimer;
  $('#search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderCount, current && current.items.length > 300 ? 150 : 0); };
  $('#catFilter').onchange = () => renderCount();
  $('#onlyPending').onchange = () => renderCount();

  $('#countList').addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) return showMoreCount(PAGE_MORE);
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
    markActivity();
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
          <div class="meta">${[x.codigo && `<span class="mono">${esc(x.codigo)}</span>`, x.lote && `Lote <b class="mono">${esc(x.lote)}</b>`, isStaff() && esc(x.motivo)].filter(Boolean).join(' · ')}</div></div>
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
    markActivity();
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
      // Inventarios (y pedidos sin lote): si el producto no tiene lote cargado, se cuenta igual.
      if (!target) { const sinLote = matches.filter((i) => !i.lote); if (sinLote.length === 1) target = sinLote[0]; }
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
    const loteOk = scannedLote && target.lote ? ' · lote verificado' : '';
    flash(`${ic('check')}<span>${esc(target.producto)}${target.lote ? ' · ' + esc(target.lote) : ''}${loteOk} — contados <b>${qty(target)}</b></span>`, 'ok');
    if (gs1 && gs1.vencimiento) checkExpiry(target, gs1.vencimiento);
    // Lleva el producto a la vista
    ensureRendered(target.id);
    const li = $(`#countList li[data-id="${target.id}"]`);
    // Con la cámara abierta no se mueve la pantalla (si no, la cámara queda tapada); solo se marca el producto.
    if (li) { li.classList.add('flash'); if (!scanner) li.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => li.classList.remove('flash'), 1200); }
  }

  // ---------- Vencimiento leído del código (DataMatrix GS1) ----------
  const VENC_DIAS = 90;
  function daysTo(fecha) {
    const t = Date.parse(fecha + 'T23:59:59-03:00');
    return isNaN(t) ? null : Math.floor((t - Date.now()) / 86400000);
  }
  const fmtDay = (f) => { const [y, m, d] = String(f).split('-'); return d && m && y ? `${d}-${m}-${y}` : f; };
  function checkExpiry(item, fecha) {
    const dias = daysTo(fecha);
    if (dias === null) return;
    current.venc = current.venc || {};
    if (dias < 0 || dias <= VENC_DIAS) {
      const prev = current.venc[item.id];
      // Se guarda la fecha más próxima leída para ese producto.
      if (!prev || fecha < prev) { current.venc[item.id] = fecha; save(); }
      // El vencimiento lo audita la QF: al auxiliar no se le avisa, solo queda guardado.
      if (!isStaff()) {
        audit(dias < 0 ? 'Escaneó producto vencido' : 'Escaneó producto por vencer', { producto: item.producto, sku: item.sku || item.codigo || null, detalle: `vence ${fmtDay(fecha)}` });
        return;
      }
      if (dias < 0) {
        beep(false);
        flash(`${ic('alert')}<span><b>Producto vencido</b> · ${esc(item.producto)}<br>Venció el ${fmtDay(fecha)}. Sepáralo y regístralo con una foto.</span>`, 'err');
        audit('Escaneó producto vencido', { producto: item.producto, sku: item.sku || item.codigo || null, detalle: `vencimiento ${fmtDay(fecha)}` });
      } else {
        flash(`${ic('alert')}<span><b>Vence pronto</b> · ${esc(item.producto)}<br>Vence el ${fmtDay(fecha)} (${dias} días).</span>`, 'warn');
        audit('Escaneó producto por vencer', { producto: item.producto, sku: item.sku || item.codigo || null, detalle: `vence ${fmtDay(fecha)} · ${dias} días` });
      }
    }
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

  // ---------- Cámara: lector ZXing-C++ (WebAssembly) incluido en vendor/zxing ----------
  // Lee EAN/UPC, Code 128/39/93, ITF, Codabar, GS1 DataBar, DataMatrix y QR en cualquier navegador
  // (también iPhone/iPad, que no traen lector propio) y funciona sin internet.
  const ZX_OPTS = { formats: ['EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39', 'Code93', 'ITF', 'Codabar', 'DataBar', 'DataBarExp', 'DataMatrix', 'QRCode'],
    tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 1, textMode: 'Plain' };
  let zxReady = null;
  function loadZXing() {
    if (zxReady) return zxReady;
    zxReady = new Promise((resolve, reject) => {
      const init = () => {
        try {
          ZXingWASM.prepareZXingModule({
            overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? new URL('vendor/zxing/' + path, location.href).href : prefix + path) },
            fireImmediately: true,
          }).then(resolve, reject);
        } catch (e) { reject(e); }
      };
      if (window.ZXingWASM) return init();
      const sc = document.createElement('script');
      sc.src = 'vendor/zxing/zxing-reader.js';
      sc.onload = init;
      sc.onerror = () => reject(new Error('No se pudo cargar el lector de códigos.'));
      document.head.appendChild(sc);
    }).catch((e) => { zxReady = null; throw e; });
    return zxReady;
  }
  async function decodeImage(src) {
    await loadZXing();
    const res = await ZXingWASM.readBarcodes(src, ZX_OPTS);
    const ok = res.find((r) => r.isValid && r.text);
    return ok ? { text: ok.text, formato: ok.format } : null;
  }
  // Todos los códigos de una imagen (para contar varias cajas con una sola foto).
  async function decodeAll(src) {
    await loadZXing();
    const res = await ZXingWASM.readBarcodes(src, { ...ZX_OPTS, maxNumberOfSymbols: 120 });
    return res.filter((r) => r.isValid && r.text).map((r) => ({ text: r.text, formato: r.format }));
  }
  // Para pruebas y diagnóstico.
  window.__zx = { decodeImage, loadZXing };

  let scanner = null, lastCode = '', lastTime = 0;
  $('#btnScan').onclick = () => (scanner ? stopScanner() : startScanner());
  $('#btnStopScan').onclick = () => stopScanner();

  // Un código cuenta una sola vez mientras siga a la vista: para sumar otra caja igual,
  // hay que sacarlo del recuadro (1 segundo sin verlo) y volver a mostrarlo.
  function onDecoded(text) {
    const now = Date.now();
    const same = text === lastCode && now - lastTime < 1000;
    lastCode = text; lastTime = now;
    if (!same) handleCode(text);
  }

  async function startScanner() {
    $('#scanner').hidden = false;
    $('#btnScan').innerHTML = ic('x') + ' Cerrar';
    $('#scanStatus').textContent = 'Abriendo la cámara…';
    const st = { stream: null, video: null, canvas: document.createElement('canvas'), paused: false, timer: 0, busy: false, track: null };
    scanner = st;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Este navegador no permite usar la cámara aquí (la página debe abrirse con https).');
      const [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } }),
        loadZXing(),
      ]);
      if (scanner !== st) { stream.getTracks().forEach((t) => t.stop()); return; }
      st.stream = stream;
      st.track = stream.getVideoTracks()[0];
      try { await st.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* sin enfoque continuo */ }
      const v = document.createElement('video');
      v.setAttribute('playsinline', ''); v.muted = true; v.srcObject = stream;
      $('#reader').innerHTML = '<div class="reader-frame"><span></span></div>';
      $('#reader').prepend(v);
      st.video = v;
      await v.play();
      try { $('#btnTorch').hidden = !(st.track.getCapabilities && st.track.getCapabilities().torch); } catch (e) { $('#btnTorch').hidden = true; }
      $('#scanStatus').textContent = 'Apunta al código de barras o DataMatrix dentro del recuadro…';
      const loop = async () => {
        if (scanner !== st) return;
        if (!st.paused && !st.busy && v.readyState >= 2 && v.videoWidth) {
          st.busy = true;
          try {
            // Se lee la zona del recuadro (80 % del ancho, 60 % del alto), reducida a 1280 px como máximo.
            const vw = v.videoWidth, vh = v.videoHeight;
            const cw = Math.round(vw * 0.8), ch = Math.round(vh * 0.6);
            const k = Math.min(1, 1280 / cw);
            st.canvas.width = Math.round(cw * k); st.canvas.height = Math.round(ch * k);
            const ctx = st.canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(v, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, st.canvas.width, st.canvas.height);
            const r = await decodeImage(ctx.getImageData(0, 0, st.canvas.width, st.canvas.height));
            if (r && scanner === st) onDecoded(r.text);
          } catch (e) { /* cuadro ilegible */ }
          st.busy = false;
        }
        st.timer = setTimeout(loop, 90);
      };
      loop();
    } catch (err) {
      await stopScanner();
      const r = await ask({ title: 'No se pudo abrir la cámara',
        html: `<p>${esc(err.message || String(err))}</p><p class="small muted">Revisa que el navegador tenga permiso de cámara. Mientras tanto, puedes <b>leer el código desde una foto</b> o escribirlo en el buscador.</p>`,
        buttons: [{ label: 'Cerrar', value: '' }, { label: 'Leer desde foto', value: 'foto', cls: 'primary' }] });
      if (r.value === 'foto') $('#fileScanPhoto').click();
    }
  }
  let torchOn = false;
  $('#btnTorch').onclick = async () => {
    try { torchOn = !torchOn; await scanner.track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { /* no soportado */ }
  };
  function pauseScanner(p) { if (scanner) scanner.paused = !!p; }
  async function stopScanner() {
    if (!scanner) return;
    const s = scanner;
    scanner = null;
    clearTimeout(s.timer);
    try { if (s.stream) s.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ya detenido */ }
    $('#reader').innerHTML = '';
    $('#scanner').hidden = true;
    $('#btnScan').innerHTML = ic('scan') + ' Escanear';
    $('#btnTorch').hidden = true;
    torchOn = false;
  }
  // Leer el código desde una foto (si la cámara en vivo no está disponible o el código cuesta).
  $('#fileScanPhoto').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    flash(`<span>Buscando códigos en la foto…</span>`, 'info');
    try {
      const codes = await decodeAll(f);
      if (!codes.length) { beep(false); return flash(`${ic('alert')}<span>No se encontró ningún código en la foto. Acércate, enfoca y que los códigos queden derechos y con buena luz.</span>`, 'err'); }
      if (codes.length === 1) { audit('Leyó código desde foto', { detalle: codes[0].formato }); return handleCode(codes[0].text); }
      await countFromPhoto(codes);
    } catch (err) { flash(`${ic('alert')}<span>${esc(err.message || 'No se pudo leer la foto.')}</span>`, 'err'); }
  };

  // Contar varias cajas con una foto: cada código visible es una caja.
  function itemForCode(raw) {
    const gs1 = GS1.parse(raw);
    const code = normCode(gs1 ? gs1.gtin : raw);
    let it = current.items.find((i) => (i.codigo && normCode(i.codigo) === code) || (i.sku && normCode(i.sku) === code));
    if (!it) { const cat = catalogFind(code); if (cat) it = current.items.find((i) => (i.sku && normCode(i.sku) === normCode(cat.sku)) || (i.codigo && cat.ean && normCode(i.codigo) === normCode(cat.ean))); }
    return { it, code };
  }
  async function countFromPhoto(codes) {
    const per = Math.max(1, parseNum($('#scanQty').value) || 1);
    const groups = new Map();
    for (const c of codes) {
      const { it, code } = itemForCode(c.text);
      const k = it ? 'i:' + it.producto : 'c:' + code;
      const g = groups.get(k) || { nombre: it ? it.producto : null, code, n: 0, raws: [] };
      g.n++; g.raws.push(c.text); groups.set(k, g);
    }
    const known = [...groups.values()].filter((g) => g.nombre), unknown = [...groups.values()].filter((g) => !g.nombre);
    const r = await ask({ title: `Se detectaron ${codes.length} códigos en la foto`,
      html: `<p class="small muted">Cada código visible cuenta como una caja${per > 1 ? ` de <b>${per}</b> unidades (Unidades por escaneo)` : ''}. Revisa que no falte ni sobre ninguna antes de sumar.</p>
        <ul class="foto-res">${known.map((g) => `<li><b>${esc(g.nombre)}</b><span>${g.n} ${g.n === 1 ? 'caja' : 'cajas'}${per > 1 ? ` · ${g.n * per} unid.` : ''}</span></li>`).join('')}
        ${unknown.map((g) => `<li class="otro"><span class="mono">${esc(g.code)}</span><span>${g.n} ${g.n === 1 ? 'caja' : 'cajas'} · no está en la lista (no se suma)</span></li>`).join('')}</ul>`,
      buttons: [{ label: 'Cancelar', value: '' }, ...(known.length ? [{ label: 'Sumar al conteo', value: 'ok', cls: 'primary' }] : [])] });
    if (r.value !== 'ok') return;
    for (const g of known) for (const raw of g.raws) await processCode(raw);
    audit('Contó desde foto', { detalle: known.map((g) => `${g.nombre}: ${g.n}`).join(' · ') + (unknown.length ? ` · ${unknown.reduce((s, g) => s + g.n, 0)} códigos fuera de la lista` : '') });
    flash(`${ic('check')}<span>Sumado desde la foto: ${known.map((g) => `${esc(g.nombre)} +${g.n * per}`).join(' · ')}</span>`, 'ok');
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
      const ahora = Date.now();
      const ult = (current.tramos || [])[(current.tramos || []).length - 1];
      if (ult && ahora - ult.fin <= PAUSA_MIN * 60000) ult.fin = ahora;
      current.finishedAt = ahora;
      current.contadoPor = (r.fields.por || '').trim();
      const tc = tiempoConteo(current);
      audit('Finalizó conteo', { detalle: `${current.items.filter((i) => qty(i) > 0).length} productos con cantidad · ${current.items.filter((i) => !qty(i)).length} sin contar · ${current.extras.length} agregados${tc ? ` · total ${fmtDur(tc.total)}, contando ${fmtDur(tc.activo)}, ${tc.pausas.length} pausa(s)` : ''}`, duracionSeg: tc ? Math.round(tc.total / 1000) : null });
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
  const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'menos de 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`; };

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
    // Hito del proceso: la primera vez que el QF abre el reporte de un conteo terminado.
    if (current.finishedAt && !current.revisionIni && !current.verifiedAt && role() === 'qf') {
      current.revisionIni = Date.now();
      audit('Inició la revisión del conteo');
      save();
    }
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
          <span class="kicker">${t.Doc} · ${esc(current.sucursal || 'Sucursal')}${current.fechaSistema ? ' · reporte al ' + esc(current.fechaSistema) : ''} · finalizado ${current.finishedAt ? fmtDate(current.finishedAt) : ''}${current.contadoPor ? ' · contó ' + esc(current.contadoPor) : ''} · ${dur}${current.reopened ? ` · reabierto ${current.reopened}×` : ''}</span>
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
      </div>
      ${procesoHtml(current)}
      ${tiempoHtml(current)}`;
    $('#btnApprove').hidden = !!current.verifiedAt;
    $('#btnRandom').hidden = !!current.verifiedAt;
  }

  // Tiempo del conteo: total, tiempo contando, pausas y cada tramo en una línea de tiempo.
  const hhmm = (ts) => new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
  function tiempoHtml(o) {
    const tc = tiempoConteo(o);
    if (!tc) return '';
    const span = Math.max(tc.total, 1);
    const pos = (ts) => ((ts - tc.ini) / span) * 100;
    const pausaTot = tc.pausas.reduce((s, x) => s + x, 0);
    const pasos = [];
    tc.tramos.forEach((x, i) => {
      if (i) pasos.push(`<li class="tl-pausa">${ic('clock')} Pausa de ${fmtDur(tc.pausas[i - 1])}</li>`);
      pasos.push(`<li><b>Tramo ${i + 1}</b> · ${hhmm(x.ini)}–${hhmm(x.fin)} · ${fmtDur(x.fin - x.ini)} <span class="muted">· ${(x.n || 0).toLocaleString('es-CL')} registros${x.por ? ' · ' + esc(x.por) : ''}</span></li>`);
    });
    return `<div class="card pad tiempo">
      <div class="tiempo-head"><h3 class="card-title">${ic('clock')} Tiempo del conteo</h3>
        <span class="muted small">Se considera pausa cuando pasan más de ${PAUSA_MIN} minutos sin registrar nada.</span></div>
      <div class="tiempo-kpis">
        <div><span>Inicio</span><b>${hhmm(tc.ini)}</b></div>
        <div><span>Fin</span><b>${hhmm(tc.fin)}</b></div>
        <div><span>Tiempo total</span><b>${fmtDur(tc.total)}</b></div>
        <div><span>Contando</span><b>${fmtDur(tc.activo)}</b></div>
        <div><span>Pausas</span><b>${tc.pausas.length}${tc.pausas.length ? ` <small>(${fmtDur(pausaTot)})</small>` : ''}</b></div>
      </div>
      <div class="timeline" aria-hidden="true">${tc.tramos.map((x) => `<span style="left:${pos(x.ini)}%;width:${Math.max(0.8, pos(x.fin) - pos(x.ini))}%"></span>`).join('')}</div>
      <ol class="tl-list">${pasos.join('')}</ol>
    </div>`;
  }

  // Tiempos del proceso completo: carga → conteo → revisión del QF → aprobación.
  function tiemposProceso(o) {
    const tc = tiempoConteo(o);
    const h = {
      cargado: o.creado || null,
      inicio: tc ? tc.ini : (o.startedAt || null),
      fin: o.finishedAt || null,
      revision: o.revisionIni || (o.verifiedAt ? o.finishedAt : null),
      aprobado: o.verifiedAt || null,
    };
    const d = (a, b) => (a && b && b >= a ? b - a : null);
    return { h, espera: d(h.cargado, h.inicio), conteo: d(h.inicio, h.fin), esperaRev: d(h.fin, h.revision),
      revision: d(h.revision, h.aprobado), total: d(h.cargado, h.aprobado) };
  }
  function procesoHtml(o) {
    const p = tiemposProceso(o);
    if (!p.h.cargado) return '';
    const dia = (ts) => new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit' }).format(ts).replace('/', '-');
    const hora = (ts) => ts ? (dia(ts) === dia(p.h.cargado) ? hhmm(ts) : `${dia(ts)} ${hhmm(ts)}`) : '';
    const hitos = [[o.tipo === 'inventario' ? 'PDF cargado' : 'Pedido cargado', p.h.cargado], ['Inicio del conteo', p.h.inicio], ['Fin del conteo', p.h.fin], ['Inicio revisión QF', p.h.revision], ['Aprobado', p.h.aprobado]];
    const tramos = [['Espera antes de contar', p.espera], ['Conteo', p.conteo], ['Espera de revisión', p.esperaRev], ['Revisión del QF', p.revision]];
    const vivo = (i) => hitos[i][1] && !hitos[i + 1][1];
    const total = p.total !== null ? fmtDur(p.total) : `${fmtDur(Date.now() - p.h.cargado)} hasta ahora`;
    const cierre = `<div class="cierre">
        <div><span>Inicio del ${esc(T(o).doc)}</span><b>${p.h.inicio ? fmtDate(p.h.inicio) : 'Aún no se empieza a contar'}</b></div>
        <div><span>Término</span><b>${p.h.aprobado ? fmtDate(p.h.aprobado) : p.h.fin ? 'En revisión del QF' : 'En curso'}</b></div>
        <div><span>Cerrado por</span><b>${o.verifiedBy ? esc(o.verifiedBy) : '—'}</b></div>
      </div>
      ${o.obsCierre ? `<div class="obs-cierre"><span>Observación general del cierre</span><p>${esc(o.obsCierre)}</p></div>` : ''}`;
    return `<div class="card pad proceso">
      ${cierre}
      <div class="tiempo-head"><h3 class="card-title">${ic('history')} Tiempos del proceso</h3>
        <span class="proceso-total">Total: <b>${total}</b></span></div>
      <ol class="proceso-line">${hitos.map(([n, ts], i) => `
        <li class="hito ${ts ? 'ok' : ''}"><span class="dot"></span><b>${n}</b><span class="muted">${ts ? hora(ts) : 'pendiente'}</span></li>
        ${i < tramos.length ? `<li class="tramo ${tramos[i][1] !== null ? '' : vivo(i) ? 'vivo' : 'nada'}"><span>${tramos[i][0]}</span><b>${tramos[i][1] !== null ? fmtDur(tramos[i][1]) : vivo(i) ? 'en curso' : '—'}</b></li>` : ''}`).join('')}
      </ol>
      ${o.reopened ? `<p class="small muted" style="margin:0">El conteo se reabrió ${o.reopened} vez(es): las horas son las del último cierre.</p>` : ''}
    </div>`;
  }

  let resultsLimit = { sig: '', n: 100 };
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
    list.sort((a, b) => rank[a.abc] - rank[b.abc] || key(b) - key(a) || COLLATOR.compare(a.producto, b.producto));
    if (!list.length) {
      const msg = q ? `No hay productos que coincidan con “${esc($('#reportSearch').value)}”.`
        : f === 'pend' ? 'No quedan desviaciones pendientes de revisión.' : f === 'muestra' ? 'Aún no hay revisión aleatoria. Usa el botón Revisión aleatoria.'
          : f ? 'No hay productos en esta vista.' : 'Todo correcto: ' + T(current).ok + '.';
      $('#resultsTable').innerHTML = `<div class="card good-msg">${ic('check')} ${msg}</div>`;
      return;
    }
    const t = T(current);
    const locked = !!current.verifiedAt;
    // Se dibujan 100 filas y se agregan más a pedido (con 1.000+ desviaciones la tablet no se traba).
    const sig = f + '|' + q + '|' + current.id;
    if (sig !== resultsLimit.sig) resultsLimit = { sig, n: 100 };
    const shown = list.slice(0, resultsLimit.n);
    $('#resultsTable').innerHTML = `<div class="card"><div class="table-wrap"><table class="results">
      <thead><tr><th>Clase</th><th>Producto</th><th class="num">${t.debia}</th><th class="num">Contado</th><th class="num">Dif.</th><th class="num">Valor</th><th>Revisión QF</th></tr></thead>
      <tbody>${shown.map((r) => {
        const rv = r.review;
        const revTxt = rv ? (rv.decision === 'corregida' ? `Corregida a ${rv.cantidad}` : 'Cantidad correcta') : '';
        return `<tr data-rid="${r.id}" class="${rv ? 'verified' : ''}">
        <td data-label="Clase">${r.abc ? `<span class="abc ${r.abc}">${r.abc}</span>` : ''}</td>
        <td data-label="Producto" class="c-prod"><b>${esc(r.producto)}</b><div class="sub">${[r.sku && `<span class="mono">${esc(r.sku)}</span>`, r.codigo && `<span class="mono">${esc(r.codigo)}</span>`, r.lote && `Lote <span class="mono">${esc(r.lote)}</span>`, r.categoria && esc(r.categoria)].filter(Boolean).join(' · ')}</div>
          <div class="state-cell" style="margin-top:6px"><span class="pill ${r.dif === 0 ? 'ok' : r.dif < 0 ? 'bad' : 'warn'}">${esc(r.estado)}</span>${r.muestra ? '<span class="pill sample">Aleatoria</span>' : ''}${vencPill(r.id)}</div>${evHtml(r.id)}</td>
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
      ${list.length > shown.length ? `<p class="small muted center" style="padding:10px 14px;margin:0">Mostrando ${shown.length.toLocaleString('es-CL')} de ${list.length.toLocaleString('es-CL')} · <button class="btn sm ghost" type="button" data-more-res>Mostrar ${Math.min(200, list.length - shown.length)} más</button></p>` : ''}</div>`;
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
    if (e.target.closest('[data-more-res]')) { resultsLimit.n += 200; return renderResultsTable(); }
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
    // Cierre: la QF deja una observación general (obligatoria; puede ser "Sin observaciones").
    let obs = '', falta = false, r;
    for (;;) {
      r = await ask({ title: `Cerrar y aprobar ${T(current).doc}`,
        html: `<p>Todas las desviaciones están revisadas. Al aprobar, el reporte queda cerrado con las cantidades finales y a nombre de <b>${esc(me.nombre)}</b>.</p>
          <label>Observación general del cierre<textarea name="obsCierre" rows="3" maxlength="1000" placeholder="Ej: Se encontraron 2 cajas en bodega trasera; se informa a la central. Si no hay nada que destacar, escribe: Sin observaciones.">${esc(obs)}</textarea></label>
          ${falta ? '<p class="small" style="color:var(--bad);margin:0">Escribe una observación general para cerrar.</p>' : ''}`,
        buttons: [{ label: 'Cancelar', value: '' }, { label: 'Aprobar y cerrar', value: 'ok', cls: 'primary' }] });
      if (r.value !== 'ok') return;
      obs = (r.fields.obsCierre || '').trim().slice(0, 1000);
      if (obs.length >= 3) break;
      falta = true;
    }
    current.verifiedAt = Date.now();
    current.verifiedBy = me.nombre;
    current.obsCierre = obs;
    save();
    audit(`Aprobó ${T(current).doc}`, { detalle: `${rows.filter((x) => x.review).length} productos revisados · obs: ${obs.slice(0, 200)}` });
    renderSummary();
    renderResultsTable();
  };
  $('#btnDocLog').onclick = () => renderLog({ docId: current.id });

  function vencPill(id) {
    const f = (current.venc || {})[id];
    if (!f) return '';
    const d = daysTo(f);
    return d < 0 ? `<span class="pill bad">Vencido ${fmtDay(f)}</span>` : `<span class="pill warn">Vence ${fmtDay(f)}</span>`;
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
        'Vencimiento leído': (current.venc || {})[r.id] ? fmtDay(current.venc[r.id]) : '',
        'Motivo (conteo)': ev?.motivo || '', 'Nota (conteo)': ev?.nota || '', 'Fotos': ev?.fotos.length || 0 }));
    });
  }
  $('#btnExportXlsx').onclick = () => {
    const ws = XLSX.utils.json_to_sheet(exportRows());
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Diferencias');
    const info = [[T(current).Doc, safeCell(current.nombre)], ['Sucursal', current.sucursal || ''], ...(current.fechaSistema ? [['Reporte al', current.fechaSistema]] : []), ['Contado por', current.contadoPor || ''],
      ['Inicio conteo', current.startedAt ? fmtDate(current.startedAt) : ''], ['Cierre', current.finishedAt ? fmtDate(current.finishedAt) : ''],
      ...((pr) => [['Inicio del ' + T(current).doc, pr.h.inicio ? fmtDate(pr.h.inicio) : ''], ['Término', pr.h.aprobado ? fmtDate(pr.h.aprobado) : ''],
        ['Observación general del cierre', safeCell(current.obsCierre || '')]])(tiemposProceso(current)),
      ...((pr) => [[current.tipo === 'inventario' ? 'PDF cargado' : 'Pedido cargado', pr.h.cargado ? fmtDate(pr.h.cargado) : ''], ['Espera antes de contar', pr.espera !== null ? fmtDur(pr.espera) : ''],
        ['Inicio revisión QF', pr.h.revision ? fmtDate(pr.h.revision) : ''], ['Espera de revisión', pr.esperaRev !== null ? fmtDur(pr.esperaRev) : ''],
        ['Revisión del QF', pr.revision !== null ? fmtDur(pr.revision) : ''], ['Tiempo total del proceso', pr.total !== null ? fmtDur(pr.total) : '']])(tiemposProceso(current)),
      ...((tc) => tc ? [['Tiempo total', fmtDur(tc.total)], ['Tiempo contando', fmtDur(tc.activo)], ['Pausas', tc.pausas.length], ['Tiempo en pausa', fmtDur(tc.pausas.reduce((s, x) => s + x, 0))]] : [])(tiempoConteo(current)),
      ['Veces reabierto', current.reopened || 0], ['Aprobado por', current.verifiedBy || ''], ['Aprobado el', current.verifiedAt ? fmtDate(current.verifiedAt) : '']];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(info), 'Resumen');
    const tc = tiempoConteo(current);
    if (tc) {
      const filas = [];
      tc.tramos.forEach((x, i) => {
        if (i) filas.push({ Tipo: 'Pausa', Desde: hhmm(tc.tramos[i - 1].fin), Hasta: hhmm(x.ini), Minutos: Math.round(tc.pausas[i - 1] / 60000), Registros: '', Quién: '' });
        filas.push({ Tipo: 'Tramo ' + (i + 1), Desde: hhmm(x.ini), Hasta: hhmm(x.fin), Minutos: Math.round((x.fin - x.ini) / 60000), Registros: x.n || 0, Quién: safeCell(x.por || '') });
      });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filas), 'Tiempo del conteo');
    }
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
        const blob = await getPhoto(fid);
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
    const setup = SERVER ? !(serverInfo && serverInfo.configurado) : !users.length;
    show('login');
    $('#loginTitle').textContent = setup ? 'Configurar la app' : 'Iniciar sesión';
    $('#loginSub').textContent = setup ? 'Crea el usuario administrador. Con él podrás crear los usuarios de cada sucursal.' : 'Ingresa con tu usuario y contraseña.';
    $('#setupFields').hidden = !setup;
    $('#setupFields2').hidden = !setup;
    $('#setupImport').hidden = !setup || SERVER;
    $('#btnLoginText').textContent = setup ? 'Crear administrador y entrar' : 'Entrar';
    $('#loginPass').autocomplete = setup ? 'new-password' : 'current-password';
    $('#loginError').hidden = true;
    $('#loginForm').reset();
    $('#loginDemo').hidden = !window.REVISION_DEMO;
    $('#loginDemo').innerHTML = `<span class="demo-title">Entrar con un toque (demo)</span>
      <span class="demo-btns">${DEMO_USERS.map(([nombre, usuario, , rol]) => `<button type="button" class="btn ${rol === 'auxiliar' ? 'primary' : ''}" data-demo="${usuario}">${ic(rol === 'admin' ? 'shield' : rol === 'qf' ? 'check' : 'scan')} ${esc(nombre)}</button>`).join('')}</span>
      <span class="small muted">Trae un inventario y un pedido de ejemplo listos para contar.</span>`;
    setTimeout(() => (setup ? $('#setupNombre') : $('#loginUser')).focus(), 50);
  }
  function loginError(msg) { const e = $('#loginError'); e.textContent = msg; e.hidden = false; }

  // Demo: entrar con un toque como Administrador, QF o Auxiliar.
  const DEMO_USERS = [['Administrador', 'admin', 'admin123', 'admin'], ['QF', 'qf', 'qf123', 'qf'], ['Auxiliar', 'auxiliar', 'aux1234', 'auxiliar']];
  $('#loginDemo').addEventListener('click', (e) => {
    const b = e.target.closest('[data-demo]');
    const d = b && DEMO_USERS.find((x) => x[1] === b.dataset.demo);
    if (!d) return;
    $('#loginUser').value = d[1]; $('#loginPass').value = d[2];
    $('#loginForm').requestSubmit();
  });
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const usuario = $('#loginUser').value.trim().toLowerCase();
    const pass = $('#loginPass').value;
    const btn = $('#btnLogin');
    btn.disabled = true;
    try {
      if (SERVER) {
        // Con servidor: el servidor valida la contraseña, bloquea intentos y registra la bitácora.
        if (!(serverInfo && serverInfo.configurado)) {
          if (pass !== $('#setupPass2').value) return loginError('Las contraseñas no coinciden.');
          const r = await api('setup.php', { method: 'POST', body: { nombre: $('#setupNombre').value.trim(), usuario, clave: pass } });
          serverInfo.configurado = true;
          return afterLogin(r.usuario);
        }
        const r = await api('login.php', { method: 'POST', body: { usuario, clave: pass } });
        return afterLogin(r.usuario);
      }
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
      if (SERVER) { flushSyncs().then(flushAudit).finally(() => api('logout.php', { method: 'POST' }).catch(() => {})); }
      showLogin();
      loginError('Tu sesión se cerró por inactividad. Vuelve a entrar.');
    }
  }, 30000);

  async function afterLogin(u, restored = false) {
    lastActivity = Date.now();
    setSession(u);
    audit(restored ? 'Retomó sesión abierta' : 'Inicio de sesión');
    if (SERVER) {
      try { await loadServerData(); flushAudit(); }
      catch (e) { if (e.status === 401) return; info('No se pudo cargar', esc(e.message)); }
    }
    if (!checkHash()) renderHome();
  }

  // ---------- Menú de usuario ----------
  $('#btnUser').onclick = async () => {
    if (!me) return;
    const opts = [
      ...(isAdmin() ? [['users', 'users', 'Usuarios'], ['catalog', 'list', 'Maestro de productos']] : []),
      ...(isStaff() ? [['log', 'history', 'Bitácora']] : []),
      ...(isAdmin() && !SERVER ? [['export', 'download', 'Exportar configuración'], ['import', 'upload', 'Importar configuración']] : []),
      ['pass', 'lock', 'Cambiar mi contraseña'], ['privacy', 'shield', 'Privacidad y mis datos'], ['logout', 'logout', 'Cerrar sesión'],
    ];
    const r = await ask({ title: 'Mi cuenta',
      html: `<div class="menu-who"><span class="avatar">${esc(initials(me.nombre))}</span><div><b>${esc(me.nombre)}</b><div class="small muted">${esc(me.usuario)} · ${rolName(me.rol)}${me.sucursal ? ' · ' + esc(me.sucursal) : ''}</div></div></div>
        <div class="menu-list">${opts.map(([v, i, l]) => `<button class="btn" value="${v}">${ic(i)} ${l}</button>`).join('')}</div>`,
      buttons: [{ label: 'Cerrar', value: '' }] });
    if (r.value === 'logout') {
      closeViewTimer();
      audit('Cierre de sesión');
      if (SERVER) { await flushSyncs(); await flushAudit(); try { await api('logout.php', { method: 'POST' }); await refreshCsrf(); } catch (e) { /* ya sin sesión */ } }
      showLogin();
    }
    else if (r.value === 'users') renderUsers();
    else if (r.value === 'log') renderLog();
    else if (r.value === 'privacy') showPrivacy();
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
    if (SERVER) {
      if (f.nueva !== f.nueva2) return info('No se cambió', 'Las contraseñas no coinciden.');
      try {
        if (byAdmin) await api('usuarios.php?id=' + encodeURIComponent(u.id), { method: 'PUT', body: { clave: f.nueva } });
        else await api('clave.php', { method: 'POST', body: { actual: f.actual, nueva: f.nueva } });
      } catch (e) { return info('No se cambió', esc(e.message)); }
      return info('Contraseña actualizada', byAdmin ? `${esc(u.nombre)} ya puede entrar con la nueva contraseña.` : 'Usa la nueva contraseña la próxima vez que entres.');
    }
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
  async function renderUsers() {
    if (!isAdmin()) return renderHome();
    if (SERVER) {
      try { users = (await api('usuarios.php')).usuarios; }
      catch (e) { return info('No se pudo cargar', esc(e.message)); }
    }
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
          <button class="btn sm ghost" data-uact="data">${ic('download')} Datos</button>
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
    else if (b.dataset.uact === 'data') exportUserData(u);
    else if (b.dataset.uact === 'del') deleteUser(u);
  });
  async function editUser(u) {
    const r = await ask({ title: u ? 'Editar usuario' : 'Nuevo usuario',
      html: `<label>Nombre completo<input name="nombre" value="${esc(u ? u.nombre : '')}"></label>
        <label>Usuario (para entrar)<input name="usuario" value="${esc(u ? u.usuario : '')}" autocapitalize="none" spellcheck="false"></label>
        <label>Rol<select name="rol">
          <option value="auxiliar" ${!u || u.rol === 'auxiliar' ? 'selected' : ''}>Auxiliar: solo digita cantidades</option>
          <option value="qf" ${u && u.rol === 'qf' ? 'selected' : ''}>QF: carga el inventario, revisa y aprueba</option>
          <option value="admin" ${u && u.rol === 'admin' ? 'selected' : ''}>Administrador: configura y carga pedidos</option></select></label>
        <label>Sucursal (opcional)<input name="sucursal" value="${esc(u ? u.sucursal : '')}" placeholder="Ej: CL0099 CENTRO"></label>
        ${u ? '' : '<label>Contraseña inicial<input name="pass" type="password" autocomplete="new-password"></label>'}`,
      buttons: [{ label: 'Cancelar', value: '' }, { label: 'Guardar', value: 'ok', cls: 'primary' }] });
    if (r.value !== 'ok') return;
    const f = r.fields;
    const usuario = f.usuario.trim().toLowerCase();
    if (!f.nombre.trim() || !usuario) return info('No se guardó', 'Completa el nombre y el usuario.');
    if (!/^[a-z0-9._\-@]+$/.test(usuario)) return info('No se guardó', 'El usuario solo puede tener letras sin tilde, números, punto, guion o @.');
    if (users.some((x) => x.usuario === usuario && x !== u)) return info('No se guardó', `Ya existe el usuario <b>${esc(usuario)}</b>.`);
    if (SERVER) {
      const body = { nombre: f.nombre.trim(), usuario, rol: f.rol, sucursal: f.sucursal.trim() };
      try {
        if (u) await api('usuarios.php?id=' + encodeURIComponent(u.id), { method: 'PUT', body });
        else await api('usuarios.php', { method: 'POST', body: { ...body, clave: f.pass || '' } });
      } catch (e) { return info('No se guardó', esc(e.message)); }
      if (u && u.id === me.id) setSession({ ...me, ...body });
      return renderUsers();
    }
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
    if (SERVER) {
      try { await api('usuarios.php?id=' + encodeURIComponent(u.id), { method: 'DELETE' }); }
      catch (e) { return info('No se eliminó', esc(e.message)); }
      return renderUsers();
    }
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
    if (SERVER) {
      api('catalogo.php', { method: 'PUT', body: { catalogo: c } }).catch((e) => info('No se guardó el maestro', esc(e.message)));
      return;
    }
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
  // NUEVO INVENTARIO (desde el reporte de inventario de SPOS)
  // =========================================================
  let invDraft = null;
  $('#btnNewInventory').onclick = () => {
    if (!isStaff()) return;
    invDraft = null;
    show('inv', 'Nuevo inventario');
    $('#invStatus').hidden = true;
    $('#invPreview').innerHTML = (catalog.items || []).length ? ''
      : `<div class="load-status warn">${ic('alert')}<span>Aún no cargas el <b>maestro de productos</b>. Sin él no se puede escanear por código de barras; solo buscar por nombre o código. ${isAdmin() ? 'Cárgalo desde el menú de usuario → Maestro de productos.' : 'Pídele al administrador que lo cargue.'}</span></div>`;
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
      if (!rep.items.length) throw new Error('No encontré productos en el reporte. Revisa que sea el reporte de inventario de SPOS.');
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
          <label class="field">Sucursal<input id="invSucursal" value="${esc(d.sucursal)}" placeholder="Ej: CL0099 CENTRO"></label>
          <label class="field">Fecha del reporte<input id="invFecha" value="${esc(d.fecha)}" placeholder="dd/mm/aaaa"></label>
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
  $('#btnSaveInventory').onclick = async () => {
    if (!invDraft) return;
    const sucursal = $('#invSucursal').value.trim() || (me && me.sucursal) || '';
    const fecha = $('#invFecha').value.trim();
    if (!isAdmin() && me.sucursal && !sameBranch(sucursal, me.sucursal))
      return info('Reporte de otra sucursal', `Este reporte es de <b>${esc(sucursal)}</b> y tú estás asignada a <b>${esc(me.sucursal)}</b>. Revisa que descargaste de SPOS el reporte de tu sucursal.`);
    const o = newOrder({
      tipo: 'inventario',
      nombre: `Inventario ${sucursal || ''} ${fecha || new Date().toLocaleDateString('es')}`.replace(/\s+/g, ' ').trim(),
      sucursal, fechaSistema: fecha,
      items: invDraft.items.map((i) => ({ id: uid(), sku: i.sku, codigo: i.ean || '', producto: i.producto, categoria: i.categoria, cantidad: i.cantidad, lote: '', precio: 0, vencimiento: '' })),
    });
    let saved;
    try { saved = await persistNewDoc(o); } catch (e) { return info('No se pudo crear', esc(e.message)); }
    audit('Creó inventario', { docId: saved.id, doc: saved.nombre, sucursal: saved.sucursal || null, detalle: `${saved.items.length} productos · ${invDraft.archivo || ''}` });
    invDraft = null;
    openOrder(saved.id);
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
    if (SERVER) {
      // Con servidor: filtros, totales y páginas los resuelve el servidor.
      await flushAudit();
      try {
        const o = await api('bitacora.php?opciones=1');
        const fill = (sel, label, pairs) => { sel.innerHTML = `<option value="">${label}</option>` + pairs.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join(''); };
        fill($('#logUser'), 'Todos los usuarios', o.usuarios.map((x) => [x.usuario, x.nombre ? `${x.nombre} (${x.usuario})` : x.usuario]));
        fill($('#logAction'), 'Todas las acciones', o.acciones.map((x) => [x, x]));
        const docs = o.documentos.map((x) => [x.doc_id, x.doc || x.doc_id]);
        if (fromDoc && !docs.some(([id]) => id === fromDoc.id)) docs.unshift([fromDoc.id, fromDoc.nombre]);
        fill($('#logDoc'), 'Todos los documentos', docs);
      } catch (e) { return info('No se pudo cargar la bitácora', esc(e.message)); }
      $('#logUser').value = ''; $('#logAction').value = ''; $('#logDoc').value = filter.docId || '';
      $('#logFrom').value = ''; $('#logTo').value = ''; $('#logText').value = '';
      return loadLogPage(true);
    } else logRows = (await Bitacora.all()).reverse();
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
  const mapLogRow = (x) => ({ n: +x.n, ts: +x.ts_ms, usuarioId: x.usuario_id, usuario: x.usuario, nombre: x.nombre, rol: x.rol, accion: x.accion,
    docId: x.doc_id, doc: x.doc, sucursal: x.sucursal, producto: x.producto, sku: x.sku, detalle: x.detalle,
    duracionSeg: x.duracion_seg == null ? null : +x.duracion_seg, resultado: x.resultado, equipo: x.equipo, ip: x.ip, hash: x.hash });
  function logQuery(extra = {}) {
    const p = new URLSearchParams();
    const add = (k, v) => { if (v) p.set(k, v); };
    add('usuario', $('#logUser').value); add('accion', $('#logAction').value); add('doc', $('#logDoc').value);
    add('desde', $('#logFrom').value); add('hasta', $('#logTo').value); add('texto', $('#logText').value.trim());
    Object.entries(extra).forEach(([k, v]) => add(k, v));
    return 'bitacora.php?' + p.toString();
  }
  let logStats = null, logMore = false;
  async function loadLogPage(reset) {
    try {
      const last = logRows.length ? logRows[logRows.length - 1].n : 0;
      const r = await api(logQuery(reset ? { limite: 200 } : { limite: 200, antes_de: last }));
      const rows = r.registros.map(mapLogRow);
      logRows = reset ? rows : logRows.concat(rows);
      if (r.stats) logStats = r.stats;
      logMore = rows.length === 200;
    } catch (e) { if (reset) logRows = []; info('No se pudo cargar la bitácora', esc(e.message)); }
    renderLogList();
  }
  let logTextTimer;
  function filteredLog() {
    if (SERVER) return logRows;
    const u = $('#logUser').value, a = $('#logAction').value, d = $('#logDoc').value;
    const from = $('#logFrom').value, to = $('#logTo').value, q = normText($('#logText').value);
    return logRows.filter((r) => (!u || r.usuario === u) && (!a || r.accion === a) && (!d || r.docId === d)
      && (!from || dayKey(r.ts) >= from) && (!to || dayKey(r.ts) <= to)
      && (!q || normText(`${r.producto || ''} ${r.sku || ''} ${r.detalle || ''} ${r.doc || ''} ${r.nombre || ''} ${r.accion}`).includes(q)));
  }
  function renderLogList() {
    const list = filteredLog();
    let st;
    if (SERVER && logStats) {
      st = { n: +logStats.registros, total: +logStats.total, people: +logStats.usuarios, reviews: +logStats.revisiones || 0, avg: logStats.seg_revision == null ? null : Math.round(+logStats.seg_revision), denied: +logStats.denegados || 0 };
    } else {
      const reviews = list.filter((r) => /Revisó producto|Modificó revisión/.test(r.accion));
      st = { n: list.length, total: logRows.length, people: new Set(list.map((r) => r.usuario).filter(Boolean)).size, reviews: reviews.length,
        avg: reviews.length ? Math.round(reviews.reduce((s, r) => s + (r.duracionSeg || 0), 0) / reviews.length) : null, denied: list.filter((r) => r.resultado === 'denegado').length };
    }
    $('#logStats').innerHTML = `
      <div class="kpi"><div class="l">Registros</div><div class="v">${st.n.toLocaleString('es-CL')}</div><div class="s">de ${st.total.toLocaleString('es-CL')} en total</div></div>
      <div class="kpi"><div class="l">Usuarios</div><div class="v">${st.people}</div><div class="s">con actividad en el filtro</div></div>
      <div class="kpi"><div class="l">Productos revisados</div><div class="v">${st.reviews.toLocaleString('es-CL')}</div><div class="s">${st.reviews ? 'promedio ' + fmtSecs(st.avg) + ' por producto' : 'sin revisiones'}</div></div>
      <div class="kpi ${st.denied ? 'bad' : ''}"><div class="l">Accesos denegados</div><div class="v">${st.denied}</div><div class="s">intentos fallidos o sin permiso</div></div>`;
    if (!list.length) { $('#logList').innerHTML = '<div class="empty">No hay registros con estos filtros.</div>'; return; }
    const shown = SERVER ? list : list.slice(0, logLimit);
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
      ${SERVER ? (logMore ? `<div class="actions" style="justify-content:center;padding:12px"><button class="btn" id="btnLogMore">Mostrar 200 más (quedan ${(st.n - list.length).toLocaleString('es-CL')})</button></div>` : '')
        : list.length > shown.length ? `<div class="actions" style="justify-content:center;padding:12px"><button class="btn" id="btnLogMore">Mostrar 200 más (quedan ${(list.length - shown.length).toLocaleString('es-CL')})</button></div>` : ''}`;
    const more = $('#btnLogMore');
    if (more) more.onclick = () => { if (SERVER) loadLogPage(false); else { logLimit += 200; renderLogList(); } };
  }
  ['logUser', 'logAction', 'logDoc', 'logFrom', 'logTo'].forEach((id) => { $('#' + id).onchange = () => { logLimit = 200; if (SERVER) loadLogPage(true); else renderLogList(); }; });
  $('#logText').oninput = () => {
    logLimit = 200;
    if (!SERVER) return renderLogList();
    clearTimeout(logTextTimer);
    logTextTimer = setTimeout(() => loadLogPage(true), 300);
  };
  $('#btnLogVerify').onclick = async () => {
    const st = $('#logStatus');
    st.className = 'load-status busy'; st.hidden = false;
    st.innerHTML = '<span class="spinner"></span><span>Verificando la cadena de registros…</span>';
    let r;
    if (SERVER) {
      try { const v = await api('bitacora.php?verificar=1'); r = { ok: v.integra, total: v.total, motivo: v.motivo, malo: v.ts ? { ts: v.ts } : null }; }
      catch (e) { r = { ok: false, total: 0, motivo: e.message }; }
    } else r = await Bitacora.verify();
    audit('Verificó integridad de la bitácora', { resultado: r.ok ? 'ok' : 'error', detalle: r.ok ? `${r.total} registros íntegros` : r.motivo });
    st.className = 'load-status ' + (r.ok ? 'ok' : 'err');
    st.innerHTML = r.ok ? `${ic('check')}<span>Bitácora íntegra: ${r.total.toLocaleString('es-CL')} registros sin alteraciones.</span>`
      : `${ic('alert')}<span><b>Se detectó una alteración:</b> ${esc(r.motivo)}${r.malo ? ` (registro del ${fmtDate(r.malo.ts, true)})` : ''}.</span>`;
  };
  $('#btnLogExport').onclick = async () => {
    let list = filteredLog();
    if (SERVER) {
      try { list = (await api(logQuery({ limite: 50000, exportar: 1 }))).registros.map(mapLogRow); }
      catch (e) { return info('No se pudo exportar', esc(e.message)); }
    }
    const rows = list.map((r) => ({ 'N°': r.n || r.id, 'Fecha y hora (Santiago)': fmtDate(r.ts, true), 'Usuario': r.usuario || '', 'Nombre': r.nombre || '', 'Rol': r.rol ? rolName(r.rol) : '',
      'Acción': r.accion, 'Resultado': r.resultado || '', 'Documento': r.doc || '', 'Sucursal': r.sucursal || '', 'Producto': r.producto || '', 'Código': r.sku || '',
      'Detalle': r.detalle || '', 'Tiempo (s)': r.duracionSeg ?? '', 'Equipo': r.equipo || '', ...(SERVER ? { 'IP': r.ip || '' } : {}), 'Hash': r.hash || '' })).map(safeRow);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Bitácora');
    XLSX.writeFile(wb, `bitacora-${dayKey(Date.now())}.xlsx`);
    if (!SERVER) audit('Exportó la bitácora', { detalle: `${rows.length} registros` });
  };

  // =========================================================
  // PRIVACIDAD (Ley 19.628 modificada por la Ley 21.719)
  // =========================================================
  const CONSERVACION = '2 años desde el registro, salvo que la ley o un proceso en curso exija conservarlos más tiempo';
  function showPrivacy() {
    if (me) audit('Leyó la política de privacidad');
    ask({ title: 'Política de privacidad',
      html: `<div class="privacy-doc">
        <p class="small muted">Plantilla preparada para el responsable del tratamiento. <b>Debe revisarla un abogado</b> y completar los datos de contacto antes de usarla en producción.</p>
        <h4>Quién es responsable</h4>
        <p>El empleador que usa esta app (por ejemplo, la cadena de farmacias) es el responsable de los datos. Contacto para ejercer derechos: <b>[completar correo o área responsable]</b>.</p>
        <h4>Qué datos se registran</h4>
        <ul>
          <li>De cada usuario: nombre, usuario, rol y sucursal. La contraseña se guarda cifrada y nadie puede verla.</li>
          <li>Actividad en la app (bitácora): inicios y cierres de sesión, documentos abiertos, cantidades registradas, revisiones y su tiempo, revisiones aleatorias, exportaciones y cambios de administración, con fecha, hora y equipo${SERVER ? ', y la dirección IP' : ''}.</li>
          <li>Fotos de evidencia de productos, cuando el usuario las toma.</li>
        </ul>
        <p>No se registran datos sensibles (salud, biometría ni datos bancarios).</p>
        <h4>Para qué se usan</h4>
        <p>Únicamente para controlar la recepción de pedidos y los inventarios de las sucursales, revisar diferencias y mantener trazabilidad de quién hizo cada registro.</p>
        <h4>Quién puede verlos</h4>
        <p>La bitácora solo la ven los administradores y los químicos farmacéuticos (QF). Los auxiliares no ven la actividad de otros.</p>
        <h4>Dónde se guardan y por cuánto tiempo</h4>
        <p>${SERVER ? 'En el servidor central de la empresa (Google Cloud), con acceso restringido y respaldos.' : 'En este equipo (navegador).'} Plazo de conservación: ${CONSERVACION}.</p>
        <h4>Tus derechos</h4>
        <p>Puedes pedir acceso a tus datos, su rectificación, supresión, oposición, portabilidad o bloqueo. El administrador puede exportar todos tus datos desde Usuarios → Datos. Los registros de la bitácora no se modifican, porque son prueba de lo ocurrido; si algo es incorrecto, se deja constancia con un registro nuevo.</p>
      </div>`,
      buttons: [{ label: 'Cerrar', value: '', cls: 'primary' }] });
  }
  $('#btnPrivacyLogin').onclick = () => showPrivacy();

  // Acceso y portabilidad: exporta en Excel los datos de un usuario y toda su actividad.
  async function exportUserData(u) {
    let rows;
    if (SERVER) {
      try { rows = (await api('bitacora.php?limite=50000&exportar=1&usuario_id=' + encodeURIComponent(u.id))).registros.map((x) => ({ ts: +x.ts_ms, accion: x.accion, doc: x.doc, sucursal: x.sucursal, producto: x.producto, sku: x.sku, detalle: x.detalle, duracionSeg: x.duracion_seg, resultado: x.resultado, equipo: x.equipo, ip: x.ip })); }
      catch (e) { return info('No se pudo exportar', esc(e.message)); }
    } else rows = (await Bitacora.all()).filter((x) => x.usuarioId === u.id || x.usuario === u.usuario);
    const perfil = [['Nombre', u.nombre], ['Usuario', u.usuario], ['Rol', rolName(u.rol)], ['Sucursal', u.sucursal || ''], ['Exportado el', fmtDate(Date.now(), true)], ['Exportado por', me.nombre]].map(([k, v]) => [k, safeCell(v)]);
    const act = rows.map((r) => safeRow({ 'Fecha y hora (Santiago)': fmtDate(r.ts, true), 'Acción': r.accion, 'Documento': r.doc || '', 'Sucursal': r.sucursal || '', 'Producto': r.producto || '',
      'Código': r.sku || '', 'Detalle': r.detalle || '', 'Tiempo (s)': r.duracionSeg ?? '', 'Resultado': r.resultado || '', 'Equipo': r.equipo || '', ...(SERVER ? { 'IP': r.ip || '' } : {}) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(perfil), 'Datos del usuario');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(act.length ? act : [{ 'Actividad': 'Sin registros' }]), 'Actividad');
    XLSX.writeFile(wb, `datos-${safeName(u.usuario)}-${dayKey(Date.now())}.xlsx`);
    audit('Exportó datos personales de un usuario', { detalle: `${u.usuario} · ${rows.length} registros` });
  }

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
    // ¿Hay servidor? Entonces usuarios, documentos y bitácora viven allá.
    serverInfo = await detectServer();
    if (serverInfo) {
      SERVER = true;
      document.body.classList.add('mode-server');
      try {
        const s = await refreshCsrf();
        if (s.usuario) { afterLogin(s.usuario, true); return; }
      } catch (e) { /* sin sesión */ }
      showLogin();
      return;
    }
    // Demo: usuarios de prueba para entrar sin configurar nada.
    if (window.REVISION_DEMO) {
      for (const [nombre, usuario, pass, rol] of DEMO_USERS) {
        if (!users.some((u) => u.usuario === usuario)) users.push(await makeUser({ nombre, usuario, pass, rol, sucursal: rol === 'admin' ? '' : DEMO_SUC }));
      }
      saveUsers();
    }
    // Demo: inventario y pedido de ejemplo (también si el equipo traía la demo antigua).
    if (window.REVISION_DEMO && !db.orders.some((o) => / \(ejemplo\)$/.test(o.nombre || ''))) createDemo();
    const sid = loadJSON(SESSION_KEY, null) || (() => { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } })();
    const u = users.find((x) => x.id === sid);
    if (u) afterLogin(u, true); else showLogin();
  })();

  // Exponer funciones para pruebas
  window.__app = { parseDelimited, rowsToItems, normCode, parseNum, computeResults, processCode: (c) => handleCode(c), parseCatalogRows };
})();

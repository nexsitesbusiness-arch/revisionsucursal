// Bitácora de auditoría: registro de solo inserción, encadenado con SHA-256.
// Cada registro guarda el hash del anterior; si alguien altera o borra un registro,
// "verificar integridad" lo detecta. No se guardan contraseñas ni datos sensibles.
(function (global) {
  'use strict';

  const DB_NAME = 'revision-bitacora';
  const STORE = 'registros';
  const CHECK_KEY = 'revision-bitacora-control';
  let dbp = null;
  let queue = Promise.resolve();

  function open() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => {
          const st = r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          st.createIndex('ts', 'ts');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }

  async function sha256(text) {
    if (!crypto.subtle) return '';
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Campos que entran en el hash (orden fijo).
  const FIELDS = ['n', 'ts', 'usuarioId', 'usuario', 'nombre', 'rol', 'accion', 'docId', 'doc', 'sucursal', 'producto', 'sku', 'detalle', 'duracionSeg', 'resultado', 'equipo'];
  const canon = (e) => JSON.stringify(FIELDS.map((f) => (e[f] === undefined ? null : e[f])));

  function lastRecord(db) {
    return new Promise((res, rej) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor(null, 'prev');
      req.onsuccess = () => res(req.result ? req.result.value : null);
      req.onerror = () => rej(req.error);
    });
  }

  function equipo() {
    const ua = navigator.userAgent || '';
    const os = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Otro';
    const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Navegador';
    return `${os} · ${br}`;
  }

  // Agrega un registro. Las escrituras van en fila para que la cadena no se cruce.
  function log(entry) {
    const e = Object.assign({ resultado: 'ok', duracionSeg: null }, entry, { ts: Date.now(), equipo: equipo() });
    queue = queue.then(async () => {
      const db = await open();
      const prev = await lastRecord(db);
      e.hashAnterior = prev ? prev.hash : '';
      e.n = (prev ? prev.n || 0 : 0) + 1;
      e.hash = await sha256(e.hashAnterior + canon(e));
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).add(e);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      // Punto de control aparte: permite detectar si borran los últimos registros.
      try { localStorage.setItem(CHECK_KEY, JSON.stringify({ n: (prev ? prev.n || 0 : 0) + 1, hash: e.hash })); } catch (x) { /* sin almacenamiento */ }
      return e;
    }).catch((err) => { console.warn('Bitácora: no se pudo registrar', err); });
    return queue;
  }

  async function all() {
    await queue;
    const db = await open();
    return new Promise((res, rej) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }

  // Recalcula la cadena completa. Devuelve el primer registro alterado, si hay.
  async function verify() {
    const rows = await all();
    let prev = '';
    for (const r of rows) {
      if (r.hashAnterior !== prev) return { ok: false, total: rows.length, malo: r, motivo: 'falta un registro o se cambió el orden' };
      const h = await sha256(prev + canon(r));
      if (h !== r.hash) return { ok: false, total: rows.length, malo: r, motivo: 'el registro fue modificado' };
      prev = r.hash;
    }
    let check = null;
    try { check = JSON.parse(localStorage.getItem(CHECK_KEY)); } catch (x) { /* sin dato */ }
    if (check && check.n > rows.length) return { ok: false, total: rows.length, motivo: `faltan los últimos ${check.n - rows.length} registros` };
    if (check && rows.length && check.n === rows.length && check.hash !== prev) return { ok: false, total: rows.length, motivo: 'el último registro no coincide con el punto de control' };
    return { ok: true, total: rows.length };
  }

  global.Bitacora = { log, all, verify };
})(window);

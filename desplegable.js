// Desplegable propio: reemplaza visualmente cada <select> por un botón con lista estilizada.
// El <select> queda oculto y sigue guardando el valor, así el resto de la app no cambia.
// Con más de 8 opciones muestra un buscador. Se maneja con teclado (flechas, Enter, Esc).
(function (global) {
  'use strict';
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  let openDd = null;

  function enhance(sel) {
    if (sel.dataset.dd || sel.multiple) return;
    sel.dataset.dd = '1';
    const wrap = document.createElement('div');
    wrap.className = 'dd' + (sel.classList.contains('sel-sm') ? ' dd-sm' : '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (sel.getAttribute('aria-label')) btn.setAttribute('aria-label', sel.getAttribute('aria-label'));
    btn.innerHTML = '<span class="dd-label"></span><svg class="dd-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(btn);
    wrap.appendChild(sel);
    sel.classList.add('dd-native');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');

    const sync = () => {
      const o = sel.options[sel.selectedIndex];
      wrap.querySelector('.dd-label').textContent = o ? o.textContent : '';
      wrap.hidden = sel.hidden;
    };
    // Mantiene el botón al día si el código cambia el valor, las opciones o la visibilidad.
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get() { return valueDesc.get.call(this); },
      set(v) { valueDesc.set.call(this, v); sync(); },
    });
    new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    sel.addEventListener('change', sync);
    sync();

    btn.addEventListener('click', () => (openDd && openDd.wrap === wrap ? close() : openList(wrap, sel, btn)));
    btn.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); openList(wrap, sel, btn); }
    });
  }

  function openList(wrap, sel, btn) {
    close();
    const opts = [...sel.options];
    const pop = document.createElement('div');
    pop.className = 'dd-pop';
    pop.setAttribute('role', 'listbox');
    const withSearch = opts.length > 8;
    pop.innerHTML = (withSearch ? '<div class="dd-search"><input type="search" placeholder="Buscar…" aria-label="Buscar opción"></div>' : '') + '<ul class="dd-list"></ul>';
    wrap.appendChild(pop);
    btn.setAttribute('aria-expanded', 'true');
    wrap.classList.add('open');
    const ul = pop.querySelector('.dd-list');
    let active = Math.max(0, sel.selectedIndex);
    let visible = opts;

    const render = (q = '') => {
      visible = opts.filter((o) => !q || norm(o.textContent).includes(norm(q)));
      ul.innerHTML = visible.length ? visible.map((o, k) => `<li role="option" data-k="${k}" class="${o.index === sel.selectedIndex ? 'sel' : ''}" aria-selected="${o.index === sel.selectedIndex}">${o.textContent.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</li>`).join('')
        : '<li class="dd-empty">Sin resultados</li>';
      active = Math.min(active, Math.max(0, visible.length - 1));
      paint();
    };
    const paint = () => {
      ul.querySelectorAll('li[data-k]').forEach((li) => li.classList.toggle('act', +li.dataset.k === active));
      const a = ul.querySelector('li.act');
      if (a) a.scrollIntoView({ block: 'nearest' });
    };
    const pick = (k) => {
      const o = visible[k];
      if (!o) return;
      const changed = sel.selectedIndex !== o.index;
      sel.selectedIndex = o.index;
      close();
      btn.focus();
      if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
      else sel.dispatchEvent(new Event('dd-sync'));
    };
    ul.addEventListener('mousedown', (e) => e.preventDefault());
    ul.addEventListener('click', (e) => { const li = e.target.closest('li[data-k]'); if (li) pick(+li.dataset.k); });
    const onKey = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(visible.length - 1, active + 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pick(active); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); btn.focus(); }
      else if (e.key === 'Tab') close();
    };
    const search = pop.querySelector('input');
    if (search) {
      search.addEventListener('input', () => { active = 0; render(search.value); });
      search.addEventListener('keydown', onKey);
      setTimeout(() => search.focus(), 0);
    } else {
      btn.addEventListener('keydown', onKey);
    }
    openDd = { wrap, btn, onKey };
    render();
    // Si no cabe hacia abajo, se abre hacia arriba.
    const r = pop.getBoundingClientRect();
    if (r.bottom > innerHeight - 8 && wrap.getBoundingClientRect().top > r.height + 16) pop.classList.add('up');
  }

  function close() {
    if (!openDd) return;
    const { wrap, btn, onKey } = openDd;
    btn.removeEventListener('keydown', onKey);
    btn.setAttribute('aria-expanded', 'false');
    wrap.classList.remove('open');
    wrap.querySelector('.dd-pop')?.remove();
    openDd = null;
  }

  document.addEventListener('mousedown', (e) => { if (openDd && !openDd.wrap.contains(e.target)) close(); });
  const scan = (root) => root.querySelectorAll && root.querySelectorAll('select:not([data-dd])').forEach(enhance);
  // Mejora los <select> que existan y los que se agreguen después (diálogos, pantallas).
  new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (n.tagName === 'SELECT') enhance(n); else scan(n); } });
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState !== 'loading') scan(document); else document.addEventListener('DOMContentLoaded', () => scan(document));

  global.Desplegable = { enhance, close };
})(window);

// Modo sin conexión: guarda la app y las librerías para poder contar sin internet.
const CACHE = 'revision-v27';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'gs1.js', 'importar.js', 'bitacora.js', 'desplegable.js', 'manifest.webmanifest', 'ejemplo-pedido.csv',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  // Lector de códigos (ZXing-C++ en WebAssembly): incluido para escanear sin internet.
  'vendor/zxing/zxing-reader.js', 'vendor/zxing/zxing_reader.wasm',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/lz-string/1.5.0/lz-string.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // La API nunca se guarda en el equipo: datos siempre frescos y sin copias locales.
  if (url.origin === location.origin && url.pathname.includes('/api/')) return;
  if (url.origin === location.origin) {
    // Archivos propios: red primero (para recibir mejoras), caché si no hay conexión.
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
    );
  } else {
    // Librerías y fuentes: caché primero; lo nuevo se guarda para usarlo sin conexión.
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    })));
  }
});

const CACHE_NAME = 'semear-jovens-v1';

const PRECACHE_ASSETS = [
    '/assets/logo-oficial.png',
    '/assets/favicon.svg',
    '/css/style.css',
    '/css/velzon-theme.css',
    '/js/ui-kit.js',
    '/js/menu.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Ignorar requisições não-GET e de outras origens
    if (event.request.method !== 'GET' || url.origin !== location.origin) return;

    const isAsset = url.pathname.startsWith('/css/') ||
                    url.pathname.startsWith('/js/') ||
                    url.pathname.startsWith('/assets/');

    if (isAsset) {
        // Cache First para assets estáticos
        event.respondWith(
            caches.match(event.request).then((cached) =>
                cached || fetch(event.request).then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                })
            )
        );
    } else {
        // Network First para páginas e API
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
    }
});

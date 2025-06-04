const BACKEND_URL = 'http://localhost:5000';

// Her proje için ayrı cache ismi oluştur
function getProjectCacheName(projectId) {
    return `kiosk-cache-project-${projectId}`;
}

// HTML dosyasını cache'le
async function cacheHtmlFile() {
    const cache = await caches.open('kiosk-cache-static');
    await cache.add('/');
    await cache.add('/index.html');
    await cache.add('/style.css');
    await cache.add('/kiosk.js');
}

// Proje listesini cache'le
async function cacheProjectList() {
    const cache = await caches.open('kiosk-cache-projects');
    const response = await fetch(`${BACKEND_URL}/projects`);
    if (response.ok) {
        await cache.put(`${BACKEND_URL}/projects`, response.clone());
    }
}

// Belirli bir projenin içeriğini cache'le
async function cacheProjectContent(projectId) {
    const cacheName = getProjectCacheName(projectId);
    const cache = await caches.open(cacheName);
    
    // Proje içeriğini cache'le
    const contentResponse = await fetch(`${BACKEND_URL}/content/${projectId}`);
    if (contentResponse.ok) {
        await cache.put(`${BACKEND_URL}/content/${projectId}`, contentResponse.clone());
        
        // Versiyon bilgisini al ve sakla
        const contentData = await contentResponse.clone().json();
        await cache.put(`${BACKEND_URL}/version/${projectId}`, new Response(contentData.version));
    }
}

// Versiyon kontrolü yap
async function checkProjectVersion(projectId) {
    try {
        const cacheName = getProjectCacheName(projectId);
        const cache = await caches.open(cacheName);
        
        // Cache'deki versiyon
        const cachedVersionResponse = await cache.match(`${BACKEND_URL}/version/${projectId}`);
        const cachedVersion = cachedVersionResponse ? await cachedVersionResponse.text() : null;
        
        // Sunucudaki versiyon
        const serverVersionResponse = await fetch(`${BACKEND_URL}/version/${projectId}`);
        const serverVersion = serverVersionResponse.ok ? (await serverVersionResponse.json()).version : null;
        
        // Versiyon farklıysa güncelle
        if (serverVersion && (!cachedVersion || cachedVersion !== serverVersion)) {
            console.log(`Proje ${projectId} için yeni versiyon bulundu: ${serverVersion}`);
            
            // Eski cache'i temizle
            await caches.delete(cacheName);
            
            // Yeni içeriği cache'le
            await cacheProjectContent(projectId);
            
            // Client'a bildir
            const clients = await self.clients.matchAll();
            clients.forEach(client => {
                client.postMessage({
                    type: 'RELOAD_PAGE',
                    projectId: projectId
                });
            });
        }
    } catch (error) {
        console.error(`Proje ${projectId} versiyon kontrolü hatası:`, error);
    }
}

// Service Worker kurulduğunda
self.addEventListener('install', event => {
    event.waitUntil(
        Promise.all([
            cacheHtmlFile(),
            cacheProjectList(),
            self.skipWaiting()
        ])
    );
});

// Service Worker aktifleştiğinde
self.addEventListener('activate', event => {
    event.waitUntil(
        Promise.all([
            // Eski cache'leri temizle
            caches.keys().then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cacheName => {
                        // Geçersiz cache'leri sil
                        if (!cacheName.startsWith('kiosk-cache-')) {
                            return caches.delete(cacheName);
                        }
                    })
                );
            }),
            self.clients.claim()
        ])
    );
});

// Fetch isteklerini yakala
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // HTML dosyası istekleri için (SPA routing)
    if (event.request.mode === 'navigate') {
        event.respondWith(
            caches.match('/index.html')
                .then(response => response || fetch('/index.html'))
                .catch(() => caches.match('/index.html'))
        );
        return;
    }
    
    // Backend isteklerini işle
    if (url.origin === BACKEND_URL) {
        event.respondWith(
            (async () => {
                try {
                    // Proje ID'sini URL'den çıkar
                    const projectIdMatch = url.pathname.match(/^\/(?:content|version)\/(\d+)/);
                    const projectId = projectIdMatch ? projectIdMatch[1] : null;
                    
                    // Proje listesi isteği
                    if (url.pathname === '/projects') {
                        const cache = await caches.open('kiosk-cache-projects');
                        const cachedResponse = await cache.match(event.request);
                        
                        try {
                            const networkResponse = await fetch(event.request);
                            if (networkResponse.ok) {
                                await cache.put(event.request, networkResponse.clone());
                                return networkResponse;
                            }
                        } catch (error) {
                            if (cachedResponse) return cachedResponse;
                        }
                        
                        return cachedResponse || new Response(JSON.stringify([]), {
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                    
                    // Proje içeriği isteği
                    if (projectId) {
                        const cache = await caches.open(getProjectCacheName(projectId));
                        const cachedResponse = await cache.match(event.request);
                        
                        try {
                            const networkResponse = await fetch(event.request);
                            if (networkResponse.ok) {
                                await cache.put(event.request, networkResponse.clone());
                                return networkResponse;
                            }
                        } catch (error) {
                            if (cachedResponse) return cachedResponse;
                        }
                        
                        return cachedResponse || new Response(JSON.stringify({ error: 'Offline - Cache bulunamadı' }), {
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                    
                    // Diğer istekler için network'e git
                    return fetch(event.request);
                } catch (error) {
                    console.error('Fetch hatası:', error);
                    return new Response(JSON.stringify({ error: 'İstek işlenemedi' }), {
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
            })()
        );
        return;
    }

    // Statik dosyalar için
    event.respondWith(
        caches.match(event.request)
            .then(response => response || fetch(event.request))
            .catch(() => {
                // CSS veya JS dosyası ise boş response dön
                if (url.pathname.endsWith('.css')) {
                    return new Response('', { headers: { 'Content-Type': 'text/css' } });
                }
                if (url.pathname.endsWith('.js')) {
                    return new Response('', { headers: { 'Content-Type': 'application/javascript' } });
                }
                return new Response('Offline - Dosya bulunamadı');
            })
    );
});

// Periyodik versiyon kontrolü
self.addEventListener('sync', event => {
    if (event.tag === 'version-check') {
        event.waitUntil(
            (async () => {
                try {
                    // Proje listesini al
                    const response = await fetch(`${BACKEND_URL}/projects`);
                    if (response.ok) {
                        const projects = await response.json();
                        // Her proje için versiyon kontrolü yap
                        await Promise.all(
                            projects.map(project => checkProjectVersion(project.id))
                        );
                    }
                } catch (error) {
                    console.error('Versiyon kontrolü hatası:', error);
                }
            })()
        );
    }
});
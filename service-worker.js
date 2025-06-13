const CACHE_NAME = 'kiosk-cache';
const BACKEND_URL = 'http://localhost:5000';
let currentVersion = null;
let urlsToCache = new Set();

// HTML içindeki backend URL'lerini bul
async function findBackendUrls() {
    try {
        // index.html'i getir
        const response = await fetch('/index.html');
        const html = await response.text();

        // Link tag'lerinden URL'leri bul
        const linkRegex = new RegExp(`<link[^>]*href=["'](${BACKEND_URL}[^"']+)["'][^>]*>`, 'g');
        let match;
        while ((match = linkRegex.exec(html)) !== null) {
            urlsToCache.add(match[1]);
        }

        // Script tag'lerinden URL'leri bul
        const scriptRegex = new RegExp(`<script[^>]*src=["'](${BACKEND_URL}[^"']+)["'][^>]*>`, 'g');
        while ((match = scriptRegex.exec(html)) !== null) {
            urlsToCache.add(match[1]);
        }

        console.log('Bulunan backend URL\'leri:', Array.from(urlsToCache));
    } catch (error) {
        console.error('URL bulma hatası:', error);
    }
}

// İlk kurulum için dosyaları cache'e kaydet
async function initialCaching() {
    try {
        // Önce backend URL'lerini bul
        await findBackendUrls();

        // Versiyon bilgisini al
        const versionResponse = await fetch(`${BACKEND_URL}/version`, {
            cache: 'no-store'
        });
        const versionData = await versionResponse.json();
        currentVersion = versionData.version;

        // Cache'i oluştur
        const cache = await caches.open(CACHE_NAME);

        // Bulunan URL'leri cache'e ekle
        for (const url of urlsToCache) {
            try {
                const response = await fetch(url);
                if (response.ok) {
                    await cache.put(url, response);
                }
            } catch (error) {
                console.error(`Dosya cache'leme hatası (${url}):`, error);
            }
        }

        console.log('İlk cache oluşturuldu, versiyon:', currentVersion);
    } catch (error) {
        console.error('İlk cache oluşturma hatası:', error);
    }
}

// Service Worker kurulumu
self.addEventListener('install', (event) => {
    event.waitUntil(initialCaching());
    self.skipWaiting();
});

// Fetch olaylarını yakala
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Backend URL'inden gelen ve cache listesinde olan istekleri kontrol et
    if (url.origin === BACKEND_URL && urlsToCache.has(event.request.url)) {
        event.respondWith(
            // Önce cache'den dene
            caches.match(event.request)
                .then(cachedResponse => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    // Cache'de yoksa network'ten al ve cache'le
                    return fetch(event.request)
                        .then(response => {
                            if (!response || response.status !== 200) {
                                return response;
                            }
                            const responseToCache = response.clone();
                            caches.open(CACHE_NAME)
                                .then(cache => {
                                    cache.put(event.request, responseToCache);
                                });
                            return response;
                        });
                })
        );
    }
});

// Versiyon kontrolü ve cache güncelleme
async function checkVersion() {
    try {
        // Cache yoksa ilk kurulumu yap
        const cache = await caches.open(CACHE_NAME);
        const keys = await cache.keys();
        if (keys.length === 0) {
            await initialCaching();
            return;
        }

        // URL'leri yeniden kontrol et (yeni eklenmiş olabilir)
        await findBackendUrls();

        // Versiyon kontrolü
        const response = await fetch(`${BACKEND_URL}/version`, {
            cache: 'no-store'
        });
        const data = await response.json();
        
        // Versiyon değiştiyse cache'i güncelle
        if (currentVersion !== data.version) {
            console.log(`Versiyon değişti: ${currentVersion} -> ${data.version}`);
            
            // Tüm URL'leri yeni versiyonla güncelle
            for (const url of urlsToCache) {
                try {
                    const response = await fetch(url, { 
                        cache: 'reload',
                        headers: {
                            'Cache-Control': 'no-cache'
                        }
                    });
                    
                    if (response.ok) {
                        await cache.put(url, response);
                    }
                } catch (error) {
                    console.error(`Dosya güncelleme hatası (${url}):`, error);
                }
            }
            
            // Versiyon numarasını güncelle
            currentVersion = data.version;
            
            // Client'lara versiyon değişikliğini bildir ve sayfayı yenile
            const clients = await self.clients.matchAll();
            for (const client of clients) {
                // Önce versiyon değişikliğini bildir
                await client.postMessage({
                    type: 'VERSION_CHANGED',
                    version: currentVersion
                });
                
                // Sonra sayfayı yenile
                if (client.type === 'window') {
                    client.navigate(client.url);
                }
            }
        }
    } catch (error) {
        console.error('Versiyon kontrolü hatası:', error);
    }
}

// Activate olayında eski cache'leri temizle
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// İlk versiyon kontrolünü yap
checkVersion();

// Her 10 saniyede bir versiyon kontrolü yap
setInterval(checkVersion, 10000); 
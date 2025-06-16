const CACHE_NAME = 'kiosk-cache';
const BACKEND_URL = 'http://localhost:5000';
let currentVersion = null;
let urlsToCache = new Set();

// Desteklenen URL şemalarını kontrol et
function isSupportedUrlScheme(url) {
    // Eğer URL göreceli ise (http:// veya https:// ile başlamıyorsa) destekle
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return true;
    }

    try {
        const urlObj = new URL(url);
        // http, https ve data şemalarını destekle
        return ['http:', 'https:', 'data:'].includes(urlObj.protocol);
    } catch (e) {
        // Geçersiz URL'leri reddet
        return false;
    }
}

// URL'leri kategorize et
function categorizeUrl(url) {
    // Göreceli URL'ler için
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return 'local';
    }

    try {
        const urlObj = new URL(url);
        if (urlObj.protocol === 'chrome-extension:') {
            return 'unsupported';
        }
        if (url.startsWith(BACKEND_URL)) {
            return 'backend';
        } else {
            return 'external';
        }
    } catch (e) {
        // Geçersiz URL'ler için local olarak işle
        return 'local';
    }
}

// HTML içindeki tüm URL'leri bul
async function findAllUrls() {
    try {
        // index.html'i getir
        const response = await fetch('/index.html');
        const html = await response.text();

        // Link tag'lerinden URL'leri bul
        const linkRegex = /<link[^>]*href=["']([^"']+)["'][^>]*>/g;
        let match;
        while ((match = linkRegex.exec(html)) !== null) {
            const url = match[1];
            if (url.startsWith('//')) {
                const fullUrl = 'https:' + url;
                if (isSupportedUrlScheme(fullUrl)) {
                    urlsToCache.add(fullUrl);
                }
            } else if (isSupportedUrlScheme(url)) {
                urlsToCache.add(url);
            }
        }

        // Script tag'lerinden URL'leri bul
        const scriptRegex = /<script[^>]*src=["']([^"']+)["'][^>]*>/g;
        while ((match = scriptRegex.exec(html)) !== null) {
            const url = match[1];
            if (url.startsWith('//')) {
                const fullUrl = 'https:' + url;
                if (isSupportedUrlScheme(fullUrl)) {
                    urlsToCache.add(fullUrl);
                }
            } else if (isSupportedUrlScheme(url)) {
                urlsToCache.add(url);
            }
        }

        // Image tag'lerinden URL'leri bul
        const imgRegex = /<img[^>]*src=["']([^"']+)["'][^>]*>/g;
        while ((match = imgRegex.exec(html)) !== null) {
            const url = match[1];
            if (url.startsWith('//')) {
                const fullUrl = 'https:' + url;
                if (isSupportedUrlScheme(fullUrl)) {
                    urlsToCache.add(fullUrl);
                }
            } else if (isSupportedUrlScheme(url)) {
                urlsToCache.add(url);
            }
        }

        console.log('Bulunan URL\'ler:', Array.from(urlsToCache));
    } catch (error) {
        console.error('URL bulma hatası:', error);
    }
}

// İlk kurulum için dosyaları cache'e kaydet
async function initialCaching() {
    try {
        // Önce tüm URL'leri bul
        await findAllUrls();

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
                const response = await fetch(url, {
                    mode: 'no-cors', // External URL'ler için
                    credentials: 'omit' // External URL'ler için
                });
                if (response.ok || response.type === 'opaque') {
                    await cache.put(url, response);
                }
            } catch (error) {
                console.error(`Dosya cache'leme hatası (${url}):`, error);
            }
        }

        // index.html'i de cache'e ekle
        const indexResponse = await fetch('/index.html');
        if (indexResponse.ok) {
            await cache.put('/index.html', indexResponse);
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
    const url = event.request.url;
    const urlType = categorizeUrl(url);
    
    // Desteklenmeyen URL şemaları için network'ten al
    if (urlType === 'unsupported') {
        event.respondWith(fetch(event.request));
        return;
    }
    
    // Backend URL'lerinden gelen istekler için
    if (urlType === 'backend') {
        event.respondWith(
            caches.match(event.request)
                .then(cachedResponse => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    return fetch(event.request)
                        .then(response => {
                            if (response && response.status === 200) {
                                const responseToCache = response.clone();
                                caches.open(CACHE_NAME)
                                    .then(cache => {
                                        if (isSupportedUrlScheme(url)) {
                                            cache.put(event.request, responseToCache);
                                        }
                                    });
                            }
                            return response;
                        })
                        .catch(error => {
                            console.error('Network hatası:', error);
                            return caches.match(event.request);
                        });
                })
        );
    }
    // External URL'ler için
    else if (urlType === 'external') {
        event.respondWith(
            caches.match(event.request)
                .then(cachedResponse => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    return fetch(event.request, {
                        mode: 'no-cors',
                        credentials: 'omit'
                    })
                        .then(response => {
                            if (response && (response.ok || response.type === 'opaque')) {
                                const responseToCache = response.clone();
                                caches.open(CACHE_NAME)
                                    .then(cache => {
                                        if (isSupportedUrlScheme(url)) {
                                            cache.put(event.request, responseToCache);
                                        }
                                    });
                            }
                            return response;
                        })
                        .catch(() => {
                            return caches.match(event.request);
                        });
                })
        );
    }
    // Local URL'ler için
    else {
        event.respondWith(
            caches.match(event.request)
                .then(cachedResponse => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    return fetch(event.request)
                        .then(response => {
                            if (response && response.status === 200) {
                                const responseToCache = response.clone();
                                caches.open(CACHE_NAME)
                                    .then(cache => {
                                        if (isSupportedUrlScheme(url)) {
                                            cache.put(event.request, responseToCache);
                                        }
                                    });
                            }
                            return response;
                        })
                        .catch(() => {
                            return caches.match(event.request);
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
        await findAllUrls();

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
                // Desteklenmeyen URL şemalarını atla
                if (!isSupportedUrlScheme(url)) {
                    console.log(`Desteklenmeyen URL şeması atlandı: ${url}`);
                    continue;
                }

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
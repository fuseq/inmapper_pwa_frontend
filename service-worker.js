const CACHE_NAME = 'kiosk-cache';
const BACKEND_URL = 'http://localhost:5000';
let currentVersion = null;
let urlsToCache = new Set();

// IndexedDB için sabitler
const DB_NAME = 'kiosk-data';
const DB_VERSION = 1;
const STORE_NAME = 'jsonData';

// --- IndexedDB Yardımcı Fonksiyonları ---

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'url' });
            }
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            console.error('IndexedDB açma hatası:', event.target.errorCode);
            reject(event.target.errorCode);
        };
    });
}

async function putJsonIntoIndexedDB(url, data) {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
        const request = store.put({ url: url, data: data });
        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
    });
}

async function getJsonFromIndexedDB(url) {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
        const request = store.get(url);
        request.onsuccess = (event) => {
            resolve(event.target.result ? event.target.result.data : null);
        };
        request.onerror = (event) => reject(event.target.error);
    });
}

// --- Mevcut Servis Worker Kodunuz ---

function isSupportedUrlScheme(url) {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return true; // Göreceli URL'ler her zaman desteklenir (Service Worker kapsamında çözülür)
    }

    try {
        const urlObj = new URL(url);
        // Sadece 'http:', 'https:' ve 'data:' şemalarını destekle
        return ['http:', 'https:', 'data:'].includes(urlObj.protocol);
    } catch (e) {
        // Geçersiz URL'leri reddet
        return false;
    }
}

function categorizeUrl(url) {
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
        return 'local'; // Geçersiz URL'leri 'local' gibi ele alabiliriz, ama önbelleğe almadan önce isSupportedUrlScheme kontrolü önemli.
    }
}

async function findAllUrls() {
    try {
        // index.html'i fetch etme işleminin fetch event handler tarafından ele alınmasına izin verin.
        // Bu fonksiyon sadece HTML içindeki statik varlıkların URL'lerini bulmalı.
        // Eğer '/index.html' kendisi henüz cache'de yoksa, bu fetch işlemi başarısız olabilir
        // veya network'ten çekilir. Bu kısmı dikkatli yönetmek gerekiyor.
        // Basitlik adına, doğrudan fetch yerine client'tan gelen request'e güvenebiliriz veya
        // initialCaching'deki gibi ilk başta cache'e koyabiliriz.

        // Eğer findAllUrls, initialCaching sırasında çağrılıyorsa, '/index.html' erişilebilir olmalı.
        const response = await fetch('/index.html');
        const html = await response.text();

        const regexes = [
            /<link[^>]*href=["']([^"']+)["'][^>]*>/g,
            /<script[^>]*src=["']([^"']+)["'][^>]*>/g,
            /<img[^>]*src=["']([^"']+)["'][^>]*>/g
        ];

        for (const regex of regexes) {
            let match;
            while ((match = regex.exec(html)) !== null) {
                const url = match[1];
                let fullUrl = url;
                if (url.startsWith('//')) {
                    fullUrl = 'https:' + url;
                }
                // URL'yi Set'e eklemeden önce şema kontrolü yapın
                if (isSupportedUrlScheme(fullUrl)) {
                    urlsToCache.add(fullUrl);
                } else {
                    console.warn(`findAllUrls: Desteklenmeyen URL şeması tespit edildi ve atlandı: ${fullUrl}`);
                }
            }
        }
        console.log('Bulunan ve desteklenen URL\'ler:', Array.from(urlsToCache));
    } catch (error) {
        console.error('URL bulma hatası:', error);
    }
}

// İlk kurulum için dosyaları cache'e kaydet
async function initialCaching() {
    try {
        await findAllUrls(); // Bu, urlsToCache setini dolduracak

        const cache = await caches.open(CACHE_NAME);

        // Versiyon bilgisini al ve kaydet
        const versionResponse = await fetch(`${BACKEND_URL}/version`, {
            cache: 'no-store'
        });
        const versionData = await versionResponse.json();
        currentVersion = versionData.version;
        await cache.put('/app-version', new Response(JSON.stringify({ version: currentVersion })));

        // index.html'i cache'e ekle
        const indexResponse = await fetch('/index.html');
        if (indexResponse.ok) {
            await cache.put('/index.html', indexResponse.clone());
        } else {
            console.warn(`index.html cache'lenemedi: ${indexResponse.status}`);
        }


        // Bulunan URL'leri cache'e veya IndexedDB'ye ekle
        for (const url of urlsToCache) {
            // Cache'e koymadan önce şema kontrolü YAPIN
            if (!isSupportedUrlScheme(url)) {
                console.warn(`initialCaching: Desteklenmeyen URL şeması nedeniyle atlandı: ${url}`);
                continue; // Desteklenmeyen şemaları atla
            }

            try {
                const urlType = categorizeUrl(url);

                // JSON dosyalarını IndexedDB'ye kaydet
                if (url.endsWith('.json') && url !== '/manifest.json') {
                    const response = await fetch(url);
                    if (response.ok) {
                        const jsonData = await response.json();
                        await putJsonIntoIndexedDB(url, jsonData);
                        console.log(`JSON dosya IndexedDB'ye kaydedildi: ${url}`);
                    } else {
                        console.warn(`JSON dosyası ağdan alınamadı: ${url}, Durum: ${response.status}`);
                    }
                } else { // Diğer tüm dosyaları Cache Storage'a kaydet
                    const fetchOptions = (urlType === 'external') ? { mode: 'no-cors', credentials: 'omit' } : {};
                    const response = await fetch(url, fetchOptions);
                    if (response.ok || (urlType === 'external' && response.type === 'opaque')) {
                        await cache.put(url, response.clone());
                    } else {
                        console.warn(`Dosya cache'leme başarısız: ${url}, Durum: ${response.status} veya Tip: ${response.type}`);
                    }
                }
            } catch (error) {
                console.error(`Dosya işleme hatası (${url}):`, error);
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
    const url = event.request.url;
    const urlType = categorizeUrl(url);

    // Desteklenmeyen URL şemaları için doğrudan ağa git
    if (urlType === 'unsupported') {
        console.warn(`Fetch: Desteklenmeyen URL şeması isteği: ${url}`);
        event.respondWith(fetch(event.request));
        return;
    }

    // JSON dosyalarını IndexedDB'den sun
    if (url.endsWith('.json') && url !== '/manifest.json') {
        event.respondWith(
            getJsonFromIndexedDB(url)
                .then(jsonResult => {
                    if (jsonResult) {
                        console.log(`JSON dosyası IndexedDB'den alındı: ${url}`);
                        return new Response(JSON.stringify(jsonResult), {
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                    // IndexedDB'de yoksa veya güncel değilse ağdan al ve IndexedDB'ye kaydet
                    console.log(`JSON dosyası IndexedDB'de bulunamadı, ağdan çekiliyor: ${url}`);
                    return fetch(event.request)
                        .then(response => {
                            if (response.ok) {
                                return response.clone().json().then(data => {
                                    putJsonIntoIndexedDB(url, data); // IndexedDB'yi güncelle
                                    return response; // Orijinal yanıtı döndür
                                });
                            }
                            return response;
                        })
                        .catch(error => {
                            console.error(`JSON dosyası ağdan alınırken hata oluştu (${url}):`, error);
                            // Ağdan alınamayan JSON için bir fallback yanıt döndürün
                            return new Response(JSON.stringify({ error: 'Network or IndexedDB fetch failed' }), { status: 500, statusText: 'Internal Server Error', headers: { 'Content-Type': 'application/json' } });
                        });
                })
                .catch(error => {
                    console.error(`IndexedDB'den JSON alınırken kritik hata oluştu (${url}):`, error);
                    return fetch(event.request); // Kritik IndexedDB hatasında ağa düş
                })
        );
        return; // JSON isteğini burada ele aldık, diğerlerine geçme
    }

    // Diğer istekleri mevcut cache stratejisine göre işle
    event.respondWith(
        caches.match(event.request).then(cachedResponse => {
            if (urlType === 'backend') {
                return fetch(event.request)
                    .then(response => {
                        if (response && response.status === 200) {
                            const responseToCache = response.clone();
                            // Cache'e koymadan önce şema kontrolü YAPIN
                            if (isSupportedUrlScheme(url)) {
                                caches.open(CACHE_NAME).then(cache => {
                                    cache.put(event.request, responseToCache);
                                });
                            } else {
                                console.warn(`Fetch: Backend yanıtı için desteklenmeyen URL şeması: ${url}, Cache'e kaydedilmedi.`);
                            }
                        }
                        return response;
                    })
                    .catch(() => {
                        return cachedResponse || new Response(null, { status: 503, statusText: 'Service Unavailable' });
                    });
            }

            if (cachedResponse) {
                return cachedResponse;
            }

            const fetchOptions = (urlType === 'external') ? { mode: 'no-cors', credentials: 'omit' } : {};
            return fetch(event.request, fetchOptions)
                .then(response => {
                    if (response && (response.ok || (urlType === 'external' && response.type === 'opaque'))) {
                        const responseToCache = response.clone();
                        // Cache'e koymadan önce şema kontrolü YAPIN
                        if (isSupportedUrlScheme(url)) {
                            caches.open(CACHE_NAME).then(cache => {
                                cache.put(event.request, responseToCache);
                            });
                        } else {
                            console.warn(`Fetch: External/Local yanıtı için desteklenmeyen URL şeması: ${url}, Cache'e kaydedilmedi.`);
                        }
                    }
                    return response;
                })
                .catch(() => {
                    return new Response(null, { status: 503, statusText: 'Service Unavailable' });
                });
        })
    );
});

// Versiyon kontrolü ve cache güncelleme
async function checkVersion() {
    try {
        if (currentVersion === null) {
            const cache = await caches.open(CACHE_NAME);
            const versionResponse = await cache.match('/app-version');
            if (versionResponse) {
                const versionData = await versionResponse.json();
                currentVersion = versionData.version;
            }
        }

        if (currentVersion === null) {
            console.log('No version found in cache, performing initial caching.');
            await initialCaching();
            return;
        }

        await findAllUrls();

        const response = await fetch(`${BACKEND_URL}/version`, {
            cache: 'no-store'
        });
        const data = await response.json();

        if (currentVersion !== data.version) {
            console.log(`Versiyon değişti: ${currentVersion} -> ${data.version}`);

            const cache = await caches.open(CACHE_NAME);

            const indexResponse = await fetch('/index.html', { cache: 'reload' });
            if (indexResponse.ok) {
                await cache.put('/index.html', indexResponse.clone());
            } else {
                console.warn(`checkVersion: index.html güncellenemedi: ${indexResponse.status}`);
            }


            for (const url of urlsToCache) {
                // Cache'e koymadan önce şema kontrolü YAPIN
                if (!isSupportedUrlScheme(url)) {
                    console.warn(`checkVersion: Desteklenmeyen URL şeması nedeniyle atlandı: ${url}`);
                    continue; // Desteklenmeyen şemaları atla
                }

                try {
                    // JSON dosyalarını IndexedDB'yi güncelleyerek yeniden al
                    if (url.endsWith('.json') && url !== '/manifest.json') {
                        const res = await fetch(url, { cache: 'reload' }); // Ağdan yeni versiyonu al
                        if (res.ok) {
                            const jsonData = await res.json();
                            await putJsonIntoIndexedDB(url, jsonData); // IndexedDB'yi güncelle
                            console.log(`JSON dosya IndexedDB'de güncellendi: ${url}`);
                        } else {
                            console.warn(`JSON dosyası güncelleme başarısız: ${url}, Durum: ${res.status}`);
                        }
                    } else { // Diğer dosyaları Cache Storage'ı güncelleyerek yeniden al
                        const urlType = categorizeUrl(url);
                        const fetchOptions = (urlType === 'external') ? { mode: 'no-cors', credentials: 'omit' } : { cache: 'reload' };
                        const res = await fetch(url, fetchOptions);
                        if (res.ok || (urlType === 'external' && res.type === 'opaque')) {
                            await cache.put(url, res.clone());
                        } else {
                            console.warn(`Dosya güncelleme başarısız: ${url}, Durum: ${res.status} veya Tip: ${res.type}`);
                        }
                    }
                } catch (error) {
                    console.error(`Dosya güncelleme hatası (${url}):`, error);
                }
            }

            currentVersion = data.version;
            await cache.put('/app-version', new Response(JSON.stringify({ version: currentVersion })));

            const clients = await self.clients.matchAll();
            for (const client of clients) {
                await client.postMessage({
                    type: 'VERSION_CHANGED',
                    version: currentVersion
                });
                if (client.type === 'window') {
                    client.navigate(client.url);
                }
            }
        }
    } catch (error) {
        console.error('Versiyon kontrolü hatası:', error);
    }
}

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            ).then(() => {
                self.clients.claim();
            });
        })
    );
});

checkVersion();
setInterval(checkVersion, 10000);
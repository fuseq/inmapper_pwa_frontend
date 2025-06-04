// Service Worker'ı kaydet
if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
        try {
            const registration = await navigator.serviceWorker.register('/service-worker.js');
            console.log('Service Worker başarıyla kaydedildi:', registration);
            
            // Periyodik versiyon kontrolü için background sync kaydet
            if ('sync' in registration) {
                try {
                    // Her 30 saniyede bir versiyon kontrolü
                    setInterval(async () => {
                        await registration.sync.register('version-check');
                    }, 30000);
                } catch (error) {
                    console.error('Background sync kaydı başarısız:', error);
                }
            }
        } catch (error) {
            console.error('Service Worker kaydı başarısız:', error);
        }
    });
}

// Service Worker'dan gelen mesajları dinle
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'RELOAD_PAGE') {
            const currentProjectId = window.location.pathname.substring(1).match(/^\d+$/)?.[0];
            // Sadece ilgili projenin sayfasındaysa yenile
            if (currentProjectId === event.data.projectId) {
                console.log(`Proje ${event.data.projectId} için yeni versiyon algılandı, sayfa yenileniyor...`);
                window.location.reload();
            }
        }
    });
}

const BACKEND_URL = 'http://localhost:5000';

// Proje listesini yükle
async function loadProjects() {
    try {
        const response = await fetch(`${BACKEND_URL}/projects`);
        if (!response.ok) throw new Error('Projeler yüklenemedi');
        return await response.json();
    } catch (error) {
        console.error('Proje listesi yükleme hatası:', error);
        return [];
    }
}

// Belirli bir projenin içeriğini yükle
async function loadProjectContent(projectId) {
    try {
        const response = await fetch(`${BACKEND_URL}/content/${projectId}`);
        if (!response.ok) throw new Error('Proje içeriği yüklenemedi');
        return await response.json();
    } catch (error) {
        console.error('Proje içeriği yükleme hatası:', error);
        return null;
    }
}

// Ana içerik yükleme fonksiyonu
async function loadContent() {
    const dynamicContent = document.getElementById('dynamicContent');
    const versionContainer = document.getElementById('versionContainer');
    
    // URL'den proje ID'sini al
    const path = window.location.pathname.substring(1);
    const projectId = path.match(/^\d+$/)?.[0];

    // Yükleniyor mesajını göster
    dynamicContent.innerHTML = `
        <div class="loading">
            <p>İçerik yükleniyor...</p>
        </div>
    `;

    if (projectId) {
        // Belirli bir projenin içeriğini yükle
        const projectContent = await loadProjectContent(projectId);
        if (projectContent) {
            // Versiyon bilgisini göster
            if (versionContainer) {
                versionContainer.style.display = 'block';
                const versionTag = document.getElementById('versionTag');
                if (versionTag) {
                    versionTag.textContent = projectContent.version;
                }
            }

            dynamicContent.innerHTML = `
                <div class="project-content">
                    <h2>Proje ${projectId}</h2>
                    <div class="json-content">
                        <pre>${JSON.stringify(projectContent.data, null, 2)}</pre>
                    </div>
                </div>
            `;
        } else {
            dynamicContent.innerHTML = `
                <div class="error-message">
                    <h3>Hata</h3>
                    <p>Proje içeriği yüklenemedi</p>
                </div>
            `;
        }
    } else {
        // Ana sayfada versiyon göstergesini gizle
        if (versionContainer) {
            versionContainer.style.display = 'none';
        }

        // Ana sayfada proje listesini göster
        const projects = await loadProjects();
        dynamicContent.innerHTML = `
            <div class="projects-list">
                <h2>Projeler</h2>
                <div class="projects-grid">
                    ${projects.map(project => `
                        <div class="project-card">
                            <h3>Proje ${project.id}</h3>
                            <p>Versiyon: ${project.version}</p>
                            <a href="/${project.id}" class="view-project">Projeyi Görüntüle</a>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }
}

// Offline durumu kontrolü
function updateOnlineStatus() {
    const statusElement = document.getElementById('connectionStatus');
    if (statusElement) {
        if (navigator.onLine) {
            statusElement.textContent = 'Çevrimiçi';
            statusElement.className = 'status-bar online';
        } else {
            statusElement.textContent = 'Çevrimdışı - Cache kullanılıyor';
            statusElement.className = 'status-bar offline';
        }
    }
}

// Online/Offline event listener'ları
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// Sayfa yüklendiğinde
document.addEventListener('DOMContentLoaded', () => {
    updateOnlineStatus();
    loadContent();
});

// Popstate event listener'ı ekle (geri/ileri tuşları için)
window.addEventListener('popstate', () => {
    loadContent();
});

// Link tıklamalarını yakala
document.addEventListener('click', (e) => {
    if (e.target.tagName === 'A' && !e.target.getAttribute('href').includes('.html')) {
        e.preventDefault();
        const href = e.target.getAttribute('href');
        window.history.pushState({}, '', href);
        loadContent();
    }
}); 
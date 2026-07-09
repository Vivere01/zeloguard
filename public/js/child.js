// ZeloGuard Child Tracker v2
// Features: Persistent consent, Service Worker, Wake Lock, Auto-reconnect, PWA install

const STORAGE_KEY = 'zeloguard_session'; // key stored in localStorage

document.addEventListener('DOMContentLoaded', () => {
  // ─── Screens ───────────────────────────────────────────────────────────────
  const screens = {
    consent:   document.getElementById('screen-consent'),
    tracking:  document.getElementById('screen-tracking'),
    revoked:   document.getElementById('screen-revoked'),
    error:     document.getElementById('screen-error')
  };

  function showScreen(name) {
    Object.values(screens).forEach(s => s.style.display = 'none');
    if (screens[name]) screens[name].style.display = 'flex';
  }

  // ─── Tracking UI Elements ──────────────────────────────────────────────────
  const trackerTitle      = document.getElementById('tracker-title');
  const trackerStatusDesc = document.getElementById('tracker-status-desc');
  const radarPulse        = document.getElementById('radar-pulse');
  const connectionBadge   = document.getElementById('connection-badge');
  const statLat           = document.getElementById('stat-lat');
  const statLng           = document.getElementById('stat-lng');
  const statAccuracy      = document.getElementById('stat-accuracy');
  const statBattery       = document.getElementById('stat-battery');
  const simulatorToggle   = document.getElementById('simulator-toggle');
  const simulationCity    = document.getElementById('simulation-city');
  const consentBtn        = document.getElementById('btn-consent');
  const toast             = document.getElementById('toast');
  const installBanner     = document.getElementById('install-banner');
  const iosBanner         = document.getElementById('ios-hint');
  const installBtn        = document.getElementById('btn-install');
  
  // Modal elements
  const modalPermission    = document.getElementById('modal-permission');
  const modalBody          = document.getElementById('modal-permission-body');
  const btnCloseModal      = document.getElementById('btn-close-modal');

  btnCloseModal?.addEventListener('click', () => {
    modalPermission?.classList.remove('show');
  });

  // ─── Parse URL ─────────────────────────────────────────────────────────────
  const urlParams = new URLSearchParams(window.location.search);
  const userId = urlParams.get('id');

  if (!userId) {
    showScreen('error');
    return;
  }

  // ─── Service Worker Registration ───────────────────────────────────────────
  let swRegistration = null;

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      swRegistration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
      console.log('[SW] Registered:', swRegistration.scope);
    } catch (err) {
      console.warn('[SW] Registration failed:', err);
    }
  }

  function notifyServiceWorker(type, payload = {}) {
    if (swRegistration?.active) {
      swRegistration.active.postMessage({ type, payload });
    } else if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type, payload });
    }
  }

  // ─── Wake Lock (keeps screen on while in foreground) ───────────────────────
  let wakeLock = null;

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('[WakeLock] Active');
      wakeLock.addEventListener('release', () => {
        console.log('[WakeLock] Released');
        // Re-request on visibility change back to active
      });
    } catch (err) {
      console.warn('[WakeLock] Failed:', err.message);
    }
  }

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && isTracking) {
      await requestWakeLock();
    }
  });

  // ─── Battery Monitoring ────────────────────────────────────────────────────
  let batteryLevel = 100;

  async function initBattery() {
    if (!navigator.getBattery) {
      statBattery.textContent = 'N/A';
      return;
    }
    try {
      const battery = await navigator.getBattery();
      batteryLevel = Math.round(battery.level * 100);
      statBattery.textContent = batteryLevel + '%';
      battery.addEventListener('levelchange', () => {
        batteryLevel = Math.round(battery.level * 100);
        statBattery.textContent = batteryLevel + '%';
      });
    } catch (e) {
      console.warn('[Battery] API error:', e);
    }
  }

  // ─── PWA Install Prompt ────────────────────────────────────────────────────
  let deferredInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBanner.style.display = 'block';
  });

  installBtn?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      installBanner.style.display = 'none';
      showToast('App instalado! Use o ícone na tela inicial.');
    }
    deferredInstallPrompt = null;
  });

  // Detect iOS (no install prompt, show manual instructions)
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const isInStandaloneMode = window.matchMedia('(display-mode: standalone)').matches;
  if (isIos && !isInStandaloneMode) {
    iosBanner.style.display = 'block';
  }

  // ─── Notification Permission ───────────────────────────────────────────────
  async function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  }

  // ─── Toast Helper ──────────────────────────────────────────────────────────
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3500);
  }

  // ─── Socket.io ─────────────────────────────────────────────────────────────
  let socket = null;
  let isTracking = false;
  let gpsWatchId = null;
  let simulatorInterval = null;
  let currentCoords = { lat: null, lng: null, accuracy: null };
  let userName = '';

  function connectSocket(autoStart = false) {
    socket = io({ reconnectionDelay: 2000, reconnectionAttempts: 20 });

    socket.on('connect', () => {
      connectionBadge.textContent = 'Conectado';
      connectionBadge.className = 'badge badge-online';
      radarPulse?.classList.add('active-tracking');
      console.log('[Socket] Connected');

      socket.emit('register-child', userId);

      if (autoStart) {
        startTracking();
      }
    });

    socket.on('disconnect', () => {
      connectionBadge.textContent = 'Reconectando...';
      connectionBadge.className = 'badge badge-offline';
      radarPulse?.classList.remove('active-tracking');
    });

    // Admin revoked access
    socket.on('access-revoked', () => {
      isTracking = false;
      stopGpsTracking();
      stopSimulation();
      clearSession();
      notifyServiceWorker('ACCESS_REVOKED');
      if (wakeLock) { wakeLock.release(); wakeLock = null; }
      showScreen('revoked');
    });
  }

  // ─── Session Storage (localStorage) ───────────────────────────────────────
  function saveSession(token) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId, token, savedAt: Date.now() }));
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  // ─── Browser and OS Detection ──────────────────────────────────────────────
  function detectBrowserAndOS() {
    const ua = navigator.userAgent.toLowerCase();
    const isIos = /iphone|ipad|ipod/i.test(ua);
    const isAndroid = /android/i.test(ua);
    
    // Detect in-app webviews (WhatsApp, Instagram, FB, Messenger, etc)
    const isInApp = /instagram|fbav|fb_iab|messenger|whatsapp/i.test(ua) || (isIos && !/safari/i.test(ua) && /twitter|line|linkedin/i.test(ua));
    
    let browser = 'other';
    if (/chrome|crios/i.test(ua) && !/edge|edg/i.test(ua)) {
      browser = 'chrome';
    } else if (/safari/i.test(ua) && !/chrome|crios|chromium/i.test(ua)) {
      browser = 'safari';
    } else if (/samsungbrowser/i.test(ua)) {
      browser = 'samsung';
    } else if (/firefox|fxios/i.test(ua)) {
      browser = 'firefox';
    }
    
    return { isIos, isAndroid, isInApp, browser };
  }

  function showPermissionHelp() {
    const { isIos, isAndroid, isInApp, browser } = detectBrowserAndOS();
    let html = '';

    if (isInApp) {
      html += `
        <div class="in-app-warning">
          <i class="fa-solid fa-triangle-exclamation"></i>
          Você está no navegador interno do WhatsApp ou Instagram. O iOS/Android bloqueia o acesso ao GPS por aqui por segurança.
        </div>
        <div class="instruction-step">
          <span class="step-number">1</span>
          <div class="step-content">
            <strong>Abra no navegador padrão:</strong><br>
            Toque nos <strong>três pontinhos (...)</strong> ou no ícone da bússola/Safari no canto da tela e selecione <strong>"Abrir no Safari"</strong> ou <strong>"Abrir no Chrome"</strong>.
          </div>
        </div>
      `;
    } else if (isIos) {
      if (browser === 'safari') {
        html += `
          <p style="color: var(--text-secondary); margin-bottom: 16px;">O Safari do seu iPhone bloqueou a localização. Siga os passos:</p>
          <div class="instruction-step">
            <span class="step-number">1</span>
            <div class="step-content">
              Toque no ícone <strong>"aA"</strong> do lado esquerdo na barra de endereços (pesquisa) do Safari.
            </div>
          </div>
          <div class="instruction-step">
            <span class="step-number">2</span>
            <div class="step-content">
              Selecione <strong>"Ajustes do Site"</strong> (Website Settings).
            </div>
          </div>
          <div class="instruction-step">
            <span class="step-number">3</span>
            <div class="step-content">
              Toque em <strong>"Localização"</strong> (Location) e selecione <strong>"Permitir"</strong>.
            </div>
          </div>
          <div class="instruction-step">
            <span class="step-number">4</span>
            <div class="step-content">
              <strong>Puxe a tela para baixo</strong> para atualizar e reativar.
            </div>
          </div>
        `;
      } else {
        html += `
          <p style="color: var(--text-secondary); margin-bottom: 16px;">Siga estas instruções para liberar o GPS no iPhone:</p>
          <div class="instruction-step">
            <span class="step-number">1</span>
            <div class="step-content">
              Abra o aplicativo <strong>"Ajustes"</strong> do seu iPhone.
            </div>
          </div>
          <div class="instruction-step">
            <span class="step-number">2</span>
            <div class="step-content">
              Vá em <strong>"Privacidade e Segurança"</strong> -> <strong>"Serviços de Localização"</strong> e garanta que estão ativados.
            </div>
          </div>
          <div class="instruction-step">
            <span class="step-number">3</span>
            <div class="step-content">
              Role a lista, clique no seu navegador (ex: Chrome) e escolha <strong>"Durante o Uso do App"</strong> com a <strong>"Localização Precisa"</strong> ativada.
            </div>
          </div>
        `;
      }
    } else if (isAndroid) {
      if (browser === 'chrome') {
        html += `
          <p style="color: var(--text-secondary); margin-bottom: 16px;">O Chrome no Android está bloqueando o GPS. Siga estes passos:</p>
          <div class="instruction-step">
            <span class="step-number">1</span>
            <div class="step-content">
              Toque nos <strong>três pontinhos (...)</strong> no canto superior direito do Chrome.
            </div>
          </div>
          <div class="instruction-step">
            <span class="step-number">2</span>
            <div class="step-content">
              Toque no ícone de <strong>Informação (i)</strong> no topo do menu ou vá em <strong>Configurações do Site</strong> -> <strong>Acesso à Localização</strong>.
            </div>
          </div>
          <div class="instruction-step">
            <span class="step-number">3</span>
            <div class="step-content">
              Escolha <strong>"Permitir sempre"</strong> ou <strong>"Permitir durante o uso"</strong>.
            </div>
          </div>
        `;
      } else if (browser === 'samsung') {
        html += `
          <p style="color: var(--text-secondary); margin-bottom: 16px;">O Samsung Internet está bloqueando o GPS. Siga estes passos:</p>
          <div class="instruction-step">
            <span class="step-number">1</span>
            <div class="step-content">
              Toque no <strong>menu de três linhas</strong> no canto inferior direito.
            </div>
          </div>
          <div class="instruction-step">
            <span class="step-number">2</span>
            <div class="step-content">
              Vá em <strong>Configurações</strong> -> <strong>Sites e downloads</strong> -> <strong>Permissões de sites</strong>.
            </div>
          </div>
          <div class="instruction-step">
            <span class="step-number">3</span>
            <div class="step-content">
              Toque em <strong>Localização</strong> e certifique-se de que o site está <strong>Permitido</strong>.
            </div>
          </div>
        `;
      } else {
        html += `
          <p style="color: var(--text-secondary); margin-bottom: 16px;">Siga estas instruções para liberar o GPS no Android:</p>
          <div class="instruction-step">
            <span class="step-number">1</span>
            <div class="step-content">
              Acesse as <strong>Configurações</strong> do celular -> <strong>Aplicativos</strong>.
            </div>
          </div>
          <div class="instruction-step">
            <span class="step-number">2</span>
            <div class="step-content">
              Escolha o seu navegador (ex: Chrome) -> <strong>Permissões</strong>.
            </div>
          </div>
          <div class="instruction-step">
            <span class="step-number">3</span>
            <div class="step-content">
              Selecione <strong>Localização</strong> e marque <strong>Permitir durante o uso</strong>.
            </div>
          </div>
        `;
      }
    } else {
      html += `
        <p style="color: var(--text-secondary); margin-bottom: 16px;">Por favor, ative a permissão de localização nas configurações do seu navegador:</p>
        <div class="instruction-step">
          <span class="step-number">1</span>
          <div class="step-content">
            Vá nas <strong>configurações do navegador</strong> ou clique no ícone de cadeado do lado da URL.
          </div>
        </div>
        <div class="instruction-step">
          <span class="step-number">2</span>
          <div class="step-content">
            Procure por <strong>Permissões de Localização</strong> e defina como <strong>Permitido</strong>.
          </div>
        </div>
      `;
    }

    modalBody.innerHTML = html;
    modalPermission?.classList.add('show');
  }

  // ─── Consent: first time flow & Auto-trigger ────────────────────────────────
  async function triggerConsentFlow(isAuto = false) {
    showScreen('consent');
    if (consentBtn) {
      consentBtn.disabled = true;
      consentBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Solicitando GPS...';
    }

    // Try requesting notifications permission (requires user gesture in some browsers, but we call it anyway)
    try {
      await requestNotificationPermission();
    } catch (e) {
      console.warn('[Notifications] Blocked or unsupported on load:', e);
    }

    // Request GPS permission by trying to get position once
    if (!navigator.geolocation) {
      if (!isAuto) showToast('Este browser não suporta geolocalização.');
      if (consentBtn) {
        consentBtn.disabled = false;
        consentBtn.innerHTML = '<i class="fa-solid fa-shield-check"></i> Autorizar Monitoramento';
      }
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async () => {
        // GPS granted — now confirm consent with server and get token
        try {
          const res = await fetch(`/api/users/${userId}/consent`, { method: 'POST' });
          const data = await res.json();

          if (data.token) {
            saveSession(data.token);
            userName = data.name;
            await beginTracking();
          } else {
            throw new Error('No token returned');
          }
        } catch (err) {
          console.error('[Consent] Error:', err);
          if (!isAuto) showToast('Erro ao confirmar autorização. Tente novamente.');
          if (consentBtn) {
            consentBtn.disabled = false;
            consentBtn.innerHTML = '<i class="fa-solid fa-shield-check"></i> Autorizar Monitoramento';
          }
        }
      },
      (err) => {
        if (!isAuto) {
          let msg = 'GPS não autorizado. Permita o acesso à localização.';
          if (err.code === err.PERMISSION_DENIED) {
            msg = 'Permissão de GPS negada. Vá em Configurações do browser para permitir.';
            showPermissionHelp();
          } else {
            showToast(msg);
          }
        }
        if (consentBtn) {
          consentBtn.disabled = false;
          consentBtn.innerHTML = '<i class="fa-solid fa-shield-check"></i> Autorizar Monitoramento';
        }
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  consentBtn?.addEventListener('click', () => triggerConsentFlow(false));

  // ─── Begin tracking (after consent or auto-reconnect) ─────────────────────
  async function beginTracking() {
    await registerServiceWorker();
    await initBattery();
    await requestWakeLock();

    showScreen('tracking');
    trackerTitle.textContent = 'Rastreamento Ativo';
    trackerStatusDesc.textContent = 'Transmitindo localização para o responsável...';

    notifyServiceWorker('START_TRACKING', { name: userName });
    isTracking = true;

    connectSocket(true);
  }

  // ─── Auto-reconnect (returning visit) ─────────────────────────────────────
  async function checkExistingSession() {
    const session = loadSession();

    // Session belongs to a different userId in the URL — ignore
    if (!session || session.userId !== userId) {
      triggerConsentFlow(true);
      return;
    }

    // Validate token with server
    try {
      const res = await fetch(`/api/users/${userId}/validate-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.token })
      });
      const data = await res.json();

      if (data.valid) {
        // Valid session — auto-start without showing consent screen
        userName = data.name;
        await beginTracking();
      } else if (data.reason === 'not_consented' || data.reason === 'token_mismatch') {
        // Admin revoked or token mismatch
        clearSession();
        showScreen('revoked');
      } else {
        // User not found or other error
        clearSession();
        showScreen('error');
      }
    } catch (err) {
      console.error('[AutoReconnect] Server error:', err);
      // Network error — trigger consent flow just in case
      clearSession();
      triggerConsentFlow(true);
    }
  }

  // ─── Location Sending ──────────────────────────────────────────────────────
  function sendLocation(lat, lng, accuracy) {
    if (!socket?.connected) return;

    currentCoords = { lat, lng, accuracy };
    statLat.textContent = lat.toFixed(6);
    statLng.textContent = lng.toFixed(6);
    statAccuracy.textContent = `${Math.round(accuracy)}m`;

    socket.emit('update-location', {
      userId,
      lat,
      lng,
      accuracy,
      battery: batteryLevel
    });
  }

  // ─── GPS Tracking ──────────────────────────────────────────────────────────
  function startTracking() {
    if (simulatorToggle?.checked) {
      startSimulation();
    } else {
      startGpsTracking();
    }
  }

  function startGpsTracking() {
    stopSimulation();
    if (!navigator.geolocation) return;

    gpsWatchId = navigator.geolocation.watchPosition(
      ({ coords }) => {
        sendLocation(coords.latitude, coords.longitude, coords.accuracy);
      },
      (err) => {
        console.warn('[GPS] Error:', err.message);
        trackerStatusDesc.textContent = 'Aguardando sinal de GPS...';
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  }

  function stopGpsTracking() {
    if (gpsWatchId !== null) {
      navigator.geolocation.clearWatch(gpsWatchId);
      gpsWatchId = null;
    }
  }

  // ─── Simulation ────────────────────────────────────────────────────────────
  const CITY_COORDS = {
    saopaulo:     { lat: -23.55052, lng: -46.633308 },
    riodejaneiro: { lat: -22.971932, lng: -43.185671 },
    novayork:     { lat: 40.785091, lng: -73.968285 },
    lisboa:       { lat: 38.750750, lng: -9.136592 }
  };

  let simLat = 0, simLng = 0, simAngle = 0;

  function startSimulation() {
    stopGpsTracking();
    stopSimulation();

    const center = CITY_COORDS[simulationCity.value] || CITY_COORDS.saopaulo;
    simLat = center.lat;
    simLng = center.lng;
    simAngle = 0;

    sendLocation(simLat, simLng, 12);
    showToast(`Simulador: ${simulationCity.options[simulationCity.selectedIndex].text}`);

    simulatorInterval = setInterval(() => {
      simAngle += 0.15;
      simLat += Math.cos(simAngle) * 0.0002 + (Math.random() - 0.5) * 0.00003;
      simLng += Math.sin(simAngle) * 0.0002 + (Math.random() - 0.5) * 0.00003;
      sendLocation(simLat, simLng, 5 + Math.random() * 8);
    }, 3000);
  }

  function stopSimulation() {
    if (simulatorInterval) {
      clearInterval(simulatorInterval);
      simulatorInterval = null;
    }
  }

  simulatorToggle?.addEventListener('change', (e) => {
    if (e.target.checked) {
      startSimulation();
    } else {
      stopSimulation();
      startGpsTracking();
      showToast('GPS real reativado.');
    }
  });

  simulationCity?.addEventListener('change', () => {
    if (simulatorToggle?.checked) startSimulation();
  });

  // ─── Boot ──────────────────────────────────────────────────────────────────
  checkExistingSession();
});

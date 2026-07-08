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

  // ─── Consent: first time flow ──────────────────────────────────────────────
  consentBtn?.addEventListener('click', async () => {
    consentBtn.disabled = true;
    consentBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Aguardando GPS...';

    await requestNotificationPermission();

    // Request GPS permission by trying to get position once
    if (!navigator.geolocation) {
      showToast('Este browser não suporta geolocalização.');
      consentBtn.disabled = false;
      consentBtn.innerHTML = '<i class="fa-solid fa-shield-check"></i> Autorizar Monitoramento';
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
          showToast('Erro ao confirmar autorização. Tente novamente.');
          consentBtn.disabled = false;
          consentBtn.innerHTML = '<i class="fa-solid fa-shield-check"></i> Autorizar Monitoramento';
        }
      },
      (err) => {
        let msg = 'GPS não autorizado. Permita o acesso à localização.';
        if (err.code === err.PERMISSION_DENIED) {
          msg = 'Permissão de GPS negada. Vá em Configurações do browser para permitir.';
        }
        showToast(msg);
        consentBtn.disabled = false;
        consentBtn.innerHTML = '<i class="fa-solid fa-shield-check"></i> Autorizar Monitoramento';
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });

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
      showScreen('consent');
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
      // Network error — still show consent to be safe
      clearSession();
      showScreen('consent');
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

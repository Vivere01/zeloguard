// ZeloGuard Parent Dashboard Script

let map;
let markers = {}; // userId -> { marker, polyline, history: [] }
let socket;
let currentTab = 'devices';
let selectedUserId = null;

// Avatar Emojis mapping
const AVATAR_EMOJIS = {
  boy: '👦',
  girl: '👧',
  ninja: '🥷',
  superhero: '🦸'
};

document.addEventListener('DOMContentLoaded', () => {
  // Initialize UI
  setupColorSelect();
  setupAvatarSelect();
  initMap();
  initSocket();
  fetchUsers();
});

// 1. Map Initialization
function initMap() {
  // Default to São Paulo center
  map = L.map('map', {
    zoomControl: false // We will use floating controls if needed, default Leaflet is fine
  }).setView([-23.55052, -46.633308], 13);

  // Use CartoDB Dark Matter tiles (premium dark themed map)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);

  // Position zoom controls to the bottom right instead of top left for cleaner look
  L.control.zoom({
    position: 'bottomright'
  }).addTo(map);
}

// 2. Socket.io Integration
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    console.log('Socket connected to server');
    socket.emit('register-parent');
  });

  socket.on('initial-users', (users) => {
    updateDevicesUI(users);
    
    // Draw markers for users with coordinates
    users.forEach(user => {
      if (user.lat && user.lng) {
        updateOrCreateMarker(user);
      }
    });
  });

  socket.on('status-change', (data) => {
    const { userId, status } = data;
    
    // Update list card status indicator
    const card = document.querySelector(`.user-card[data-id="${userId}"]`);
    if (card) {
      const dot = card.querySelector('.status-dot');
      const badge = card.querySelector('.badge');
      
      if (status === 'online') {
        dot.className = 'status-dot online';
        badge.className = 'badge badge-online';
        badge.textContent = 'Online';
      } else {
        dot.className = 'status-dot offline';
        badge.className = 'badge badge-offline';
        badge.textContent = 'Offline';
      }
    }

    // Update marker pulse if it exists
    if (markers[userId]) {
      const el = markers[userId].marker.getElement();
      if (el) {
        const pulse = el.querySelector('.marker-pulse');
        if (pulse) {
          pulse.style.display = (status === 'online') ? 'block' : 'none';
        }
      }
    }
  });

  socket.on('location-updated', (userData) => {
    // Update user detail on list card if it exists
    updateUserCardStats(userData);
    
    // Draw or move on map
    updateOrCreateMarker(userData);
  });

  socket.on('consent-updated', (data) => {
    const { userId, consented } = data;
    const card = document.querySelector(`.user-card[data-id="${userId}"]`);
    if (!card) return;
    const badge = card.querySelector('.consent-badge');
    if (badge) {
      badge.textContent = consented ? 'Autorizado' : 'Revogado';
      badge.style.background = consented ? 'rgba(16,185,129,0.1)' : 'rgba(244,63,94,0.1)';
      badge.style.color = consented ? 'var(--accent-emerald)' : 'var(--accent-rose)';
    }
  });

  socket.on('user-deleted', (userId) => {
    // Remove marker and path from map
    removeUserMapAssets(userId);
    
    // Reload user list
    fetchUsers();
  });
}

// 3. User & Marker Drawing
function updateOrCreateMarker(user) {
  const { id, name, color, avatar, lat, lng, status, history } = user;
  
  if (!lat || !lng) return;

  const isOnline = status === 'online';
  const emoji = AVATAR_EMOJIS[avatar] || '👦';

  // Custom styled Leaflet HTML marker
  const customIcon = L.divIcon({
    className: 'custom-marker',
    html: `
      <div class="custom-leaflet-marker">
        <div class="marker-pulse" style="background: ${color}33; display: ${isOnline ? 'block' : 'none'};"></div>
        <div class="marker-pin" style="background: ${color}; border-color: ${color};"></div>
        <div class="marker-avatar">${emoji}</div>
      </div>
    `,
    iconSize: [40, 40],
    iconAnchor: [20, 20]
  });

  if (markers[id]) {
    // Update position smoothly
    markers[id].marker.setLatLng([lat, lng]);
    markers[id].marker.setIcon(customIcon);
    
    // Update path line
    const pathCoordinates = (history || []).map(h => [h.lat, h.lng]);
    // Include current location as last item if not already in history
    if (pathCoordinates.length === 0 || pathCoordinates[pathCoordinates.length - 1][0] !== lat) {
      pathCoordinates.push([lat, lng]);
    }
    markers[id].polyline.setLatLngs(pathCoordinates);
  } else {
    // Create new marker
    const marker = L.marker([lat, lng], { icon: customIcon }).addTo(map);
    
    // Create popup
    marker.bindPopup(`
      <div style="color: #fff; font-family: sans-serif; font-size: 13px;">
        <strong style="font-size: 15px; color: ${color};">${name}</strong><br>
        Status: ${isOnline ? 'Online' : 'Offline'}<br>
        Bateria: ${user.battery || '--'}%
      </div>
    `, {
      closeButton: false,
      className: 'leaflet-popup-custom'
    });

    // Create polyline for history path
    const pathCoordinates = (history || []).map(h => [h.lat, h.lng]);
    pathCoordinates.push([lat, lng]);

    const polyline = L.polyline(pathCoordinates, {
      color: color,
      weight: 3,
      opacity: 0.6,
      dashArray: '5, 10'
    }).addTo(map);

    markers[id] = { marker, polyline, history: history || [] };
    
    // Center map on first location received
    map.panTo([lat, lng]);
  }
}

function removeUserMapAssets(userId) {
  if (markers[userId]) {
    map.removeLayer(markers[userId].marker);
    map.removeLayer(markers[userId].polyline);
    delete markers[userId];
  }
}

// 4. API Requests
function fetchUsers() {
  fetch('/api/users')
    .then(res => res.json())
    .then(users => {
      updateDevicesUI(users);
      // Clean obsolete markers
      const userIds = users.map(u => u.id);
      Object.keys(markers).forEach(mid => {
        if (!userIds.includes(mid)) {
          removeUserMapAssets(mid);
        }
      });
    })
    .catch(err => console.error('Error fetching users:', err));
}

function registerUser(event) {
  event.preventDefault();
  const nameInput = document.getElementById('child-name');
  const colorInput = document.getElementById('child-color');
  const avatarInput = document.getElementById('child-avatar');

  const payload = {
    name: nameInput.value.trim(),
    color: colorInput.value,
    avatar: avatarInput.value
  };

  fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(res => res.json())
    .then(newUser => {
      // Clear form
      nameInput.value = '';
      
      // Copy tracking link automatically
      const trackingLink = `${window.location.origin}/child.html?id=${newUser.id}`;
      copyToClipboard(trackingLink);
      
      showToast(`Perfil de ${newUser.name} criado! Link copiado para a área de transferência.`);
      
      // Refresh UI & switch tab
      fetchUsers();
      switchTab('devices');
    })
    .catch(err => {
      console.error('Error registering user:', err);
      showToast('Erro ao cadastrar usuário');
    });
}

function deleteUser(userId, name) {
  if (!confirm(`Deseja realmente excluir o perfil de ${name}? Esta ação é irreversível.`)) return;

  fetch(`/api/users/${userId}`, { method: 'DELETE' })
    .then(res => res.json())
    .then(() => {
      showToast(`Perfil de ${name} excluído.`);
      fetchUsers();
    })
    .catch(err => {
      console.error('Error deleting user:', err);
      showToast('Erro ao excluir usuário');
    });
}

function revokeAccess(userId, name) {
  if (!confirm(`Revogar acesso de ${name}? O dispositivo será desconectado imediatamente e precisará ser autorizado novamente.`)) return;

  fetch(`/api/users/${userId}/revoke`, { method: 'POST' })
    .then(res => res.json())
    .then(() => {
      showToast(`Acesso de ${name} revogado. Dispositivo desconectado.`);
      fetchUsers();
    })
    .catch(err => {
      console.error('Error revoking access:', err);
      showToast('Erro ao revogar acesso');
    });
}

// 5. DOM & UI Manipulation Helpers
function updateDevicesUI(users) {
  const emptyState = document.getElementById('empty-state');
  const userList = document.getElementById('user-list');
  
  userList.innerHTML = '';

  if (users.length === 0) {
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';

  users.forEach(user => {
    const isOnline = user.status === 'online';
    const isConsented = user.consented === true;
    const trackingUrl = `${window.location.origin}/child.html?id=${user.id}`;
    const emoji = AVATAR_EMOJIS[user.avatar] || '👦';
    
    const timeStr = user.lastSeen 
      ? new Date(user.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '--:--';

    const card = document.createElement('div');
    card.className = `user-card ${selectedUserId === user.id ? 'active-selected' : ''}`;
    card.setAttribute('data-id', user.id);
    
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn') || e.target.closest('.user-card-actions')) return;
      document.querySelectorAll('.user-card').forEach(c => c.classList.remove('active-selected'));
      card.classList.add('active-selected');
      selectedUserId = user.id;
      if (user.lat && user.lng) {
        map.setView([user.lat, user.lng], 16, { animate: true });
        if (markers[user.id]) markers[user.id].marker.openPopup();
      } else {
        showToast(`${user.name} ainda não transmitiu nenhuma localização.`);
      }
    });

    card.innerHTML = `
      <div class="user-card-header">
        <div class="user-card-info">
          <div class="user-avatar-wrapper">
            <div class="user-avatar" style="border-color: ${user.color}">
              <span style="font-size: 20px;">${emoji}</span>
            </div>
            <div class="status-dot ${isOnline ? 'online' : 'offline'}"></div>
          </div>
          <div>
            <span class="user-name">${user.name}</span>
            <span class="user-status-text" id="status-text-${user.id}">Visto por último: ${timeStr}</span>
          </div>
        </div>
        <span class="badge ${isOnline ? 'badge-online' : 'badge-offline'}">
          ${isOnline ? 'Online' : 'Offline'}
        </span>
      </div>

      <div class="user-card-details">
        <div class="detail-item">
          <i class="fa-solid fa-battery-three-quarters"></i>
          <span id="bat-${user.id}">Bateria: ${user.battery != null ? user.battery + '%' : '--'}</span>
        </div>
        <div class="detail-item">
          <i class="fa-solid fa-bullseye"></i>
          <span id="acc-${user.id}">Precisão: ${user.accuracy != null ? Math.round(user.accuracy) + 'm' : '--'}</span>
        </div>
        <div class="detail-item" style="grid-column: span 2;">
          <i class="fa-solid fa-key" style="color: ${isConsented ? 'var(--accent-emerald)' : 'var(--accent-rose)'}"></i>
          <span class="consent-badge" style="font-size:0.78rem;padding:2px 8px;border-radius:20px;font-weight:600;background:${isConsented ? 'rgba(16,185,129,0.1)' : 'rgba(244,63,94,0.1)'};color:${isConsented ? 'var(--accent-emerald)' : 'var(--accent-rose)'}">${isConsented ? 'Autorizado' : 'Aguard. Aceite'}</span>
        </div>
      </div>

      <div class="user-card-actions">
        <button class="btn btn-secondary" onclick="copyToClipboard('${trackingUrl}')" title="Copiar link">
          <i class="fa-solid fa-copy"></i> Link
        </button>
        <button class="btn btn-danger" onclick="revokeAccess('${user.id}', '${user.name}')" title="Revogar acesso" ${!isConsented ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>
          <i class="fa-solid fa-ban"></i> Revogar
        </button>
        <button class="btn btn-danger" onclick="deleteUser('${user.id}', '${user.name}')" title="Excluir perfil" style="padding:8px 10px;">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    `;

    userList.appendChild(card);
  });
}

function updateUserCardStats(userData) {
  const { id, lastSeen, accuracy, battery, status } = userData;
  
  const timeStr = lastSeen 
    ? new Date(lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--:--';
    
  const statusTextEl = document.getElementById(`status-text-${id}`);
  const batEl = document.getElementById(`bat-${id}`);
  const accEl = document.getElementById(`acc-${id}`);
  
  if (statusTextEl) statusTextEl.textContent = `Visto por último: ${timeStr}`;
  if (batEl) batEl.textContent = `Bateria: ${battery != null ? battery + '%' : '--'}`;
  if (accEl) accEl.textContent = `Precisão: ${accuracy != null ? Math.round(accuracy) + 'm' : '--'}`;
}

// 6. Navigation Tabs & Controls Setup
function switchTab(tabId) {
  currentTab = tabId;
  
  // Update tabs indicators
  document.getElementById('tab-devices').className = tabId === 'devices' ? 'tab-btn active' : 'tab-btn';
  document.getElementById('tab-register').className = tabId === 'register' ? 'tab-btn active' : 'tab-btn';

  // Toggle panels
  document.getElementById('panel-devices').className = tabId === 'devices' ? 'tab-panel active' : 'tab-panel';
  document.getElementById('panel-register').className = tabId === 'register' ? 'tab-panel active' : 'tab-panel';
}

function setupColorSelect() {
  const dots = document.querySelectorAll('.color-dot-preset');
  const hiddenInput = document.getElementById('child-color');

  dots.forEach(dot => {
    dot.addEventListener('click', () => {
      dots.forEach(d => {
        d.style.borderColor = 'transparent';
        d.style.boxShadow = 'none';
        d.classList.remove('selected');
      });

      const color = dot.getAttribute('data-color');
      dot.style.borderColor = '#fff';
      dot.style.boxShadow = `0 0 0 2px ${color}`;
      dot.classList.add('selected');
      hiddenInput.value = color;
    });
  });
}

function setupAvatarSelect() {
  const options = document.querySelectorAll('.avatar-option');
  const hiddenInput = document.getElementById('child-avatar');

  options.forEach(opt => {
    opt.addEventListener('click', () => {
      options.forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      hiddenInput.value = opt.getAttribute('data-avatar');
    });
  });
}

// Clipboard copying utility
function copyToClipboard(text) {
  navigator.clipboard.writeText(text)
    .then(() => showToast('Link copiado para a área de transferência!'))
    .catch(err => {
      console.error('Error copying text:', err);
      // Fallback
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      showToast('Link copiado (fallback)!');
    });
}

// Toast System
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast show';
  setTimeout(() => {
    toast.className = 'toast';
  }, 3500);
}

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Determine database file path based on environment
const IS_VERCEL = process.env.VERCEL || process.env.NOW_REGION;
const PACKAGED_DB_FILE = path.join(__dirname, 'db.json');
const DB_FILE = IS_VERCEL ? '/tmp/db.json' : PACKAGED_DB_FILE;

// Copy initial db.json to /tmp if running on Vercel and it doesn't exist
if (IS_VERCEL && !fs.existsSync(DB_FILE)) {
  try {
    if (fs.existsSync(PACKAGED_DB_FILE)) {
      fs.copyFileSync(PACKAGED_DB_FILE, DB_FILE);
    } else {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: [] }, null, 2));
    }
  } catch (err) {
    console.error('Failed to initialize database in /tmp:', err);
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database helper functions
function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { users: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading database, resetting:', err);
    const initial = { users: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

function writeDb(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error writing to database:', err);
  }
}

// REST API
app.get('/api/users', (req, res) => {
  const db = readDb();
  res.json(db.users);
});

app.post('/api/users', (req, res) => {
  const { name, color, avatar } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const db = readDb();
  const id = 'child_' + Math.random().toString(36).substr(2, 9);
  
  const newUser = {
    id,
    name,
    color: color || '#6366f1',
    avatar: avatar || 'boy',
    status: 'offline',
    consented: false,
    sessionToken: null,
    consentedAt: null,
    lastSeen: null,
    lat: null,
    lng: null,
    accuracy: null,
    battery: null,
    history: []
  };

  db.users.push(newUser);
  writeDb(db);

  res.status(201).json(newUser);
});

app.delete('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const index = db.users.findIndex(u => u.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'User not found' });
  }
  db.users.splice(index, 1);
  writeDb(db);
  
  // Notify parents that user was deleted
  io.emit('user-deleted', id);
  
  res.json({ success: true });
});

// Child confirms consent — saves session token
app.post('/api/users/:id/consent', (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const user = db.users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Generate a simple session token
  const token = 'tok_' + Math.random().toString(36).substr(2, 16) + Date.now().toString(36);
  user.consented = true;
  user.sessionToken = token;
  user.consentedAt = new Date().toISOString();
  writeDb(db);

  res.json({ token, userId: id, name: user.name });
});

// Admin validates existing session token (called on child reconnect)
app.post('/api/users/:id/validate-token', (req, res) => {
  const { id } = req.params;
  const { token } = req.body;
  const db = readDb();
  const user = db.users.find(u => u.id === id);

  if (!user) return res.status(404).json({ valid: false, reason: 'not_found' });
  if (!user.consented) return res.json({ valid: false, reason: 'not_consented' });
  if (user.sessionToken !== token) return res.json({ valid: false, reason: 'token_mismatch' });

  res.json({ valid: true, name: user.name, color: user.color, avatar: user.avatar });
});

// Admin revokes child access
app.post('/api/users/:id/revoke', (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const user = db.users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.consented = false;
  user.sessionToken = null;
  user.status = 'offline';
  writeDb(db);

  // Force disconnect any active child socket
  const childSocketId = activeChildren.get(id);
  if (childSocketId) {
    const childSocket = io.sockets.sockets.get(childSocketId);
    if (childSocket) {
      childSocket.emit('access-revoked');
      childSocket.disconnect(true);
    }
    activeChildren.delete(id);
  }

  io.to('parents').emit('status-change', { userId: id, status: 'offline', consented: false });
  io.to('parents').emit('consent-updated', { userId: id, consented: false });

  res.json({ success: true });
});

// Socket.io Real-time tracking logic
const activeChildren = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Parent dashboard registering for updates
  socket.on('register-parent', () => {
    socket.join('parents');
    console.log('Parent registered:', socket.id);
    
    // Send current status of all users to the newly connected parent
    const db = readDb();
    const updatedUsers = db.users.map(user => ({
      ...user,
      status: activeChildren.has(user.id) ? 'online' : 'offline'
    }));
    socket.emit('initial-users', updatedUsers);
  });

  // Child tracker registering
  socket.on('register-child', (userId) => {
    socket.join(userId);
    socket.userId = userId;
    activeChildren.set(userId, socket.id);
    console.log(`Child registered: ${userId} (${socket.id})`);

    // Update database status
    const db = readDb();
    const user = db.users.find(u => u.id === userId);
    if (user) {
      user.status = 'online';
      writeDb(db);
      // Notify parents
      io.to('parents').emit('status-change', { userId, status: 'online' });
    }
  });

  // Handle location update from child
  socket.on('update-location', (data) => {
    const { userId, lat, lng, accuracy, battery } = data;
    if (!userId || lat == null || lng == null) return;

    const db = readDb();
    const user = db.users.find(u => u.id === userId);
    if (user) {
      user.lat = lat;
      user.lng = lng;
      user.accuracy = accuracy;
      user.battery = battery;
      user.lastSeen = new Date().toISOString();
      user.status = 'online';

      // Keep location history up to 50 entries
      if (!user.history) user.history = [];
      user.history.push({ lat, lng, timestamp: user.lastSeen });
      if (user.history.length > 50) {
        user.history.shift();
      }

      writeDb(db);

      // Broadcast update to parents
      io.to('parents').emit('location-updated', {
        id: user.id,
        name: user.name,
        color: user.color,
        avatar: user.avatar,
        status: 'online',
        lastSeen: user.lastSeen,
        lat,
        lng,
        accuracy,
        battery,
        history: user.history
      });
    }
  });

  socket.on('disconnect', () => {
    // If a child socket disconnected, update status to offline
    if (socket.userId && activeChildren.get(socket.userId) === socket.id) {
      const userId = socket.userId;
      activeChildren.delete(userId);
      console.log(`Child disconnected: ${userId}`);

      const db = readDb();
      const user = db.users.find(u => u.id === userId);
      if (user) {
        user.status = 'offline';
        writeDb(db);
        io.to('parents').emit('status-change', { userId, status: 'offline' });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`ZeloGuard server running on port ${PORT}`);
});

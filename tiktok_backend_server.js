// tiktok_backend_server.js
// Servidor Backend para conectar con TikTok Live (compatible con Render + Socket.IO)

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
app.use(cors());
app.use(express.json());

// ---- Servidor HTTP + Socket.IO (clave para Render) ----
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',           // si quieres, cámbialo por tu dominio estático
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'] // Render a veces usa polling de fallback
});

// ---- Config ----
const PORT = process.env.PORT || 3000;

// Almacenar conexiones activas por username
const activeConnections = new Map();

// Healthcheck / estado
app.get('/', (req, res) => {
  res.json({
    status: 'Server running',
    message: 'TikTok Live Chat Reader Backend',
    activeConnections: activeConnections.size
  });
});

// ---------- API: verificar si un usuario está en vivo ----------
app.post('/api/check-live', async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const tiktokConnection = new WebcastPushConnection(username, {
      enableExtendedGiftInfo: true
    });

    await tiktokConnection.connect();

    // Si conectó, está en vivo
    res.json({
      isLive: true,
      username,
      message: 'Usuario está en vivo'
    });

    // Desconectar (solo era verificación)
    tiktokConnection.disconnect();
  } catch (error) {
    // Si falla la conexión, lo más probable es que no esté en vivo
    res.json({
      isLive: false,
      username,
      message: 'Usuario NO está en vivo o el username es incorrecto',
      error: error.message
    });
  }
});

// ---------- API: iniciar conexión al chat de un usuario ----------
app.post('/api/start-chat', async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  // Si ya existe, no abras otra
  if (activeConnections.has(username)) {
    return res.json({
      success: true,
      message: 'Ya existe una conexión activa para este usuario',
      username
    });
  }

  try {
    const tiktokConnection = new WebcastPushConnection(username, {
      enableExtendedGiftInfo: true,
      enableWebsocketUpgrade: true,
      requestPollingIntervalMs: 1000
    });

    // Guarda conexión
    activeConnections.set(username, tiktokConnection);

    // ----- Eventos TikTok -----
    tiktokConnection
      .connect()
      .then((state) => {
        console.log(`✅ Conectado a sala @${state.roomInfo?.owner?.uniqueId || username}`);
        io.emit('tiktok-status', {
          type: 'connected',
          username,
          roomInfo: {
            title: state.roomInfo?.title,
            viewers: state.roomInfo?.userCount
          }
        });
      })
      .catch((err) => {
        console.error('❌ Error al conectar:', err);
        activeConnections.delete(username);
        io.emit('tiktok-status', {
          type: 'error',
          username,
          error: err.message
        });
      });

    // Mensajes de chat
    tiktokConnection.on('chat', (data) => {
      const message = {
        username: data.uniqueId,
        nickname: data.nickname,
        message: data.comment,
        timestamp: new Date().toISOString(),
        profilePicture: data.profilePictureUrl
      };
      console.log(`💬 ${data.uniqueId}: ${data.comment}`);
      io.emit('tiktok-message', message);
    });

    // Usuario se une
    tiktokConnection.on('member', (data) => {
      const joinMessage = {
        username: data.uniqueId,
        nickname: data.nickname,
        message: '¡Se unió al stream!',
        timestamp: new Date().toISOString(),
        type: 'join'
      };
      console.log(`👋 ${data.uniqueId} se unió`);
      io.emit('tiktok-join', joinMessage);
    });

    // Likes
    tiktokConnection.on('like', (data) => {
      const likeMessage = {
        username: data.uniqueId,
        nickname: data.nickname,
        likeCount: data.likeCount,
        totalLikes: data.totalLikeCount,
        timestamp: new Date().toISOString(),
        type: 'like'
      };
      console.log(`❤️ ${data.uniqueId} dio ${data.likeCount} likes`);
      io.emit('tiktok-like', likeMessage);
    });

    // Regalos
    tiktokConnection.on('gift', (data) => {
      const giftMessage = {
        username: data.uniqueId,
        nickname: data.nickname,
        giftName: data.giftName,
        giftCount: data.repeatCount,
        diamondValue: data.diamondCount,
        timestamp: new Date().toISOString(),
        type: 'gift'
      };
      console.log(`🎁 ${data.uniqueId} envió ${data.repeatCount}x ${data.giftName}`);
      io.emit('tiktok-gift', giftMessage);
    });

    // Compartir
    tiktokConnection.on('share', (data) => {
      const shareMessage = {
        username: data.uniqueId,
        nickname: data.nickname,
        timestamp: new Date().toISOString(),
        type: 'share'
      };
      console.log(`🔄 ${data.uniqueId} compartió el stream`);
      io.emit('tiktok-share', shareMessage);
    });

    // Follow
    tiktokConnection.on('follow', (data) => {
      const followMessage = {
        username: data.uniqueId,
        nickname: data.nickname,
        timestamp: new Date().toISOString(),
        type: 'follow'
      };
      console.log(`⭐ ${data.uniqueId} te siguió`);
      io.emit('tiktok-follow', followMessage);
    });

    // Stream termina
    tiktokConnection.on('streamEnd', () => {
      console.log('🔴 El stream ha terminado');
      io.emit('tiktok-status', {
        type: 'ended',
        username,
        message: 'El stream ha terminado'
      });
      activeConnections.delete(username);
    });

    // Desconectado
    tiktokConnection.on('disconnected', () => {
      console.log('⚠️ Desconectado del stream');
      io.emit('tiktok-status', {
        type: 'disconnected',
        username
      });
      activeConnections.delete(username);
    });

    return res.json({
      success: true,
      message: 'Conexión iniciada',
      username
    });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ---------- API: detener conexión ----------
app.post('/api/stop-chat', (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const connection = activeConnections.get(username);

  if (connection) {
    connection.disconnect();
    activeConnections.delete(username);

    io.emit('tiktok-status', {
      type: 'stopped',
      username
    });

    return res.json({
      success: true,
      message: 'Conexión detenida',
      username
    });
  } else {
    return res.json({
      success: false,
      message: 'No hay conexión activa para este usuario'
    });
  }
});

// ---------- Socket.IO: conexión de clientes ----------
io.on('connection', (socket) => {
  console.log('🔌 Cliente conectado:', socket.id);

  socket.on('disconnect', () => {
    console.log('❌ Cliente desconectado:', socket.id);
  });
});

// ---------- Iniciar servidor HTTP (¡no uses app.listen en Render!) ----------
server.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════╗
  ║   🎵 TikTok Live Chat Server          ║
  ║   Servidor corriendo en puerto ${PORT}   ║
  ╚════════════════════════════════════════╝
  `);
});

// Cierre limpio
process.on('SIGTERM', () => {
  console.log('Recibido SIGTERM. Cerrando servidor...');
  server.close(() => process.exit(0));
});

process.on('unhandledRejection', (error) => {
  console.error('Error no manejado:', error);
});

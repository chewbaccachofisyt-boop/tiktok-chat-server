// servidor-tiktok.js
// Servidor Backend para conectar con TikTok Live

const express = require('express');
const cors = require('cors');
const { WebcastPushConnection } = require('tiktok-live-connector');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Configuración
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// Almacenar conexiones activas
const activeConnections = new Map();

// Ruta principal
app.get('/', (req, res) => {
    res.json({ 
        status: 'Server running', 
        message: 'TikTok Live Chat Reader Backend',
        activeConnections: activeConnections.size
    });
});

// Endpoint para verificar si un usuario está en vivo
app.post('/api/check-live', async (req, res) => {
    const { username } = req.body;
    
    if (!username) {
        return res.status(400).json({ error: 'Username is required' });
    }
    
    try {
        // Intentar conectar para verificar si está en vivo
        const tiktokConnection = new WebcastPushConnection(username, {
            enableExtendedGiftInfo: true
        });
        
        await tiktokConnection.connect();
        
        // Si llegamos aquí, está en vivo
        res.json({ 
            isLive: true, 
            username: username,
            message: 'Usuario está en vivo'
        });
        
        // Desconectar inmediatamente, solo era para verificar
        tiktokConnection.disconnect();
        
    } catch (error) {
        // Si falla, probablemente no está en vivo
        res.json({ 
            isLive: false, 
            username: username,
            message: 'Usuario NO está en vivo o el username es incorrecto',
            error: error.message
        });
    }
});

// Endpoint para iniciar conexión al chat
app.post('/api/start-chat', async (req, res) => {
    const { username } = req.body;
    
    if (!username) {
        return res.status(400).json({ error: 'Username is required' });
    }
    
    // Verificar si ya existe una conexión para este usuario
    if (activeConnections.has(username)) {
        return res.json({ 
            success: true, 
            message: 'Ya existe una conexión activa para este usuario',
            username: username
        });
    }
    
    try {
        const tiktokConnection = new WebcastPushConnection(username, {
            enableExtendedGiftInfo: true,
            enableWebsocketUpgrade: true,
            requestPollingIntervalMs: 1000
        });
        
        // Guardar la conexión
        activeConnections.set(username, tiktokConnection);
        
        // Evento: Conectado
        tiktokConnection.connect().then(state => {
            console.log(`✅ Conectado a @${state.roomInfo.owner.uniqueId}`);
            io.emit('tiktok-status', {
                type: 'connected',
                username: username,
                roomInfo: {
                    title: state.roomInfo.title,
                    viewers: state.roomInfo.userCount
                }
            });
        }).catch(err => {
            console.error('❌ Error al conectar:', err);
            activeConnections.delete(username);
            io.emit('tiktok-status', {
                type: 'error',
                username: username,
                error: err.message
            });
        });
        
        // Evento: Nuevo mensaje de chat
        tiktokConnection.on('chat', data => {
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
        
        // Evento: Usuario se une
        tiktokConnection.on('member', data => {
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
        
        // Evento: Like
        tiktokConnection.on('like', data => {
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
        
        // Evento: Regalo
        tiktokConnection.on('gift', data => {
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
        
        // Evento: Share
        tiktokConnection.on('share', data => {
            const shareMessage = {
                username: data.uniqueId,
                nickname: data.nickname,
                timestamp: new Date().toISOString(),
                type: 'share'
            };
            
            console.log(`🔄 ${data.uniqueId} compartió el stream`);
            io.emit('tiktok-share', shareMessage);
        });
        
        // Evento: Follow
        tiktokConnection.on('follow', data => {
            const followMessage = {
                username: data.uniqueId,
                nickname: data.nickname,
                timestamp: new Date().toISOString(),
                type: 'follow'
            };
            
            console.log(`⭐ ${data.uniqueId} te siguió`);
            io.emit('tiktok-follow', followMessage);
        });
        
        // Evento: Stream terminado
        tiktokConnection.on('streamEnd', () => {
            console.log('🔴 El stream ha terminado');
            io.emit('tiktok-status', {
                type: 'ended',
                username: username,
                message: 'El stream ha terminado'
            });
            activeConnections.delete(username);
        });
        
        // Evento: Desconectado
        tiktokConnection.on('disconnected', () => {
            console.log('⚠️ Desconectado del stream');
            io.emit('tiktok-status', {
                type: 'disconnected',
                username: username
            });
            activeConnections.delete(username);
        });
        
        res.json({ 
            success: true, 
            message: 'Conexión iniciada',
            username: username
        });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

// Endpoint para detener conexión
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
            username: username
        });
        
        res.json({ 
            success: true, 
            message: 'Conexión detenida',
            username: username
        });
    } else {
        res.json({ 
            success: false, 
            message: 'No hay conexión activa para este usuario'
        });
    }
});

// WebSocket - cuando un cliente se conecta
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('❌ Cliente desconectado:', socket.id);
    });
});

// Iniciar servidor
http.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════╗
    ║   🎵 TikTok Live Chat Server          ║
    ║   Servidor corriendo en puerto ${PORT}   ║
    ╚════════════════════════════════════════╝
    `);
});

// Manejo de errores
process.on('unhandledRejection', (error) => {
    console.error('Error no manejado:', error);
});

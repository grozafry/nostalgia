/**
 * Nostalgia Engine – Multiplayer Server
 * Serves game_mp.html over HTTP AND handles WebSocket on the SAME port.
 *
 * Run locally:   node server.js
 * Deploy:        any Node.js host (Railway, Render, Fly.io, VPS, etc.)
 * Requires:      npm install ws
 */

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── HTTP: serve game_mp.html + assets ─────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
    // Serve the game HTML at /
    const file = req.url === '/' || req.url === '/index.html'
        ? 'game_mp.html'
        : req.url.slice(1); // allow other static files in the same dir

    const filePath = path.join(__dirname, file);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        const ext = path.extname(filePath);
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    });
});

httpServer.listen(PORT, () => {
    console.log(`🎮 Nostalgia Engine running on http://localhost:${PORT}`);
    console.log(`   WebSocket ready on ws://localhost:${PORT}`);
});

// ── WebSocket: attach to the same HTTP server ──────────────────────────────────
// rooms: Map<roomCode, { clients: Map<playerId, {ws, name, pos, rotY}>, objects: objData[] }>
const rooms = new Map();

function getRoom(code) {
    if (!rooms.has(code)) rooms.set(code, { clients: new Map(), objects: [] });
    return rooms.get(code);
}

function broadcast(room, msg, excludeId = null) {
    const data = JSON.stringify(msg);
    room.clients.forEach((client, id) => {
        if (id !== excludeId && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(data);
        }
    });
}

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
    let playerId = null;
    let roomCode = null;
    let playerName = 'Unknown';

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {

            case 'join': {
                playerId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                roomCode = msg.room || 'default';
                playerName = msg.name || `Player_${playerId.slice(-4)}`;

                const room = getRoom(roomCode);
                room.clients.set(playerId, { ws, name: playerName, pos: { x: 0, y: 1.6, z: 5 }, rotY: 0 });

                // Send welcome with world state and existing players
                const existingPlayers = [];
                room.clients.forEach((c, id) => {
                    if (id !== playerId) existingPlayers.push({ playerId: id, name: c.name, pos: c.pos, rotY: c.rotY });
                });
                ws.send(JSON.stringify({
                    type: 'welcome',
                    playerId,
                    worldState: room.objects,
                    players: existingPlayers,
                }));

                // Announce to others
                broadcast(room, { type: 'player_joined', playerId, name: playerName }, playerId);
                console.log(`[JOIN] ${playerName} (${playerId}) → room "${roomCode}"`);
                break;
            }

            case 'player_move': {
                if (!playerId || !roomCode) return;
                const room = getRoom(roomCode);
                const client = room.clients.get(playerId);
                if (client) { client.pos = msg.pos; client.rotY = msg.rotY; }
                broadcast(room, { type: 'player_move', playerId, name: playerName, pos: msg.pos, rotY: msg.rotY }, playerId);
                break;
            }

            case 'place_object': {
                if (!playerId || !roomCode) return;
                const room = getRoom(roomCode);
                room.objects.push(msg.objData);
                broadcast(room, { type: 'place_object', playerId, objData: msg.objData }, playerId);
                break;
            }

            case 'delete_object': {
                if (!playerId || !roomCode) return;
                const room = getRoom(roomCode);
                // Remove from server-side world state by position proximity
                room.objects = room.objects.filter(o => {
                    const dx = o.pos.x - msg.pos.x, dy = o.pos.y - msg.pos.y, dz = o.pos.z - msg.pos.z;
                    return Math.sqrt(dx * dx + dy * dy + dz * dz) > 0.1;
                });
                broadcast(room, { type: 'delete_object', playerId, pos: msg.pos }, playerId);
                break;
            }

            case 'video_frame': {
                // Relay a compressed video frame from a board's camera to all other players
                // msg.boardPos: {x,y,z}  msg.frameData: base64 jpeg string
                if (!playerId || !roomCode) return;
                const room = getRoom(roomCode);
                broadcast(room, {
                    type: 'video_frame',
                    playerId,
                    name: playerName,
                    boardPos: msg.boardPos,
                    frameData: msg.frameData,
                }, playerId);
                break;
            }
        }
    });

    ws.on('close', () => {
        if (!playerId || !roomCode) return;
        const room = getRoom(roomCode);
        room.clients.delete(playerId);
        broadcast(room, { type: 'player_leave', playerId, name: playerName });
        console.log(`[LEAVE] ${playerName} left room "${roomCode}"`);
        // Clean up empty rooms
        if (room.clients.size === 0) rooms.delete(roomCode);
    });

    ws.on('error', (err) => console.error('WS error:', err.message));
});

console.log(`🎮 Nostalgia Engine Multiplayer Server running on ws://localhost:${PORT}`);

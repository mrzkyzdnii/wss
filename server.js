import { WebSocketServer } from 'ws';
import http from 'http';
import crypto from 'crypto';

const PORT = process.env.PORT || 8082;

// ==== Config dunia game ====
const GRID_W = 20;
const GRID_H = 14;
const MAX_COINS = 8;
const MOVE_COOLDOWN_MS = 120; // anti-spam gerak
const PALETTE = ['#ff004d', '#00e756', '#29adff', '#ffec27', '#ff77a8', '#ab5236', '#00e5ff', '#ffa300'];

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: '8BitGame v1.0', uptime: process.uptime() }));
});

const wss = new WebSocketServer({ server });

// room = Map<roomId, { players: Map<clientId, playerObj>, coins: [{x,y}], clients: Map<clientId, ws> }>
const rooms = new Map();

function genId() {
    return 'p_' + crypto.randomBytes(6).toString('hex');
}

function randTile() {
    return { x: Math.floor(Math.random() * GRID_W), y: Math.floor(Math.random() * GRID_H) };
}

function spawnCoins(room) {
    while (room.coins.length < MAX_COINS) {
        const tile = randTile();
        const occupied = room.coins.some(c => c.x === tile.x && c.y === tile.y);
        if (!occupied) room.coins.push(tile);
    }
}

function getRoom(roomId) {
    if (!rooms.has(roomId)) {
        const room = { players: new Map(), coins: [], clients: new Map() };
        spawnCoins(room);
        rooms.set(roomId, room);
    }
    return rooms.get(roomId);
}

function send(ws, type, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type, data, time: Date.now() }));
}

function broadcastState(room) {
    const players = [...room.players.values()];
    const payload = { players, coins: room.coins, grid: { w: GRID_W, h: GRID_H } };
    for (const ws of room.clients.values()) send(ws, 'state', payload);
}

function broadcastChat(room, from, color, text) {
    const payload = { from, color, text, time: Date.now() };
    for (const ws of room.clients.values()) send(ws, 'chat', payload);
}

function broadcastSystem(room, text) {
    for (const ws of room.clients.values()) send(ws, 'system', { text });
}

wss.on('connection', (ws) => {
    const clientId = genId();
    let joinedRoom = null;
    let player = null;
    let lastMove = 0;

    console.log(`[+] Client: ${clientId}`);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

        // ==== JOIN ====
        if (msg.type === 'join') {
            const roomId = String(msg.room || 'default').slice(0, 100);
            const name = String(msg.name || 'Player').slice(0, 20);
            const room = getRoom(roomId);

            const color = PALETTE[room.players.size % PALETTE.length];
            const start = randTile();
            player = { id: clientId, name, color, x: start.x, y: start.y, score: 0 };

            room.players.set(clientId, player);
            room.clients.set(clientId, ws);
            joinedRoom = room;

            send(ws, 'joined', { id: clientId, grid: { w: GRID_W, h: GRID_H } });
            broadcastSystem(room, `${name} bergabung ke game`);
            broadcastState(room);
            return;
        }

        if (!joinedRoom || !player) return; // harus join dulu

        // ==== MOVE ====
        if (msg.type === 'move') {
            const now = Date.now();
            if (now - lastMove < MOVE_COOLDOWN_MS) return;
            lastMove = now;

            let { x, y } = player;
            if (msg.dir === 'up') y -= 1;
            else if (msg.dir === 'down') y += 1;
            else if (msg.dir === 'left') x -= 1;
            else if (msg.dir === 'right') x += 1;
            else return;

            x = Math.max(0, Math.min(GRID_W - 1, x));
            y = Math.max(0, Math.min(GRID_H - 1, y));
            player.x = x;
            player.y = y;

            const coinIdx = joinedRoom.coins.findIndex(c => c.x === x && c.y === y);
            if (coinIdx !== -1) {
                joinedRoom.coins.splice(coinIdx, 1);
                player.score += 1;
                spawnCoins(joinedRoom);
                broadcastSystem(joinedRoom, `${player.name} ambil koin! Skor: ${player.score}`);
            }

            broadcastState(joinedRoom);
            return;
        }

        // ==== CHAT ====
        if (msg.type === 'chat') {
            const text = String(msg.text || '').slice(0, 200).trim();
            if (!text) return;
            broadcastChat(joinedRoom, player.name, player.color, text);
            return;
        }
    });

    ws.on('close', () => {
        if (joinedRoom && player) {
            joinedRoom.players.delete(clientId);
            joinedRoom.clients.delete(clientId);
            broadcastSystem(joinedRoom, `${player.name} keluar dari game`);
            broadcastState(joinedRoom);

            // bersihkan room kosong
            if (joinedRoom.players.size === 0) {
                for (const [rid, r] of rooms.entries()) {
                    if (r === joinedRoom) { rooms.delete(rid); break; }
                }
            }
        }
        console.log(`[-] Client: ${clientId}`);
    });
});

server.listen(PORT, () => {
    console.log('========================================');
    console.log('  8BitGame v1.0 (realtime + chat)');
    console.log(`  Port: ${PORT}`);
    console.log('========================================');
});

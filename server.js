import { WebSocketServer } from 'ws';
import http from 'http';
import crypto from 'crypto';

const PORT = process.env.PORT || 8083;

// ==== Config dunia ====
const GRID_W = 20;
const GRID_H = 14;
const MOVE_COOLDOWN_MS = 150;
const JUMP_COOLDOWN_MS = 450;
const HITS_TO_BREAK = 3;
const REACH = 2; // jangkauan tile buat break/place
const PALETTE = ['#ff004d', '#00e756', '#29adff', '#ffec27', '#ff77a8', '#ab5236', '#00e5ff', '#ffa300'];
const BREAKABLE = new Set(['dirt', 'grass', 'stone']);
const PLACEABLE = new Set(['dirt', 'grass', 'stone']);

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'GT-Mini v1.0', uptime: process.uptime() }));
});

const wss = new WebSocketServer({ server });

function genId() {
    return 'p_' + crypto.randomBytes(6).toString('hex');
}

function isSolid(t) {
    return t !== null && t !== undefined;
}

function createWorld() {
    const world = [];
    for (let y = 0; y < GRID_H; y++) world.push(new Array(GRID_W).fill(null));

    // lantai dasar, tidak bisa dihancurkan
    for (let x = 0; x < GRID_W; x++) world[GRID_H - 1][x] = 'bedrock';
    // lapisan tanah
    for (let y = GRID_H - 3; y <= GRID_H - 2; y++) for (let x = 0; x < GRID_W; x++) world[y][x] = 'dirt';
    // lapisan rumput di permukaan
    for (let x = 0; x < GRID_W; x++) world[GRID_H - 4][x] = 'grass';
    // beberapa platform batu melayang buat dipanjat/dihancurkan
    for (let i = 0; i < 3; i++) {
        const px = 2 + Math.floor(Math.random() * (GRID_W - 6));
        const py = 3 + Math.floor(Math.random() * (GRID_H - 8));
        for (let k = 0; k < 3; k++) if (px + k < GRID_W) world[py][px + k] = 'stone';
    }
    return world;
}

function findSpawn(world) {
    for (let tries = 0; tries < 30; tries++) {
        const x = Math.floor(Math.random() * GRID_W);
        for (let y = 0; y < GRID_H; y++) {
            const here = world[y][x];
            const below = y + 1 < GRID_H ? world[y + 1][x] : 'bedrock';
            if (!here && isSolid(below)) return { x, y };
        }
    }
    return { x: 0, y: 0 };
}

const rooms = new Map();

function getRoom(roomId) {
    if (!rooms.has(roomId)) {
        const room = {
            world: createWorld(),
            breaking: new Map(), // key "x,y" -> {hits, type}
            players: new Map(),
            clients: new Map(),
            tickInterval: null
        };
        room.tickInterval = setInterval(() => gravityTick(room), 350);
        rooms.set(roomId, room);
    }
    return rooms.get(roomId);
}

function destroyRoomIfEmpty(room) {
    if (room.players.size === 0) {
        for (const [rid, r] of rooms.entries()) {
            if (r === room) {
                clearInterval(r.tickInterval);
                rooms.delete(rid);
                break;
            }
        }
    }
}

function send(ws, type, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type, data, time: Date.now() }));
}

function serializeBreaking(room) {
    const obj = {};
    for (const [key, val] of room.breaking.entries()) obj[key] = val;
    return obj;
}

function broadcastState(room) {
    const payload = {
        players: [...room.players.values()],
        world: room.world,
        breaking: serializeBreaking(room),
        grid: { w: GRID_W, h: GRID_H }
    };
    for (const ws of room.clients.values()) send(ws, 'state', payload);
}

function broadcastChat(room, from, color, text) {
    for (const ws of room.clients.values()) send(ws, 'chat', { from, color, text, time: Date.now() });
}

function broadcastSystem(room, text) {
    for (const ws of room.clients.values()) send(ws, 'system', { text });
}

function gravityTick(room) {
    let changed = false;
    for (const p of room.players.values()) {
        if (p.y < GRID_H - 1) {
            const below = room.world[p.y + 1][p.x];
            if (!isSolid(below)) { p.y += 1; changed = true; }
        }
    }
    if (changed) broadcastState(room);
}

wss.on('connection', (ws) => {
    const clientId = genId();
    let joinedRoom = null;
    let player = null;
    let lastMove = 0;
    let lastJump = 0;

    console.log(`[+] Client: ${clientId}`);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

        // ==== JOIN ====
        if (msg.type === 'join') {
            const roomId = String(msg.room || 'default').slice(0, 100);
            const name = String(msg.name || '').trim().slice(0, 20);
            const room = getRoom(roomId);

            if (!name) {
                send(ws, 'join_error', { message: 'Nama tidak boleh kosong' });
                return;
            }
            const taken = [...room.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase());
            if (taken) {
                send(ws, 'join_error', { message: `Nama "${name}" sudah dipakai, coba nama lain` });
                return;
            }

            const color = PALETTE[room.players.size % PALETTE.length];
            const spawn = findSpawn(room.world);
            player = {
                id: clientId, name, color,
                x: spawn.x, y: spawn.y,
                score: 0,
                inventory: { dirt: 0, grass: 0, stone: 0 }
            };

            room.players.set(clientId, player);
            room.clients.set(clientId, ws);
            joinedRoom = room;

            send(ws, 'joined', { id: clientId, grid: { w: GRID_W, h: GRID_H } });
            broadcastSystem(room, `${name} bergabung ke dunia`);
            broadcastState(room);
            return;
        }

        if (!joinedRoom || !player) return;

        // ==== MOVE (kiri/kanan) ====
        if (msg.type === 'move') {
            const now = Date.now();
            if (now - lastMove < MOVE_COOLDOWN_MS) return;
            lastMove = now;

            const dx = msg.dir === 'left' ? -1 : msg.dir === 'right' ? 1 : 0;
            if (!dx) return;
            const nx = Math.max(0, Math.min(GRID_W - 1, player.x + dx));
            const target = joinedRoom.world[player.y][nx];
            if (!isSolid(target)) player.x = nx;

            broadcastState(joinedRoom);
            return;
        }

        // ==== JUMP (klik layar / tombol lompat) ====
        if (msg.type === 'jump') {
            const now = Date.now();
            if (now - lastJump < JUMP_COOLDOWN_MS) return;

            const below = player.y + 1 < GRID_H ? joinedRoom.world[player.y + 1][player.x] : 'bedrock';
            const grounded = isSolid(below);
            if (!grounded) return;

            lastJump = now;
            let ny = player.y;
            if (ny - 1 >= 0 && !isSolid(joinedRoom.world[ny - 1][player.x])) {
                ny -= 1;
                if (ny - 1 >= 0 && !isSolid(joinedRoom.world[ny - 1][player.x])) ny -= 1;
            }
            player.y = ny;

            broadcastState(joinedRoom);
            return;
        }

        // ==== BREAK (hancurin blok, butuh 3x klik) ====
        if (msg.type === 'break') {
            const x = Number(msg.x), y = Number(msg.y);
            if (!Number.isInteger(x) || !Number.isInteger(y)) return;
            if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;

            const dist = Math.max(Math.abs(player.x - x), Math.abs(player.y - y));
            if (dist > REACH) return;

            const blockType = joinedRoom.world[y][x];
            if (!BREAKABLE.has(blockType)) return;

            const key = `${x},${y}`;
            const entry = joinedRoom.breaking.get(key) || { hits: 0, type: blockType };
            entry.hits += 1;

            if (entry.hits >= HITS_TO_BREAK) {
                joinedRoom.world[y][x] = null;
                joinedRoom.breaking.delete(key);
                player.inventory[blockType] = (player.inventory[blockType] || 0) + 1;
                player.score += 1;
                broadcastSystem(joinedRoom, `${player.name} menghancurkan ${blockType} (+1 ${blockType})`);
            } else {
                joinedRoom.breaking.set(key, entry);
            }

            broadcastState(joinedRoom);
            return;
        }

        // ==== PLACE (naro blok dari inventory) ====
        if (msg.type === 'place') {
            const x = Number(msg.x), y = Number(msg.y);
            const blockType = String(msg.blockType || '');
            if (!Number.isInteger(x) || !Number.isInteger(y)) return;
            if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
            if (!PLACEABLE.has(blockType)) return;

            const dist = Math.max(Math.abs(player.x - x), Math.abs(player.y - y));
            if (dist > REACH) return;
            if (isSolid(joinedRoom.world[y][x])) return;
            if (!player.inventory[blockType] || player.inventory[blockType] < 1) return;

            player.inventory[blockType] -= 1;
            joinedRoom.world[y][x] = blockType;

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
            broadcastSystem(joinedRoom, `${player.name} keluar dari dunia`);
            broadcastState(joinedRoom);
            destroyRoomIfEmpty(joinedRoom);
        }
        console.log(`[-] Client: ${clientId}`);
    });
});

server.listen(PORT, () => {
    console.log('========================================');
    console.log('  GT-Mini v1.0 (mining + building + chat)');
    console.log(`  Port: ${PORT}`);
    console.log('========================================');
});

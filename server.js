import { WebSocketServer } from 'ws'

const port = process.env.PORT || 8080
const wss = new WebSocketServer({ port })

// Simpan data tiap room: { clients: Set, players: Map, worldState: Map }
const rooms = new Map()

function getRoom(roomName) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      clients: new Set(),
      players: new Map(),
      worldBlocks: new Map() // nyimpen blok yg diubah: "x,y" => tileId
    })
  }
  return rooms.get(roomName)
}

wss.on('connection', (ws) => {
  let currentRoom = null
  let playerId = null

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString())
      if (!data.room) return

      const room = getRoom(data.room)

      // 1. Pemain Baru Join
      if (data.type === 'join') {
        // Cek limit maksimal 10 pemain
        if (room.clients.size >= 10 && !room.clients.has(ws)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room penuh! (Max 10 pemain)' }))
          ws.close()
          return
        }

        currentRoom = data.room
        playerId = data.id
        room.clients.add(ws)
        room.players.set(playerId, data)

        // Kirim daftar blok yang udah pernah diubah ke pemain baru ini
        const modifiedBlocks = Array.from(room.worldBlocks.entries()).map(([pos, tile]) => {
          const [x, y] = pos.split(',').map(Number)
          return { x, y, tile }
        })

        ws.send(JSON.stringify({
          type: 'init_world',
          blocks: modifiedBlocks,
          players: Array.from(room.players.values())
        }))
      }

      // 2. Simpan perubahan blok (Hancur / Pasang blok)
      if (data.type === 'block') {
        room.worldBlocks.set(`${data.x},${data.y}`, data.tile)
      }

      // 3. Update posisi player
      if (data.type === 'move' && playerId) {
        room.players.set(playerId, data)
      }

      // 4. Broadcast ke pemain lain di room yang sama
      for (const client of room.clients) {
        if (client !== ws && client.readyState === ws.OPEN) {
          client.send(JSON.stringify(data))
        }
      }
    } catch (e) {}
  })

  // Pemain keluar / tutup game
  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom)
      room.clients.delete(ws)
      if (playerId) {
        room.players.delete(playerId)
        // Kabari pemain lain kalau ada yg keluar biar karakternya hilang
        for (const client of room.clients) {
          if (client.readyState === ws.OPEN) {
            client.send(JSON.stringify({ type: 'leave', id: playerId }))
          }
        }
      }
      // Hapus room kalau udah kosong biar hemat RAM
      if (room.clients.size === 0) {
        rooms.delete(currentRoom)
      }
    }
  })
})

console.log(`✅ WebSocket Server Growtopia Online jalan di port ${port}`)

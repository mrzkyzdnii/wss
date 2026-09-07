// server.js — WebSocket server buat Growtopia Online (dengan logging debug)
// npm install ws
// node server.js

import { WebSocketServer } from "ws"
import http from "node:http"

const PORT = process.env.PORT || 3000

const rooms = new Map()

function getRoom(name) {
  if (!rooms.has(name)) {
    rooms.set(name, { players: new Map(), blocks: new Map() })
    console.log(`[ROOM] dibuat: "${name}"`)
  }
  return rooms.get(name)
}

function broadcast(roomName, data, excludeId) {
  const room = rooms.get(roomName)
  if (!room) {
    console.log(`[BROADCAST] room "${roomName}" tidak ditemukan!`)
    return
  }
  const payload = JSON.stringify(data)
  let sentTo = 0
  for (const [id, p] of room.players) {
    if (id === excludeId) continue
    if (p.ws.readyState === p.ws.OPEN) {
      p.ws.send(payload)
      sentTo++
    }
  }
  console.log(`[BROADCAST] room "${roomName}" type=${data.type} dari=${excludeId} -> terkirim ke ${sentTo} orang (total di room: ${room.players.size})`)
}

const server = http.createServer((req, res) => {
  // endpoint biar bisa dicek dari browser: https://domain-kamu/status
  if (req.url === "/status") {
    const info = {}
    for (const [name, room] of rooms) {
      info[name] = [...room.players.values()].map(p => ({ id: p.id, name: p.name }))
    }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(info, null, 2))
    return
  }
  res.writeHead(200, { "Content-Type": "text/plain" })
  res.end("WS server hidup. Endpoint: /ws (websocket), /status (lihat room aktif)")
})

const wss = new WebSocketServer({ server, path: "/ws" })

wss.on("connection", (ws, req) => {
  console.log(`[CONNECT] koneksi baru dari ${req.socket.remoteAddress}`)
  let myRoom = null
  let myId = null

  ws.on("message", (raw) => {
    let d
    try {
      d = JSON.parse(raw.toString())
    } catch {
      console.log("[ERROR] pesan bukan JSON valid:", raw.toString().slice(0, 100))
      return
    }
    if (!d.room || !d.id) {
      console.log("[SKIP] pesan tanpa room/id:", d.type)
      return
    }

    const room = getRoom(d.room)

    if (d.type === "join") {
      myRoom = d.room
      myId = d.id
      console.log(`[JOIN] "${d.name}" (${d.id}) masuk room "${d.room}" — total sebelum: ${room.players.size}`)

      room.players.set(d.id, {
        id: d.id, name: d.name, color: d.color, x: d.x, y: d.y, dir: d.dir || 1, ws
      })

      const blocksArr = []
      for (const [key, tile] of room.blocks) {
        const [x, y] = key.split(",").map(Number)
        blocksArr.push({ x, y, tile })
      }
      const playersArr = []
      for (const [pid, p] of room.players) {
        if (pid === d.id) continue
        playersArr.push({ id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, dir: p.dir, type: "join" })
      }
      console.log(`[INIT_WORLD] kirim ke "${d.name}": ${playersArr.length} pemain lain, ${blocksArr.length} block`)
      ws.send(JSON.stringify({ type: "init_world", blocks: blocksArr, players: playersArr }))

      broadcast(d.room, { type: "join", id: d.id, name: d.name, color: d.color, x: d.x, y: d.y }, d.id)
      return
    }

    if (d.type === "move") {
      const p = room.players.get(d.id)
      if (!p) {
        // player kirim move tapi belum pernah join di room ini -> daftarkan otomatis
        console.log(`[WARN] move dari id belum join: ${d.id}, auto-registering`)
        room.players.set(d.id, { id: d.id, name: d.name, color: d.color, x: d.x, y: d.y, dir: d.dir, ws })
        myRoom = d.room
        myId = d.id
      } else {
        p.x = d.x; p.y = d.y; p.dir = d.dir
      }
      broadcast(d.room, { type: "move", id: d.id, name: d.name, color: d.color, x: d.x, y: d.y, dir: d.dir, chat: d.chat, chatTimer: d.chatTimer }, d.id)
      return
    }

    if (d.type === "chat") {
      broadcast(d.room, { type: "chat", id: d.id, name: d.name, text: d.text }, d.id)
      return
    }

    if (d.type === "block") {
      room.blocks.set(`${d.x},${d.y}`, d.tile)
      broadcast(d.room, { type: "block", x: d.x, y: d.y, tile: d.tile }, d.id)
      return
    }
  })

  ws.on("close", () => {
    console.log(`[DISCONNECT] id=${myId} room=${myRoom}`)
    if (myRoom && myId) {
      const room = rooms.get(myRoom)
      if (room) {
        room.players.delete(myId)
        broadcast(myRoom, { type: "leave", id: myId }, null)
        if (room.players.size === 0) {
          rooms.delete(myRoom)
          console.log(`[ROOM] "${myRoom}" dihapus (kosong)`)
        }
      }
    }
  })
})

server.listen(PORT, () => {
  console.log(`WS server jalan di port ${PORT}, path /ws`)
})

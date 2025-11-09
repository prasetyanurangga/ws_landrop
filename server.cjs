// server.cjs
// Jalankan: `node server.cjs`
// Env opsional:
//   PORT=8787
//   ALLOW_ORIGINS=https://your-frontend.example,https://another-origin.example

const http = require("http");
const { WebSocketServer } = require("ws");

/** id -> { ws, id, name, role, room, status, alive } */
const peers = new Map();
/** room -> Set<id> */
const rooms = new Map();

// ---------- helpers ----------
function safeId(x) {
  return String(x || Math.random().toString(36).slice(2));
}
function roomKey(s) {
  return String(s || "PUBLIC").trim().toUpperCase();
}
function roster(room) {
  const ids = rooms.get(room) || new Set();
  return [...ids]
    .map((id) => {
      const p = peers.get(id);
      return p
        ? { deviceId: p.id, name: p.name, role: p.role, status: p.status }
        : null;
    })
    .filter(Boolean);
}
function broadcastRoom(room, obj) {
  const s = JSON.stringify(obj);
  for (const id of rooms.get(room) || []) {
    const p = peers.get(id);
    if (!p) continue;
    try { p.ws.send(s); } catch {}
  }
}
function joinRoom(p, room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(p.id);
  p.room = room;
}
function leaveRoom(p) {
  const set = rooms.get(p.room);
  if (set) {
    set.delete(p.id);
    if (set.size === 0) rooms.delete(p.room); // bersihkan room kosong
  }
}

// ---------- HTTP server (healthcheck) ----------
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

// ---------- WS server (upgrade only on /server) ----------
const wss = new WebSocketServer({ noServer: true });

const ALLOW_ORIGINS = process.env.ALLOW_ORIGINS
  ? process.env.ALLOW_ORIGINS.split(",").map((s) => s.trim())
  : null;

server.on("upgrade", (req, socket, head) => {
  try {
    const { url, headers } = req;
    if (!url || !url.startsWith("/server")) {
      socket.destroy(); return;
    }
    if (ALLOW_ORIGINS) {
      const origin = headers.origin || "";
      const ok = ALLOW_ORIGINS.includes(origin);
      if (!ok) { socket.destroy(); return; }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch {
    try { socket.destroy(); } catch {}
  }
});

// ---------- heartbeat (drop koneksi mati) ----------
setInterval(() => {
  for (const p of peers.values()) {
    if (!p.alive) { try { p.ws.terminate(); } catch {} continue; }
    p.alive = false;
    try { p.ws.ping(); } catch {}
  }
}, 45000);

// ---------- WS connection handler ----------
wss.on("connection", (ws) => {
  /** @type {{id:string,name:string,role:string,status:string,room:string,ws:any,alive:boolean}|null} */
  let me = null;

  // FIX: heartbeat harus menandai peer, bukan ws
  ws.on("pong", () => { if (me) me.alive = true; });

  ws.on("message", (raw) => {
    if (me) me.alive = true;
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // register pertama kali
    if (msg.type === "hello") {
      const room = roomKey(msg.room);
      me = {
        id: safeId(msg.deviceId),
        name: msg.name ?? "peer",
        role: msg.role ?? "receiver",
        status: "available",
        room,
        ws,
        alive: true,
      };
      peers.set(me.id, me);
      joinRoom(me, room);

      const list = roster(room);
      ws.send(JSON.stringify({ type: "roster", list }));
      broadcastRoom(room, { type: "roster", list });
      return;
    }

    if (!me) return;

    if (msg.type === "presence") {
      me.status = msg.status === "busy" ? "busy" : "available";
      const list = roster(me.room);
      broadcastRoom(me.room, { type: "roster", list });
      return;
    }

    // relay signaling (offer/answer/ice) — hanya jika target 1 room
    if (["offer", "answer", "ice"].includes(msg.type) && msg.to) {
      const target = peers.get(String(msg.to));
      if (target && target.room === me.room) {
        try {
          target.ws.send(JSON.stringify({ ...msg, from: me.id }));
        } catch {}
      }
      return;
    }
  });

  ws.on("close", () => {
    if (!me) return;
    peers.delete(me.id);
    const oldRoom = me.room;
    leaveRoom(me);
    const list = roster(oldRoom);
    broadcastRoom(oldRoom, { type: "roster", list });
  });
});

// ---------- start ----------
const PORT = process.env.PORT || 8787;
server.listen(PORT, () => {
  console.log("WS listening on", PORT, "path=/server");
});

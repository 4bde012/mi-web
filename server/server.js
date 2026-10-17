
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const MAX_PLAYERS = 40;
const PORT = process.env.PORT || 3000;
const players = new Map();

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingInterval: 25000,
  pingTimeout: 20000
});

app.get("/", (req, res) => {
  res.status(200).send(
    "LEGENDS OF ABDE - Servidor multijugador funcionando"
  );
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    players: players.size,
    maxPlayers: MAX_PLAYERS
  });
});

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function limit(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function broadcastState() {
  io.emit("state", {
    players: Array.from(players.entries()).map(([id, p]) => ({
      id,
      name: p.name,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      color: p.color
    }))
  });
}

io.on("connection", socket => {
  console.log("Conexión recibida:", socket.id);

  socket.on("joinGame", data => {
    if (players.has(socket.id)) {
      socket.emit("joined", { id: socket.id });
      return;
    }

    if (players.size >= MAX_PLAYERS) {
      socket.emit("serverFull", {
        message: "La partida está llena. Máximo 40 jugadores."
      });
      socket.disconnect(true);
      return;
    }

    const d = data && typeof data === "object" ? data : {};

    const colors = [
      0x29c7ff,
      0xff8a32,
      0x65e572,
      0xd477ff,
      0xffdc55,
      0xff5f7d,
      0x52ffe0,
      0xffffff
    ];

    players.set(socket.id, {
      name: String(d.name || "Jugador").slice(0, 16),
      x: limit(safeNumber(d.x), -78, 78),
      y: limit(safeNumber(d.y), 0, 30),
      z: limit(safeNumber(d.z), -78, 78),
      yaw: safeNumber(d.yaw ?? d.rotationY),
      color: colors[players.size % colors.length]
    });

    socket.emit("joined", { id: socket.id });
    console.log("Jugador dentro:", players.size, "/", MAX_PLAYERS);
    broadcastState();
  });

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !data || typeof data !== "object") return;

    p.x = limit(safeNumber(data.x, p.x), -78, 78);
    p.y = limit(safeNumber(data.y, p.y), 0, 30);
    p.z = limit(safeNumber(data.z, p.z), -78, 78);
    p.yaw = safeNumber(data.yaw ?? data.rotationY, p.yaw);
  });

  socket.on("disconnect", reason => {
    if (players.delete(socket.id)) {
      console.log("Jugador desconectado:", players.size, "/", MAX_PLAYERS);
      broadcastState();
    }
  });
});

/* Sincronización de posiciones */
const stateTimer = setInterval(broadcastState, 100);

server.listen(PORT, "0.0.0.0", () => {
  console.log("====================================");
  console.log(" LEGENDS OF ABDE");
  console.log(" Puerto:", PORT);
  console.log(" Máximo:", MAX_PLAYERS, "jugadores");
  console.log("====================================");
});

function shutdown() {
  clearInterval(stateTimer);
  io.close(() => {
    server.close(() => process.exit(0));
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);


"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 3000;
const players = new Map();

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function sendState() {
  io.emit("state", {
    players: Array.from(players, ([id, p]) => ({
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

app.get("/", (req, res) => {
  res.status(200).send("LEGENDS OF ABDE: servidor activo");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", players: players.size });
});

io.on("connection", socket => {
  console.log("Conectado:", socket.id);

  socket.on("joinGame", (data = {}) => {
    if (players.has(socket.id)) return;

    const colors = [
      0x29c7ff, 0xff8a32, 0x65e572,
      0xd477ff, 0xffdc55, 0xff5f7d
    ];

    players.set(socket.id, {
      name: String(data.name || "Jugador").slice(0, 16),
      x: clamp(data.x, -38, 38),
      y: clamp(data.y, 0, 15),
      z: clamp(data.z, -38, 38),
      yaw: clamp(data.yaw ?? data.rotationY, -1000, 1000),
      color: colors[players.size % colors.length]
    });

    socket.emit("joined", { id: socket.id });
    console.log("Jugador en la arena:", socket.id);
    sendState();
  });

  socket.on("move", (data = {}) => {
    const p = players.get(socket.id);
    if (!p || !data || typeof data !== "object") return;

    p.x = clamp(data.x, -38, 38);
    p.y = clamp(data.y, 0, 15);
    p.z = clamp(data.z, -38, 38);
    p.yaw = clamp(data.yaw ?? data.rotationY, -1000, 1000);

    sendState();
  });

  socket.on("disconnect", reason => {
    players.delete(socket.id);
    console.log("Jugador desconectado:", socket.id, reason);
    sendState();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LEGENDS OF ABDE escuchando en el puerto ${PORT}`);
});

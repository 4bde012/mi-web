
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
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function publicPlayer(id, player) {
  return {
    id,
    name: player.name,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    color: player.color,
    score: player.score
  };
}

function sendState() {
  const state = Array.from(players, ([id, player]) =>
    publicPlayer(id, player)
  );
  io.emit("state", state);
}

app.get("/", (req, res) => {
  res.status(200).send("LEGENDS OF ABDE: servidor multijugador activo");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    players: players.size
  });
});

io.on("connection", socket => {
  console.log("Conectado:", socket.id);

  socket.on("joinGame", (data = {}) => {
    if (players.has(socket.id)) return;

    const colors = [
      0x29c7ff,
      0xff8a32,
      0x65e572,
      0xd477ff,
      0xffdc55,
      0xff5f7d
    ];

    players.set(socket.id, {
      name: String(data.name || "Jugador").slice(0, 16),
      x: clamp(data.x, -38, 38),
      y: clamp(data.y, 0, 15),
      z: clamp(data.z, -38, 38),
      yaw: clamp(data.yaw ?? data.rotationY, -1000, 1000),
      color: colors[players.size % colors.length],
      score: 0
    });

    socket.emit("joined", { id: socket.id });
    console.log("Jugador dentro de la partida:", socket.id);
    sendState();
  });

  socket.on("move", (data = {}) => {
    const player = players.get(socket.id);
    if (!player || !data || typeof data !== "object") return;

    player.x = clamp(data.x, -38, 38);
    player.y = clamp(data.y, 0, 15);
    player.z = clamp(data.z, -38, 38);
    player.yaw = clamp(data.yaw ?? data.rotationY, -1000, 1000);

    sendState();
  });

  socket.on("score", value => {
    const player = players.get(socket.id);
    if (!player) return;

    player.score = clamp(value, 0, 100000);
    sendState();
  });

  socket.on("disconnect", reason => {
    players.delete(socket.id);
    console.log("Desconectado:", socket.id, reason);
    sendState();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LEGENDS OF ABDE escuchando en el puerto ${PORT}`);
});

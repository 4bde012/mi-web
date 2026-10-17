
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const players = new Map();

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, Number(value) || 0));

function sendState() {
  io.emit("state", Array.from(players.values()));
}

app.get("/", (req, res) => {
  res.status(200).send("LEGENDS OF ABDE: servidor activo");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", players: players.size });
});

io.on("connection", (socket) => {
  console.log("Conectado:", socket.id);

  socket.on("joinGame", (data = {}) => {
    if (!players.has(socket.id)) {
      players.set(socket.id, {
        id: socket.id,
        x: 0,
        y: 0,
        z: 32,
        rotationY: 0,
        health: 100
      });
    }

    const player = players.get(socket.id);

    player.x = clamp(data.x, -38, 38);
    player.y = clamp(data.y, 0, 15);
    player.z = clamp(data.z ?? 32, -38, 38);
    player.rotationY = clamp(data.rotationY, -1000, 1000);

    socket.emit("joined", { id: socket.id });
    sendState();

    console.log("Jugador en partida:", socket.id);
  });

  socket.on("move", (data = {}) => {
    let player = players.get(socket.id);

    if (!player) {
      player = {
        id: socket.id,
        x: 0,
        y: 0,
        z: 32,
        rotationY: 0,
        health: 100
      };
      players.set(socket.id, player);
    }

    player.x = clamp(data.x, -38, 38);
    player.y = clamp(data.y, 0, 15);
    player.z = clamp(data.z, -38, 38);
    player.rotationY = clamp(
      data.rotationY ?? data.yaw ?? data.rotation,
      -1000,
      1000
    );

    sendState();
  });

  socket.on("attack", (data = {}) => {
    const targetId = data.target;
    const target = players.get(targetId);

    if (!target || targetId === socket.id) return;

    const damage = clamp(data.damage, 0, 50);
    if (damage <= 0) return;

    target.health = Math.max(0, target.health - damage);

    io.to(targetId).emit("hit", {
      target: targetId,
      id: targetId,
      damage
    });

    sendState();
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    console.log("Desconectado:", socket.id);
    sendState();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("LEGENDS OF ABDE activo en el puerto", PORT);
});


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

const players = Object.create(null);
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("LEGENDS OF ABDE — servidor multijugador activo");
});

io.on("connection", socket => {
  console.log("Jugador conectado:", socket.id);

  socket.on("joinGame", data => {
    players[socket.id] = {
      id: socket.id,
      name: "Jugador",
      x: Number(data?.x) || 0,
      y: Number(data?.y) || 0,
      z: Number(data?.z) || 25,
      rotationY: 0,
      health: 100
    };

    socket.emit("joined", { id: socket.id });
  });

  socket.on("move", data => {
    const p = players[socket.id];
    if (!p || !data) return;

    const x = Number(data.x);
    const y = Number(data.y);
    const z = Number(data.z);
    const rotationY = Number(data.rotationY);

    if (![x, y, z, rotationY].every(Number.isFinite)) return;

    // Límites básicos para evitar posiciones inválidas.
    if (Math.abs(x) > 40 || Math.abs(z) > 40 ||
        y < 0 || y > 20) return;

    p.x = x;
    p.y = y;
    p.z = z;
    p.rotationY = rotationY;
  });

  socket.on("attack", data => {
    const attacker = players[socket.id];
    const target = players[data?.target];

    if (!attacker || !target || target.id === attacker.id) return;

    // El servidor decide el daño; no confía en el valor del cliente.
    const weapon = String(data.weapon || "").toLowerCase();
    const damageByWeapon = {
      pistola: 20,
      escopeta: 35,
      machete: 45
    };
    const damage = damageByWeapon[weapon];

    if (!damage) return;

    const dx = attacker.x - target.x;
    const dy = attacker.y - target.y;
    const dz = attacker.z - target.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (distance > 25) return;

    target.health = Math.max(0, target.health - damage);

    io.emit("hit", {
      target: target.id,
      attacker: attacker.id,
      damage,
      health: target.health
    });

    if (target.health <= 0) {
      attacker.score = (attacker.score || 0) + 1;
      target.health = 100;
      target.x = 0;
      target.y = 0;
      target.z = 25;

      io.emit("respawn", {
        id: target.id,
        x: target.x,
        y: target.y,
        z: target.z,
        health: target.health
      });
    }
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    console.log("Jugador desconectado:", socket.id);
  });
});

setInterval(() => {
  io.emit("state", { players });
}, 50);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LEGENDS OF ABDE escuchando en el puerto ${PORT}`);
});

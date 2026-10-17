
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

app.get("/", (req, res) => {
  res.send("ABDE STRIKE server is running.");
});

const players = {};

const MAX_HEALTH = 100;
const ARENA_LIMIT = 37;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function publicPlayers() {
  const result = {};

  for (const id in players) {
    const p = players[id];

    result[id] = {
      id,
      name: p.name,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      pitch: p.pitch,
      health: p.health,
      score: p.score,
      alive: p.alive
    };
  }

  return result;
}

function sendState() {
  io.emit("state", {
    players: publicPlayers()
  });
}

function respawnPlayer(p) {
  p.x = Math.random() * 20 - 10;
  p.y = 0;
  p.z = Math.random() * 20 - 10;
  p.health = MAX_HEALTH;
  p.alive = true;
}

function damagePlayer(attackerId, targetId, damage, weapon) {
  const attacker = players[attackerId];
  const target = players[targetId];

  if (!attacker || !target) return;
  if (!attacker.alive || !target.alive) return;
  if (attackerId === targetId) return;

  const amount = clamp(Number(damage) || 0, 0, 100);

  if (amount <= 0) return;

  target.health = Math.max(0, target.health - amount);

  io.to(targetId).emit("hit", {
    attacker: attackerId,
    target: targetId,
    damage: amount,
    weapon,
    health: target.health
  });

  if (target.health <= 0) {
    target.alive = false;
    attacker.score += 1;

    io.emit("playerDied", {
      id: targetId,
      killer: attackerId,
      score: attacker.score
    });

    setTimeout(() => {
      if (players[targetId]) {
        respawnPlayer(players[targetId]);
        sendState();
      }
    }, 2500);
  }

  sendState();
}

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  socket.on("joinGame", (data = {}) => {
    players[socket.id] = {
      id: socket.id,
      name: String(data.name || "Jugador").slice(0, 18),
      x: Math.random() * 12 - 6,
      y: 0,
      z: Math.random() * 12 - 6,
      yaw: 0,
      pitch: 0,
      health: MAX_HEALTH,
      score: 0,
      alive: true,
      lastAttack: 0
    };

    socket.emit("joined", {
      id: socket.id,
      health: MAX_HEALTH
    });

    sendState();
  });

  socket.on("move", (data = {}) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;

    const x = Number(data.x);
    const y = Number(data.y);
    const z = Number(data.z);
    const yaw = Number(data.yaw);
    const pitch = Number(data.pitch);

    if (Number.isFinite(x)) p.x = clamp(x, -ARENA_LIMIT, ARENA_LIMIT);
    if (Number.isFinite(y)) p.y = clamp(y, 0, 30);
    if (Number.isFinite(z)) p.z = clamp(z, -ARENA_LIMIT, ARENA_LIMIT);
    if (Number.isFinite(yaw)) p.yaw = yaw;
    if (Number.isFinite(pitch)) p.pitch = pitch;

    sendState();
  });

  socket.on("attack", (data = {}) => {
    const attacker = players[socket.id];
    if (!attacker || !attacker.alive) return;

    const now = Date.now();
    if (now - attacker.lastAttack < 180) return;
    attacker.lastAttack = now;

    const weapon = String(data.weapon || "pistol");
    const allowedWeapons = ["pistol", "shotgun", "machete"];

    if (!allowedWeapons.includes(weapon)) return;

    const damageByWeapon = {
      pistol: 20,
      shotgun: 35,
      machete: 45
    };

    const damage = damageByWeapon[weapon];
    const targetId = String(data.target || "");

    // El cliente indica el objetivo al que apunta.
    // Para producción habría que validar también la distancia
    // y la dirección del disparo en el servidor.
    if (!players[targetId]) return;

    const target = players[targetId];

    const dx = target.x - attacker.x;
    const dz = target.z - attacker.z;
    const distance = Math.sqrt(dx * dx + dz * dz);

    const maxDistance = weapon === "machete" ? 3 : weapon === "shotgun" ? 22 : 55;

    if (distance > maxDistance) return;

    damagePlayer(socket.id, targetId, damage, weapon);
  });

  socket.on("disconnect", () => {
    console.log("Jugador desconectado:", socket.id);
    delete players[socket.id];
    sendState();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ABDE STRIKE activo en el puerto ${PORT}`);
});

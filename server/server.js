
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 40;
const CREATOR_KEY = process.env.CREATOR_KEY;

const players = new Map();
const lastShots = new Map();

app.get("/", (req, res) => {
  res.json({
    game: "LEGENDS OF ABDE",
    status: "online",
    players: players.size,
    maxPlayers: MAX_PLAYERS
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    players: players.size,
    maxPlayers: MAX_PLAYERS
  });
});

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-1000, Math.min(1000, n)) : fallback;
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    rank: p.rank,
    x: p.x,
    y: p.y,
    z: p.z,
    rotation: p.rotation,
    health: p.health,
    kills: p.kills,
    deaths: p.deaths,
    skin: p.skin
  };
}

function sendNotice(socket, message) {
  socket.emit("notice", message);
}

io.on("connection", socket => {
  if (players.size >= MAX_PLAYERS) {
    socket.emit("notice", "Servidor lleno. Prueba más tarde.");
    socket.disconnect(true);
    return;
  }

  socket.emit("connected", {
    id: socket.id,
    maxPlayers: MAX_PLAYERS
  });

  socket.on("joinGame", data => {
    if (players.has(socket.id)) return;

    data = data && typeof data === "object" ? data : {};

    const name = String(data.name || "Jugador")
      .replace(/[<>]/g, "")
      .trim()
      .slice(0, 16) || "Jugador";

    // La clave solo se comprueba en el servidor.
    const suppliedKey = String(data.creatorKey || "");
    const isCreator = Boolean(
      CREATOR_KEY &&
      suppliedKey.length === CREATOR_KEY.length &&
      suppliedKey === CREATOR_KEY &&
      ![...players.values()].some(p => p.rank === "CREADOR")
    );

    const player = {
      id: socket.id,
      name,
      rank: isCreator ? "CREADOR" : "JUGADOR",
      x: Math.random() * 12 - 6,
      y: 0,
      z: Math.random() * 12 - 6,
      rotation: 0,
      health: 100,
      kills: 0,
      deaths: 0,
      skin: Math.floor(Math.random() * 6),
      respawnAt: 0
    };

    players.set(socket.id, player);

    socket.emit("joined", {
      you: publicPlayer(player),
      players: [...players.values()].map(publicPlayer)
    });

    io.emit("playerJoined", publicPlayer(player));
    io.emit("playerCount", players.size);
  });

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !data || typeof data !== "object") return;

    p.x = safeNumber(data.x, p.x);
    p.y = Math.max(0, Math.min(8, safeNumber(data.y, p.y)));
    p.z = safeNumber(data.z, p.z);
    p.rotation = safeNumber(data.rotation, p.rotation);

    socket.broadcast.emit("playerMoved", {
      id: p.id,
      x: p.x,
      y: p.y,
      z: p.z,
      rotation: p.rotation
    });
  });

  socket.on("shoot", data => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || !data || typeof data !== "object") return;

    const now = Date.now();
    if (now - (lastShots.get(socket.id) || 0) < 250) return;
    lastShots.set(socket.id, now);

    const origin = {
      x: safeNumber(data.x, p.x),
      y: safeNumber(data.y, p.y),
      z: safeNumber(data.z, p.z)
    };

    const direction = {
      x: safeNumber(data.dx, 0),
      y: safeNumber(data.dy, 0),
      z: safeNumber(data.dz, -1)
    };

    const magnitude = Math.hypot(direction.x, direction.y, direction.z);
    if (magnitude < 0.5 || magnitude > 2) return;

    direction.x /= magnitude;
    direction.y /= magnitude;
    direction.z /= magnitude;

    const range = 60;
    let target = null;
    let bestDistance = range;

    // Detección sencilla de impactos para el prototipo arcade.
    for (const other of players.values()) {
      if (other.id === p.id || other.health <= 0) continue;

      const tx = other.x - origin.x;
      const ty = other.y + 1 - origin.y;
      const tz = other.z - origin.z;

      const distance = Math.hypot(tx, ty, tz);
      if (distance < 0.1 || distance >= bestDistance) continue;

      const along =
        tx * direction.x +
        ty * direction.y +
        tz * direction.z;

      if (along < 0 || along > range) continue;

      const px = tx - along * direction.x;
      const py = ty - along * direction.y;
      const pz = tz - along * direction.z;

      if (Math.hypot(px, py, pz) < 1.1) {
        target = other;
        bestDistance = distance;
      }
    }

    io.emit("shotEffect", {
      shooter: p.id,
      x: origin.x,
      y: origin.y,
      z: origin.z,
      dx: direction.x,
      dy: direction.y,
      dz: direction.z,
      hit: target ? target.id : null
    });

    if (!target) return;

    target.health = Math.max(0, target.health - 25);

    io.emit("playerHit", {
      id: target.id,
      health: target.health,
      by: p.id
    });

    if (target.health === 0) {
      p.kills += 1;
      target.deaths += 1;
      target.respawnAt = now + 2500;

      io.emit("elimination", {
        attacker: p.id,
        victim: target.id,
        attackerKills: p.kills
      });

      io.emit("scoreUpdate", {
        id: p.id,
        kills: p.kills,
        deaths: p.deaths
      });
    }
  });

  socket.on("respawn", () => {
    const p = players.get(socket.id);
    if (!p || p.health > 0 || Date.now() < p.respawnAt) return;

    p.x = Math.random() * 12 - 6;
    p.y = 0;
    p.z = Math.random() * 12 - 6;
    p.health = 100;
    p.respawnAt = 0;

    socket.emit("respawned", publicPlayer(p));
    io.emit("playerUpdated", publicPlayer(p));
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    lastShots.delete(socket.id);
    io.emit("playerLeft", socket.id);
    io.emit("playerCount", players.size);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LEGENDS OF ABDE server listening on ${PORT}`);
});

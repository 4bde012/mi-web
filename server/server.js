
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
  transports: ["polling", "websocket"]
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 40;
const CREATOR_KEY = process.env.CREATOR_KEY || "";

const SKINS = ["cyber", "shadow", "inferno", "gold"];
const WEAPONS = {
  pulse:   { ammo: 30, damage: 25, rate: 220 },
  plasma:  { ammo: 12, damage: 50, rate: 500 },
  rapid:   { ammo: 50, damage: 10, rate: 100 }
};

const players = new Map();
const lastShots = new Map();

app.get("/", (req, res) => {
  res.status(200).send("LEGENDS OF ABDE - Servidor activo");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    players: players.size,
    maxPlayers: MAX_PLAYERS
  });
});

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    skin: p.skin,
    weapon: p.weapon,
    rank: p.rank,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    health: p.health,
    ammo: p.ammo,
    kills: p.kills,
    deaths: p.deaths
  };
}

function broadcastState() {
  io.emit("state", [...players.values()].map(publicPlayer));
}

function respawnPlayer(p) {
  p.x = Math.random() * 100 - 50;
  p.y = 0;
  p.z = Math.random() * 100 - 50;
  p.yaw = 0;
  p.health = 100;
  p.ammo = p.weapon === "creator" ? 20 : WEAPONS[p.weapon].ammo;
}

io.on("connection", socket => {
  console.log("Conexión:", socket.id);

  socket.on("joinGame", data => {
    if (players.has(socket.id)) return;

    if (players.size >= MAX_PLAYERS) {
      socket.emit("notice", "El servidor está lleno.");
      socket.disconnect(true);
      return;
    }

    data = data || {};

    const creator =
      CREATOR_KEY.length > 0 &&
      typeof data.creatorKey === "string" &&
      data.creatorKey === CREATOR_KEY;

    const skin = creator
      ? "creator"
      : SKINS.includes(data.skin) ? data.skin : "cyber";

    const weapon = creator
      ? "creator"
      : Object.hasOwn(WEAPONS, data.weapon) ? data.weapon : "pulse";

    const p = {
      id: socket.id,
      name: String(data.name || "Jugador")
        .replace(/[<>]/g, "")
        .trim()
        .slice(0, 16) || "Jugador",
      skin,
      weapon,
      rank: creator ? "CREADOR" : "JUGADOR",
      x: Math.random() * 40 - 20,
      y: 0,
      z: Math.random() * 40 - 20,
      yaw: 0,
      health: 100,
      ammo: weapon === "creator" ? 20 : WEAPONS[weapon].ammo,
      kills: 0,
      deaths: 0,
      lastShot: 0,
      lastReload: 0
    };

    players.set(socket.id, p);

    socket.emit("joined", { you: publicPlayer(p) });

    if (creator) {
      socket.emit("creatorVerified", { ok: true });
    } else if (data.creatorKey) {
      socket.emit("creatorVerified", { ok: false });
    }

    socket.emit("notice", "¡Bienvenido a LEGENDS OF ABDE!");
    broadcastState();
  });

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !data) return;

    const x = Number(data.x);
    const y = Number(data.y);
    const z = Number(data.z);
    const yaw = Number(data.yaw);

    if (![x, y, z, yaw].every(Number.isFinite)) return;

    // Limitar las posiciones a la arena.
    p.x = Math.max(-77, Math.min(77, x));
    p.y = Math.max(0, Math.min(10, y));
    p.z = Math.max(-77, Math.min(77, z));
    p.yaw = yaw;
  });

  socket.on("shoot", data => {
    const p = players.get(socket.id);
    if (!p || !data) return;

    const now = Date.now();
    const creator = p.weapon === "creator";
    const weapon = creator
      ? { ammo: 20, damage: 35, rate: 300 }
      : WEAPONS[p.weapon];

    const yaw = Number(data.yaw);
    const pitch = Number(data.pitch);

    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;

    if (p.health <= 0) {
      socket.emit("shotResult", { ok: false, ammo: p.ammo });
      return;
    }

    if (now - p.lastShot < weapon.rate) {
      socket.emit("shotResult", { ok: false, ammo: p.ammo });
      return;
    }

    if (p.ammo <= 0) {
      socket.emit("shotResult", { ok: false, ammo: 0 });
      return;
    }

    p.lastShot = now;
    p.ammo--;

    const dx = -Math.sin(yaw) * Math.cos(pitch);
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * Math.cos(pitch);

    const start = {
      x: p.x,
      y: p.y + 1.7,
      z: p.z
    };

    let target = null;
    let bestDistance = 60;
    const tolerance = 0.13;

    for (const other of players.values()) {
      if (other.id === p.id || other.health <= 0) continue;

      const tx = other.x - start.x;
      const ty = other.y + 1.1 - start.y;
      const tz = other.z - start.z;

      const distance = Math.hypot(tx, ty, tz);
      if (distance < 0.1 || distance > bestDistance) continue;

      const dot = (tx * dx + ty * dy + tz * dz) / distance;

      if (dot > Math.cos(tolerance)) {
        target = other;
        bestDistance = distance;
      }
    }

    let hit = false;

    if (target) {
      target.health = Math.max(0, target.health - weapon.damage);
      hit = true;

      io.emit("playerHit", {
        id: target.id,
        health: target.health
      });

      if (target.health <= 0) {
        p.kills++;
        target.deaths++;

        io.emit("elimination", {
          attacker: p.id,
          victim: target.id,
          attackerKills: p.kills
        });

        setTimeout(() => {
          const current = players.get(target.id);
          if (current && current.health <= 0) {
            respawnPlayer(current);
            io.to(current.id).emit("respawned", publicPlayer(current));
            broadcastState();
          }
        }, 2000);
      }
    }

    socket.emit("shotResult", {
      ok: true,
      ammo: p.ammo,
      hit
    });

    io.emit("shotEffect", {
      x: start.x,
      y: start.y,
      z: start.z,
      dx,
      dy,
      dz,
      distance: bestDistance,
      color: creator ? "#ffc928" : "#00dfff",
      hit
    });

    broadcastState();
  });

  socket.on("reload", () => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0) return;

    const now = Date.now();
    if (now - p.lastReload < 1200) return;

    p.lastReload = now;
    p.ammo = p.weapon === "creator"
      ? 20
      : WEAPONS[p.weapon].ammo;

    socket.emit("shotResult", {
      ok: true,
      ammo: p.ammo
    });

    broadcastState();
  });

  socket.on("respawn", () => {
    const p = players.get(socket.id);
    if (!p || p.health > 0) return;

    respawnPlayer(p);
    socket.emit("respawned", publicPlayer(p));
    broadcastState();
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    lastShots.delete(socket.id);
    console.log("Desconexión:", socket.id);
    broadcastState();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LEGENDS OF ABDE activo en el puerto ${PORT}`);
});

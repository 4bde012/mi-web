
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 40;
const CREATOR_KEY = process.env.CREATOR_KEY || "";

const WEAPONS = {
  pulse:   { ammo: 30, damage: 20, rate: 220 },
  plasma:  { ammo: 12, damage: 35, rate: 500 },
  rapid:   { ammo: 50, damage: 10, rate: 100 },
  creator: { ammo: 20, damage: 50, rate: 300 }
};

const SKINS = ["cyber", "shadow", "inferno", "gold"];
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
  res.json({ status: "ok", players: players.size });
});

function clamp(value, min, max, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    rank: p.rank,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    health: p.health,
    kills: p.kills,
    deaths: p.deaths,
    skin: p.skin,
    weapon: p.weapon,
    ammo: p.ammo
  };
}

function broadcastState() {
  io.emit("state", {
    players: [...players.values()].map(publicPlayer)
  });
}

io.on("connection", socket => {
  socket.emit("connected", { maxPlayers: MAX_PLAYERS });

  socket.on("joinGame", data => {
    if (players.has(socket.id)) return;

    if (players.size >= MAX_PLAYERS) {
      socket.emit("notice", "Servidor lleno. Inténtalo más tarde.");
      socket.disconnect(true);
      return;
    }

    data = data && typeof data === "object" ? data : {};

    const suppliedKey = String(data.creatorKey || "");
    const creatorAlreadyOnline = [...players.values()]
      .some(p => p.rank === "CREADOR");

    const isCreator = Boolean(
      CREATOR_KEY &&
      suppliedKey.length === CREATOR_KEY.length &&
      suppliedKey === CREATOR_KEY &&
      !creatorAlreadyOnline
    );

    const safeName = String(data.name || "Jugador")
      .replace(/[<>]/g, "")
      .trim()
      .slice(0, 16) || "Jugador";

    const skin = isCreator ? "creator" :
      (SKINS.includes(data.skin) ? data.skin : "cyber");

    const weapon = isCreator ? "creator" :
      (["pulse", "plasma", "rapid"].includes(data.weapon)
        ? data.weapon : "pulse");

    const p = {
      id: socket.id,
      name: isCreator ? "ABDE" : safeName,
      rank: isCreator ? "CREADOR" : "JUGADOR",
      x: clamp(data.x, -77, 77),
      y: clamp(data.y, 0, 8),
      z: clamp(data.z, -77, 77),
      yaw: clamp(data.yaw, -1000, 1000),
      health: 100,
      kills: 0,
      deaths: 0,
      skin,
      weapon,
      ammo: WEAPONS[weapon].ammo,
      respawnAt: 0
    };

    players.set(socket.id, p);

    socket.emit("joined", { you: publicPlayer(p) });
    socket.emit("creatorVerified", { ok: isCreator });

    io.emit("playerJoined", publicPlayer(p));
    io.emit("playerCount", players.size);
    broadcastState();
  });

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !data || p.health <= 0) return;

    p.x = clamp(data.x, -77, 77, p.x);
    p.y = clamp(data.y, 0, 8, p.y);
    p.z = clamp(data.z, -77, 77, p.z);
    p.yaw = clamp(data.yaw, -1000, 1000, p.yaw);

    broadcastState();
  });

  socket.on("shoot", data => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || !data) return;

    const weapon = WEAPONS[p.weapon];
    const now = Date.now();

    if (now - (lastShots.get(p.id) || 0) < weapon.rate) return;

    if (p.ammo <= 0) {
      socket.emit("shotResult", { ammo: 0, ok: false });
      return;
    }

    const yaw = Number(data.yaw);
    const pitch = Number(data.pitch);

    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;

    lastShots.set(p.id, now);
    p.ammo--;

    const safePitch = clamp(pitch, -1.4, 1.4);
    const cp = Math.cos(safePitch);

    const direction = {
      x: -Math.sin(yaw) * cp,
      y: Math.sin(safePitch),
      z: -Math.cos(yaw) * cp
    };

    const origin = { x: p.x, y: p.y + 1.7, z: p.z };
    let target = null;
    let nearest = 60;

    for (const other of players.values()) {
      if (other.id === p.id || other.health <= 0) continue;

      const dx = other.x - origin.x;
      const dy = other.y + 1.1 - origin.y;
      const dz = other.z - origin.z;
      const along =
        dx * direction.x +
        dy * direction.y +
        dz * direction.z;

      if (along < 0 || along > nearest) continue;

      const px = dx - along * direction.x;
      const py = dy - along * direction.y;
      const pz = dz - along * direction.z;

      if (Math.hypot(px, py, pz) < 1.0) {
        target = other;
        nearest = along;
      }
    }

    socket.emit("shotResult", { ammo: p.ammo, ok: true });

    io.emit("shotEffect", {
      shooter: p.id,
      x: origin.x,
      y: origin.y,
      z: origin.z,
      dx: direction.x,
      dy: direction.y,
      dz: direction.z,
      distance: target ? nearest : 60,
      hit: target ? target.id : null,
      color: p.weapon === "creator" ? "#ffd34d" :
        p.weapon === "plasma" ? "#b45cff" :
        p.weapon === "rapid" ? "#ff4545" : "#00dfff"
    });

    if (!target) return;

    target.health = Math.max(0, target.health - weapon.damage);

    io.emit("playerHit", {
      id: target.id,
      health: target.health,
      by: p.id
    });

    if (target.health <= 0) {
      p.kills++;
      target.deaths++;
      target.respawnAt = now + 2500;

      io.emit("elimination", {
        attacker: p.id,
        victim: target.id,
        attackerKills: p.kills
      });
    }

    broadcastState();
  });

  socket.on("reload", () => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0) return;

    p.ammo = WEAPONS[p.weapon].ammo;
    socket.emit("shotResult", { ammo: p.ammo, ok: true });
    broadcastState();
  });

  socket.on("respawn", () => {
    const p = players.get(socket.id);
    if (!p || p.health > 0 || Date.now() < p.respawnAt) return;

    p.x = Math.random() * 12 - 6;
    p.y = 0;
    p.z = Math.random() * 12 - 6;
    p.health = 100;
    p.ammo = WEAPONS[p.weapon].ammo;
    p.respawnAt = 0;

    socket.emit("respawned", publicPlayer(p));
    broadcastState();
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    lastShots.delete(socket.id);
    io.emit("playerLeft", socket.id);
    io.emit("playerCount", players.size);
    broadcastState();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LEGENDS OF ABDE activo en el puerto ${PORT}`);
});

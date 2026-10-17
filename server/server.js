
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

const SKINS = new Set([
  "cyber",
  "shadow",
  "inferno",
  "gold"
]);

const WEAPONS = {
  pulse: { damage: 20, rate: 220, ammo: 30 },
  plasma: { damage: 35, rate: 500, ammo: 12 },
  rapid: { damage: 10, rate: 90, ammo: 50 }
};

const CREATOR_SKIN = "creator";
const CREATOR_WEAPON = "creator";

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n)
    ? Math.max(-1000, Math.min(1000, n))
    : fallback;
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
    rotation: p.yaw,
    health: p.health,
    kills: p.kills,
    deaths: p.deaths,
    skin: p.skin,
    weapon: p.weapon
  };
}

function sendNotice(socket, message) {
  socket.emit("notice", message);
}

function isCreatorKeyValid(key) {
  if (!CREATOR_KEY || typeof key !== "string") return false;

  // Comparación sin revelar la clave al cliente.
  return key.length === CREATOR_KEY.length && key === CREATOR_KEY;
}

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

function emitState() {
  io.emit("state", [...players.values()].map(publicPlayer));
}

io.on("connection", socket => {
  if (players.size >= MAX_PLAYERS) {
    socket.emit("serverFull", {
      message: "Servidor lleno. Prueba más tarde."
    });
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

    const creatorRequested = isCreatorKeyValid(
      String(data.creatorKey || "")
    );

    // Solo puede existir un creador conectado.
    const creatorAlreadyOnline = [...players.values()]
      .some(p => p.rank === "CREADOR");

    const isCreator = creatorRequested && !creatorAlreadyOnline;

    const requestedSkin = String(data.skin || "cyber");
    const requestedWeapon = String(data.weapon || "pulse");

    const skin = isCreator
      ? CREATOR_SKIN
      : SKINS.has(requestedSkin) ? requestedSkin : "cyber";

    const weapon = isCreator
      ? CREATOR_WEAPON
      : Object.hasOwn(WEAPONS, requestedWeapon)
        ? requestedWeapon
        : "pulse";

    const player = {
      id: socket.id,
      name: isCreator ? "ABDE" : name,
      rank: isCreator ? "CREADOR" : "JUGADOR",
      x: Math.random() * 12 - 6,
      y: 0,
      z: Math.random() * 12 - 6,
      yaw: 0,
      health: 100,
      kills: 0,
      deaths: 0,
      skin,
      weapon,
      ammo: isCreator ? 20 : WEAPONS[weapon].ammo,
      lastShot: 0,
      respawnAt: 0
    };

    players.set(socket.id, player);

    socket.emit("joined", {
      you: publicPlayer(player),
      players: [...players.values()].map(publicPlayer)
    });

    socket.emit("creatorVerified", {
      ok: isCreator,
      rank: player.rank,
      skin: player.skin,
      weapon: player.weapon
    });

    io.emit("playerJoined", publicPlayer(player));
    io.emit("playerCount", players.size);
    emitState();
  });

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !data || typeof data !== "object") return;

    p.x = safeNumber(data.x, p.x);
    p.y = Math.max(0, Math.min(30, safeNumber(data.y, p.y)));
    p.z = safeNumber(data.z, p.z);

    // Admite yaw, que utiliza la nueva página, y rotation,
    // que utilizaba la versión anterior.
    p.yaw = safeNumber(data.yaw ?? data.rotation, p.yaw);

    // La skin y el arma se fijan en joinGame.
    // El cliente no puede cambiar a equipamiento exclusivo
    // enviando valores diferentes en cada movimiento.

    socket.broadcast.emit("playerMoved", {
      id: p.id,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      rotation: p.yaw,
      skin: p.skin,
      weapon: p.weapon
    });

    emitState();
  });

  socket.on("fire", data => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || !data) return;

    const now = Date.now();
    const weapon = p.rank === "CREADOR"
      ? { damage: 50, rate: 300, ammo: 20 }
      : WEAPONS[p.weapon];

    if (!weapon || now - p.lastShot < weapon.rate) return;

    if (p.ammo <= 0) {
      socket.emit("shotResult", { ammo: 0 });
      return;
    }

    p.lastShot = now;
    p.ammo--;

    socket.emit("shotResult", { ammo: p.ammo });

    io.emit("shotEffect", {
      shooter: p.id,
      x: p.x,
      y: p.y + 1.5,
      z: p.z,
      weapon: p.weapon
    });
  });

  // El cliente no decide el daño ni a quién ha alcanzado.
  // El servidor valida los disparos y calcula los impactos.
  socket.on("shoot", data => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || !data || typeof data !== "object") {
      return;
    }

    const now = Date.now();
    const weapon = p.rank === "CREADOR"
      ? { damage: 50, rate: 300, ammo: 20 }
      : WEAPONS[p.weapon];

    if (!weapon || now - p.lastShot < weapon.rate) return;

    const target = players.get(String(data.targetId || ""));
    if (!target || target.id === p.id || target.health <= 0) return;

    // El cliente no puede elegir una cantidad de daño.
    // Comprobación sencilla de distancia y dirección aproximada.
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const dz = target.z - p.z;
    const distance = Math.hypot(dx, dy, dz);

    if (distance > 60) return;

    const targetAngle = Math.atan2(-dx, -dz);
    const angleDifference = Math.atan2(
      Math.sin(targetAngle - p.yaw),
      Math.cos(targetAngle - p.yaw)
    );

    if (Math.abs(angleDifference) > 0.3) return;

    p.lastShot = now;
    p.ammo = Math.max(0, p.ammo - 1);

    socket.emit("shotResult", { ammo: p.ammo });

    target.health = Math.max(0, target.health - weapon.damage);

    io.emit("playerHit", {
      id: target.id,
      health: target.health,
      by: p.id
    });

    if (target.health === 0) {
      p.kills++;
      target.deaths++;
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

    emitState();
  });

  socket.on("reload", () => {
    const p = players.get(socket.id);
    if (!p) return;

    p.ammo = p.rank === "CREADOR"
      ? 20
      : WEAPONS[p.weapon].ammo;

    socket.emit("shotResult", { ammo: p.ammo });
  });

  socket.on("respawn", () => {
    const p = players.get(socket.id);
    if (!p || p.health > 0 || Date.now() < p.respawnAt) return;

    p.x = Math.random() * 12 - 6;
    p.y = 0;
    p.z = Math.random() * 12 - 6;
    p.health = 100;
    p.respawnAt = 0;
    p.ammo = p.rank === "CREADOR"
      ? 20
      : WEAPONS[p.weapon].ammo;

    socket.emit("respawned", publicPlayer(p));
    io.emit("playerUpdated", publicPlayer(p));
    emitState();
  });

  socket.on("disconnect", () => {
    const p = players.get(socket.id);
    players.delete(socket.id);
    lastShots.delete(socket.id);

    if (p) {
      io.emit("playerLeft", socket.id);
      io.emit("playerCount", players.size);
      emitState();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LEGENDS OF ABDE server listening on ${PORT}`);
});


"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 40;
const MAX_HEALTH = 100;
const MEDKIT_HEAL = 40;
const MAX_MEDKITS = 5;
const CREATOR_KEY = process.env.CREATOR_KEY || "";
const RANKING_FILE = process.env.RANKING_FILE ||
  path.join(__dirname, "ranking.json");

const WORLD_LIMIT = 77;
const PLAYER_RADIUS = 0.65;
const MAX_MOVE_SPEED = 14.5;

const WEAPONS = {
  pulse: {
    name: "PULSE RIFLE",
    ammo: 30,
    rate: 220,
    damage: 25,
    color: "#00dfff"
  },
  plasma: {
    name: "PLASMA DESTROYER",
    ammo: 12,
    rate: 500,
    damage: 50,
    color: "#b45cff"
  },
  rapid: {
    name: "NEON RAPID SMG",
    ammo: 50,
    rate: 100,
    damage: 10,
    color: "#ff4545"
  },
  creator: {
    name: "ABDE CREATOR",
    ammo: 40,
    rate: 120,
    damage: 20,
    color: "#ffd700"
  }
};

const SKINS = ["cyber", "shadow", "inferno", "gold"];

const players = new Map();
const medkits = new Map();
const adminLogs = [];

let ranking = {};

/* =========================================
   MAPA Y COLISIONES DEL SERVIDOR
   Deben coincidir con el mapa del index.html.
========================================= */

const WORLD_COLLIDERS = [];

function addCollider(x, y, z, w, h, d) {
  WORLD_COLLIDERS.push({
    minX: x - w / 2,
    maxX: x + w / 2,
    minY: y - h / 2,
    maxY: y + h / 2,
    minZ: z - d / 2,
    maxZ: z + d / 2
  });
}

function buildWorldColliders() {
  WORLD_COLLIDERS.length = 0;

  // Paredes exteriores
  addCollider(0, 5, -80, 160, 10, 3);
  addCollider(0, 5, 80, 160, 10, 3);
  addCollider(-80, 5, 0, 3, 10, 160);
  addCollider(80, 5, 0, 3, 10, 160);

  // Plataforma central
  addCollider(0, 0.35, 0, 18, 0.7, 18);

  // Pilares
  addCollider(-18, 3, -18, 5, 6, 5);
  addCollider(18, 3, -18, 5, 6, 5);
  addCollider(-18, 3, 18, 5, 6, 5);
  addCollider(18, 3, 18, 5, 6, 5);

  // Coberturas
  addCollider(0, 1.2, -28, 13, 2.4, 3);
  addCollider(0, 1.2, 28, 13, 2.4, 3);
  addCollider(-28, 1.2, 0, 3, 2.4, 13);
  addCollider(28, 1.2, 0, 3, 2.4, 13);

  // Barreras centrales
  addCollider(-10, 0.65, -10, 9, 1.3, 1.4);
  addCollider(10, 0.65, -10, 9, 1.3, 1.4);
  addCollider(-10, 0.65, 10, 9, 1.3, 1.4);
  addCollider(10, 0.65, 10, 9, 1.3, 1.4);

  // Pilares decorativos que también bloquean el paso
  for (let i = 0; i < 20; i++) {
    const angle = i * Math.PI * 2 / 20;
    const x = Math.cos(angle) * 53;
    const z = Math.sin(angle) * 53;

    addCollider(x, 1.7, z, 1, 3.4, 1);
  }
}

buildWorldColliders();

function positionBlocked(x, z) {
  if (x < -WORLD_LIMIT || x > WORLD_LIMIT ||
      z < -WORLD_LIMIT || z > WORLD_LIMIT) {
    return true;
  }

  for (const c of WORLD_COLLIDERS) {
    // Coincide con el filtro de colisiones del cliente.
    if (c.minY > 1.7 + 0.25) continue;

    const nearestX = Math.max(c.minX, Math.min(x, c.maxX));
    const nearestZ = Math.max(c.minZ, Math.min(z, c.maxZ));

    const dx = x - nearestX;
    const dz = z - nearestZ;

    if (dx * dx + dz * dz < PLAYER_RADIUS * PLAYER_RADIUS) {
      return true;
    }
  }

  return false;
}

function pathBlocked(x1, z1, x2, z2) {
  const distance = Math.hypot(x2 - x1, z2 - z1);
  const steps = Math.max(1, Math.ceil(distance / 0.25));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t;
    const z = z1 + (z2 - z1) * t;

    if (positionBlocked(x, z)) return true;
  }

  return false;
}

function randomPosition() {
  for (let i = 0; i < 150; i++) {
    const x = Math.round((Math.random() * 100 - 50) * 10) / 10;
    const z = Math.round((Math.random() * 100 - 50) * 10) / 10;

    if (!positionBlocked(x, z)) {
      return { x, y: 0, z };
    }
  }

  // Posición segura de reserva
  return { x: 0, y: 0, z: 15 };
}

/* =========================================
   RANKING
========================================= */

function loadRanking() {
  try {
    if (!fs.existsSync(RANKING_FILE)) return;

    const data = JSON.parse(fs.readFileSync(RANKING_FILE, "utf8"));

    if (data && typeof data === "object" && !Array.isArray(data)) {
      ranking = data;
    }
  } catch (error) {
    console.error("Error cargando ranking:", error.message);
  }
}

function saveRanking() {
  try {
    fs.mkdirSync(path.dirname(RANKING_FILE), { recursive: true });

    const temp = RANKING_FILE + ".tmp";

    fs.writeFileSync(
      temp,
      JSON.stringify(ranking, null, 2),
      "utf8"
    );

    fs.renameSync(temp, RANKING_FILE);
  } catch (error) {
    console.error("Error guardando ranking:", error.message);
  }
}

function rankingKey(name) {
  return String(name || "Jugador")
    .trim()
    .toLocaleLowerCase("es");
}

function ensureRanking(name) {
  const key = rankingKey(name);

  if (!ranking[key]) {
    ranking[key] = {
      name: String(name || "Jugador").slice(0, 16),
      kills: 0,
      deaths: 0
    };
  }

  ranking[key].name = String(name || "Jugador").slice(0, 16);
  ranking[key].kills = Math.max(0, Number(ranking[key].kills) || 0);
  ranking[key].deaths = Math.max(0, Number(ranking[key].deaths) || 0);

  return ranking[key];
}

function getRanking() {
  return Object.values(ranking)
    .map(p => ({
      name: String(p.name || "Jugador"),
      kills: Math.max(0, Number(p.kills) || 0),
      deaths: Math.max(0, Number(p.deaths) || 0)
    }))
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    .slice(0, 100);
}

function broadcastRanking() {
  io.emit("worldRanking", getRanking());
}

/* =========================================
   JUGADORES
========================================= */

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
    health: p.isCreator ? MAX_HEALTH : p.health,
    maxHealth: MAX_HEALTH,
    ammo: p.ammo,
    kills: p.kills,
    deaths: p.deaths,
    alive: p.isCreator || p.alive,
    flyEnabled: Boolean(p.isCreator && p.flyEnabled)
  };
}

function adminPlayerList() {
  return Array.from(players.values(), p => ({
    id: p.id,
    name: p.name,
    rank: p.rank,
    kills: p.kills,
    deaths: p.deaths,
    health: p.isCreator ? MAX_HEALTH : p.health,
    alive: p.isCreator || p.alive,
    isCreator: p.isCreator,
    weapon: p.weapon,
    ammo: p.ammo,
    x: p.x,
    y: p.y,
    z: p.z
  }));
}

function broadcastState() {
  io.emit("state", Array.from(players.values(), publicPlayer));
}

function broadcastMedkits() {
  io.emit("medkits", Array.from(medkits.values()));
}

function broadcastAdminPlayers() {
  for (const p of players.values()) {
    if (p.isCreator) {
      io.to(p.id).emit("admin:players", adminPlayerList());
    }
  }
}

function getCreator(socket) {
  const p = players.get(socket.id);

  if (!p || !p.isCreator || p.rank !== "CREADOR") {
    socket.emit("admin:error", "No tienes permisos de administrador.");
    return null;
  }

  return p;
}

function adminResult(socket, ok, message) {
  socket.emit("admin:actionResult", {
    ok: Boolean(ok),
    message: String(message)
  });
}

function logAdmin(admin, action, details = "") {
  const entry = {
    time: new Date().toISOString(),
    admin: String(admin?.name || "Administrador"),
    action: String(action).slice(0, 80),
    details: String(details).slice(0, 180)
  };

  adminLogs.unshift(entry);

  if (adminLogs.length > 100) {
    adminLogs.length = 100;
  }

  console.log("[ADMIN]", entry.admin, entry.action, entry.details);
}

function getStats() {
  let totalKills = 0;
  let totalDeaths = 0;

  for (const entry of Object.values(ranking)) {
    totalKills += Number(entry.kills) || 0;
    totalDeaths += Number(entry.deaths) || 0;
  }

  return {
    online: players.size,
    maxPlayers: MAX_PLAYERS,
    totalKills,
    totalDeaths,
    rankingPlayers: Object.keys(ranking).length
  };
}

function targetForAdmin(socket, data) {
  const admin = getCreator(socket);

  if (!admin) return { admin: null, target: null };

  const target = players.get(String(data?.targetId || ""));

  if (!target) {
    adminResult(socket, false, "El jugador ya no está conectado.");
    return { admin, target: null };
  }

  if (target.isCreator || target.id === admin.id) {
    adminResult(socket, false, "Esta acción no se puede aplicar al creador.");
    return { admin, target: null };
  }

  return { admin, target };
}

/* =========================================
   BOTIQUINES Y REAPARICIÓN
========================================= */

function spawnMedkit() {
  if (medkits.size >= MAX_MEDKITS) return;

  const pos = randomPosition();
  const id = crypto.randomUUID();

  medkits.set(id, {
    id,
    x: pos.x,
    y: 0.8,
    z: pos.z
  });

  broadcastMedkits();
}

function fillMedkits() {
  while (medkits.size < MAX_MEDKITS) {
    spawnMedkit();
  }
}

function respawnPlayer(p) {
  if (!players.has(p.id)) return;

  if (p.isCreator) {
    p.health = MAX_HEALTH;
    p.alive = true;
    broadcastState();
    broadcastAdminPlayers();
    return;
  }

  const pos = randomPosition();

  p.x = pos.x;
  p.y = 0;
  p.z = pos.z;
  p.yaw = 0;
  p.health = MAX_HEALTH;
  p.alive = true;
  p.ammo = WEAPONS[p.weapon]?.ammo || WEAPONS.pulse.ammo;
  p.lastShot = 0;
  p.lastMoveAt = Date.now();

  io.to(p.id).emit("respawned", publicPlayer(p));

  broadcastState();
  broadcastAdminPlayers();
}

/* =========================================
   ELIMINACIONES
========================================= */

function killPlayer(target, attacker, adminAction = false) {
  if (!target || !target.alive || target.isCreator) {
    return false;
  }

  target.health = 0;
  target.alive = false;
  target.deaths++;

  ensureRanking(target.name).deaths++;

  if (!adminAction && attacker && attacker.id !== target.id) {
    attacker.kills++;
    ensureRanking(attacker.name).kills++;
  }

  saveRanking();
  broadcastRanking();

  io.emit("elimination", {
    attacker: attacker?.id || null,
    victim: target.id,
    attackerKills: attacker?.kills || 0,
    victimDeaths: target.deaths,
    adminAction
  });

  io.emit(
    "notice",
    (attacker?.name || "Administrador") +
    " ha eliminado a " + target.name + "."
  );

  setTimeout(() => {
    const current = players.get(target.id);

    if (current && !current.alive) {
      respawnPlayer(current);
    }
  }, 3000);

  broadcastState();
  broadcastAdminPlayers();

  return true;
}

/* =========================================
   DISPAROS Y PAREDES
========================================= */

// Distancia a la primera caja que atraviesa un rayo.
// Sirve para impedir disparos a través de paredes y coberturas.
function rayBoxDistance(origin, direction, box, maxDistance) {
  let tMin = 0;
  let tMax = maxDistance;

  const axes = [
    ["x", box.minX, box.maxX],
    ["y", box.minY, box.maxY],
    ["z", box.minZ, box.maxZ]
  ];

  for (const [axis, min, max] of axes) {
    const o = origin[axis];
    const d = direction[axis];

    if (Math.abs(d) < 1e-8) {
      if (o < min || o > max) return null;
      continue;
    }

    let t1 = (min - o) / d;
    let t2 = (max - o) / d;

    if (t1 > t2) {
      const temp = t1;
      t1 = t2;
      t2 = temp;
    }

    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);

    if (tMin > tMax) return null;
  }

  return tMin >= 0 ? tMin : tMax >= 0 ? tMax : null;
}

function findHitPlayer(shooter, yaw, pitch) {
  const dx = -Math.sin(yaw) * Math.cos(pitch);
  const dy = Math.sin(pitch);
  const dz = -Math.cos(yaw) * Math.cos(pitch);

  const origin = {
    x: shooter.x,
    y: shooter.y + 1.7,
    z: shooter.z
  };

  const direction = { x: dx, y: dy, z: dz };

  let wallDistance = 60;

  for (const box of WORLD_COLLIDERS) {
    const distance = rayBoxDistance(
      origin, direction, box, wallDistance
    );

    if (distance !== null && distance < wallDistance) {
      wallDistance = distance;
    }
  }

  let best = null;
  let bestDistance = wallDistance;

  for (const target of players.values()) {
    if (target.id === shooter.id || !target.alive) continue;

    const center = {
      x: target.x,
      y: target.y + 1.1,
      z: target.z
    };

    const rx = center.x - origin.x;
    const ry = center.y - origin.y;
    const rz = center.z - origin.z;

    const along = rx * dx + ry * dy + rz * dz;

    if (along < 0 || along > bestDistance) continue;

    const nearestX = origin.x + dx * along;
    const nearestY = origin.y + dy * along;
    const nearestZ = origin.z + dz * along;

    const distance = Math.hypot(
      center.x - nearestX,
      center.y - nearestY,
      center.z - nearestZ
    );

    if (distance <= 1.15) {
      best = target;
      bestDistance = along;
    }
  }

  return {
    target: best,
    origin,
    direction,
    distance: best ? bestDistance : wallDistance
  };
}

/* =========================================
   TELETRANSPORTE SEGURO
========================================= */

function findSafePositionNear(x, z) {
  const offsets = [
    [2, 0], [-2, 0], [0, 2], [0, -2],
    [3, 3], [-3, 3], [3, -3], [-3, -3],
    [5, 0], [-5, 0], [0, 5], [0, -5]
  ];

  for (const [dx, dz] of offsets) {
    const px = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, x + dx));
    const pz = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, z + dz));

    if (!positionBlocked(px, pz)) {
      return { x: px, y: 0, z: pz };
    }
  }

  return randomPosition();
}

/* =========================================
   HTTP
========================================= */

loadRanking();

app.get("/", (req, res) => {
  res.send("LEGENDS OF ABDE: servidor multijugador activo.");
});

app.get("/health", (req, res) => {
  res.json({
    online: true,
    players: players.size,
    medkits: medkits.size
  });
});

app.get("/ranking", (req, res) => {
  res.json(getRanking());
});

/* =========================================
   SOCKET.IO
========================================= */

io.on("connection", socket => {
  console.log("Conexión:", socket.id);

  socket.on("joinGame", data => {
    if (players.size >= MAX_PLAYERS && !players.has(socket.id)) {
      socket.emit("notice", "La arena está llena.");
      socket.disconnect(true);
      return;
    }

    if (players.has(socket.id)) return;

    data = data && typeof data === "object" ? data : {};

    const isCreator = Boolean(
      CREATOR_KEY &&
      typeof data.creatorKey === "string" &&
      data.creatorKey.length > 0 &&
      data.creatorKey === CREATOR_KEY
    );

    const requestedWeapon = String(data.weapon || "pulse");
    const requestedSkin = String(data.skin || "cyber");

    const weapon = isCreator
      ? (WEAPONS[requestedWeapon] ? requestedWeapon : "pulse")
      : (
          WEAPONS[requestedWeapon] && requestedWeapon !== "creator"
            ? requestedWeapon
            : "pulse"
        );

    const skin = isCreator
      ? "creator"
      : (SKINS.includes(requestedSkin) ? requestedSkin : "cyber");

    const name =
      String(data.name || "Jugador").trim().slice(0, 16) || "Jugador";

    const pos = randomPosition();
    const entry = ensureRanking(name);

    const p = {
      id: socket.id,
      name,
      skin,
      weapon,
      rank: isCreator ? "CREADOR" : "JUGADOR",
      isCreator,
      flyEnabled: false,

      x: pos.x,
      y: 0,
      z: pos.z,
      yaw: 0,

      health: MAX_HEALTH,
      ammo: WEAPONS[weapon].ammo,

      kills: entry.kills,
      deaths: entry.deaths,

      alive: true,
      lastShot: 0,
      lastMoveAt: Date.now()
    };

    players.set(socket.id, p);

    socket.emit("joined", { you: publicPlayer(p) });
    socket.emit("medkits", Array.from(medkits.values()));
    socket.emit("worldRanking", getRanking());

    broadcastState();
    broadcastAdminPlayers();

    socket.broadcast.emit("notice", name + " ha entrado en la arena.");
  });

  /* =====================================
     ADMIN PRO
  ===================================== */

  socket.on("admin:getPlayers", () => {
    if (getCreator(socket)) {
      socket.emit("admin:players", adminPlayerList());
    }
  });

  socket.on("admin:getRanking", () => {
    if (getCreator(socket)) {
      socket.emit("worldRanking", getRanking());
    }
  });

  socket.on("admin:getStats", () => {
    if (getCreator(socket)) {
      socket.emit("admin:stats", getStats());
    }
  });

  socket.on("admin:getLogs", () => {
    if (getCreator(socket)) {
      socket.emit("admin:logs", adminLogs.slice(0, 100));
    }
  });

  socket.on("admin:kill", data => {
    const { admin, target } = targetForAdmin(socket, data);
    if (!admin || !target) return;

    if (!target.alive) {
      adminResult(socket, false, "Ese jugador ya está eliminado.");
      return;
    }

    const ok = killPlayer(target, admin, true);

    if (ok) logAdmin(admin, "ELIMINAR", target.name);

    adminResult(
      socket,
      ok,
      ok ? "Jugador eliminado." : "No se pudo eliminar."
    );
  });

  socket.on("admin:heal", data => {
    const { admin, target } = targetForAdmin(socket, data);
    if (!admin || !target) return;

    if (!target.alive) {
      adminResult(socket, false, "El jugador está eliminado. Revívelo primero.");
      return;
    }

    target.health = MAX_HEALTH;

    logAdmin(admin, "CURAR", target.name);

    io.to(target.id).emit("notice", "El administrador te ha curado.");

    adminResult(socket, true, target.name + " tiene toda la vida.");

    broadcastState();
    broadcastAdminPlayers();
  });

  socket.on("admin:revive", data => {
    const { admin, target } = targetForAdmin(socket, data);
    if (!admin || !target) return;

    if (target.alive) {
      target.health = MAX_HEALTH;

      broadcastState();
      broadcastAdminPlayers();

      adminResult(
        socket,
        true,
        target.name + " ya estaba vivo y ha sido curado."
      );

      return;
    }

    respawnPlayer(target);

    logAdmin(admin, "REVIVIR", target.name);

    io.to(target.id).emit("notice", "El administrador te ha revivido.");

    adminResult(socket, true, target.name + " ha vuelto a la arena.");
  });

  socket.on("admin:teleport", data => {
    const { admin, target } = targetForAdmin(socket, data);
    if (!admin || !target) return;

    if (!target.alive) {
      adminResult(socket, false, "Primero debes revivir al jugador.");
      return;
    }

    const pos = findSafePositionNear(admin.x, admin.z);

    target.x = pos.x;
    target.y = pos.y;
    target.z = pos.z;
    target.yaw = admin.yaw;
    target.lastMoveAt = Date.now();

    io.to(target.id).emit("admin:teleported", publicPlayer(target));
    io.to(target.id).emit("notice", "El administrador te ha teletransportado.");

    logAdmin(admin, "TELETRANSPORTAR", target.name);

    adminResult(socket, true, target.name + " ha sido teletransportado.");

    broadcastState();
    broadcastAdminPlayers();
  });

  socket.on("admin:kick", data => {
    const { admin, target } = targetForAdmin(socket, data);
    if (!admin || !target) return;

    logAdmin(admin, "EXPULSAR", target.name);

    const targetSocket = io.sockets.sockets.get(target.id);

    if (targetSocket) {
      targetSocket.emit("notice", "Has sido expulsado por el administrador.");
      targetSocket.disconnect(true);
    }

    adminResult(socket, true, target.name + " ha sido expulsado.");
  });

  socket.on("admin:setWeapon", data => {
    const { admin, target } = targetForAdmin(socket, data);
    if (!admin || !target) return;

    const weapon = String(data?.weapon || "");

    if (!WEAPONS[weapon] || weapon === "creator") {
      adminResult(socket, false, "Arma no válida.");
      return;
    }

    target.weapon = weapon;
    target.ammo = WEAPONS[weapon].ammo;

    io.to(target.id).emit("admin:weaponChanged", {
      weapon: target.weapon,
      ammo: target.ammo
    });

    io.to(target.id).emit("notice", "El administrador te ha cambiado el arma.");

    logAdmin(admin, "CAMBIAR ARMA", target.name + " → " + WEAPONS[weapon].name);

    adminResult(socket, true, "Arma cambiada a " + WEAPONS[weapon].name + ".");

    broadcastState();
    broadcastAdminPlayers();
  });

  socket.on("admin:broadcast", data => {
    const admin = getCreator(socket);
    if (!admin) return;

    const message = String(data?.message || "").trim().slice(0, 180);

    if (!message) {
      adminResult(socket, false, "Escribe un mensaje.");
      return;
    }

    logAdmin(admin, "MENSAJE GLOBAL", message);

    io.emit("notice", "📢 " + admin.name + ": " + message);

    adminResult(socket, true, "Mensaje enviado a todos.");
  });

  socket.on("admin:toggleFly", data => {
    const admin = getCreator(socket);
    if (!admin) return;

    admin.flyEnabled = Boolean(data?.enabled);

    if (!admin.flyEnabled) {
      admin.y = 0;
    }

    socket.emit("admin:flyStatus", { enabled: admin.flyEnabled });

    socket.emit(
      "notice",
      admin.flyEnabled ? "Vuelo activado." : "Vuelo desactivado."
    );

    broadcastState();
    broadcastAdminPlayers();
  });

  /* =====================================
     MOVIMIENTO VALIDADO EN EL SERVIDOR
  ===================================== */

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive || !data || typeof data !== "object") return;

    const x = Number(data.x);
    const y = Number(data.y);
    const z = Number(data.z);
    const yaw = Number(data.yaw);

    if (![x, y, z, yaw].every(Number.isFinite)) return;

    const now = Date.now();
    const elapsed = Math.max(
      0.05,
      Math.min(0.5, (now - p.lastMoveAt) / 1000)
    );

    const distance = Math.hypot(x - p.x, z - p.z);
    const maxDistance = MAX_MOVE_SPEED * elapsed + 0.9;

    // Impide movimientos instantáneos exagerados.
    if (distance > maxDistance) {
      socket.emit("moveCorrection", publicPlayer(p));
      p.lastMoveAt = now;
      return;
    }

    // Impide atravesar paredes, pilares y coberturas.
    if (pathBlocked(p.x, p.z, x, z)) {
      socket.emit("moveCorrection", publicPlayer(p));
      p.lastMoveAt = now;
      return;
    }

    p.x = x;
    p.z = z;
    p.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));

    if (p.isCreator && p.flyEnabled) {
      p.y = Math.max(0, Math.min(30, y));
    } else {
      p.y = Math.max(0, Math.min(2, y));
    }

    p.lastMoveAt = now;
  });

  /* =====================================
     CAMBIO DE ARMAS
  ===================================== */

  socket.on("changeWeapon", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;

    const weapon = String(data?.weapon || "");

    if (!WEAPONS[weapon]) return;

    // El arma de creador no se puede conseguir como jugador normal.
    if (weapon === "creator" && !p.isCreator) return;

    // Los jugadores normales no pueden usar el arma exclusiva del creador.
    if (!p.isCreator && weapon === "creator") return;

    p.weapon = weapon;
    p.ammo = WEAPONS[weapon].ammo;

    socket.emit("shotResult", {
      ok: true,
      ammo: p.ammo,
      weapon: p.weapon
    });

    socket.emit("notice", "Arma equipada: " + WEAPONS[weapon].name);

    broadcastState();
    broadcastAdminPlayers();
  });

  /* =====================================
     DISPAROS
  ===================================== */

  socket.on("shoot", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;

    const weapon = WEAPONS[p.weapon] || WEAPONS.pulse;
    const now = Date.now();

    if (now - p.lastShot < weapon.rate - 15) {
      socket.emit("shotResult", {
        ok: false,
        ammo: p.ammo,
        message: "Dispara un poco más despacio."
      });
      return;
    }

    if (p.ammo <= 0) {
      socket.emit("shotResult", {
        ok: false,
        ammo: 0,
        message: "Pulsa R para recargar."
      });
      return;
    }

    const yaw = Number(data?.yaw);
    const pitch = Number(data?.pitch);

    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;

    p.lastShot = now;
    p.ammo--;

    const shot = findHitPlayer(p, yaw, pitch);

    io.emit("shotEffect", {
      shooterId: p.id,
      x: shot.origin.x,
      y: shot.origin.y,
      z: shot.origin.z,
      dx: shot.direction.x,
      dy: shot.direction.y,
      dz: shot.direction.z,
      distance: shot.distance,
      color: weapon.color
    });

    socket.emit("shotResult", {
      ok: true,
      ammo: p.ammo
    });

    if (!shot.target) {
      broadcastState();
      return;
    }

    const target = shot.target;

    // El creador es invulnerable.
    if (target.isCreator) {
      target.health = MAX_HEALTH;

      socket.emit("hitConfirm", {
        targetId: target.id,
        damage: 0,
        health: MAX_HEALTH
      });

      broadcastState();
      return;
    }

    target.health = Math.max(0, target.health - weapon.damage);

    socket.emit("hitConfirm", {
      targetId: target.id,
      damage: weapon.damage,
      health: target.health
    });

    io.emit("playerHit", {
      id: target.id,
      targetId: target.id,
      shooterId: p.id,
      damage: weapon.damage,
      health: target.health
    });

    if (target.health <= 0) {
      killPlayer(target, p, false);
    } else {
      broadcastState();
      broadcastAdminPlayers();
    }
  });

  socket.on("reload", () => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;

    p.ammo = WEAPONS[p.weapon]?.ammo || WEAPONS.pulse.ammo;

    socket.emit("shotResult", {
      ok: true,
      ammo: p.ammo
    });

    socket.emit("notice", "Arma recargada.");

    broadcastState();
  });

  /* =====================================
     BOTIQUINES
  ===================================== */

  socket.on("collectMedkit", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive || !data?.id) return;

    const kit = medkits.get(String(data.id));

    if (!kit) {
      socket.emit("medkitCollected", {
        id: String(data.id),
        playerId: p.id,
        health: p.health,
        ok: false
      });
      return;
    }

    const distance = Math.hypot(p.x - kit.x, p.z - kit.z);

    if (distance > 3.5 || p.health >= MAX_HEALTH) {
      socket.emit("medkitCollected", {
        id: kit.id,
        playerId: p.id,
        health: p.health,
        ok: false
      });
      return;
    }

    p.health = Math.min(MAX_HEALTH, p.health + MEDKIT_HEAL);
    medkits.delete(kit.id);

    io.emit("medkitCollected", {
      id: kit.id,
      playerId: p.id,
      health: p.health,
      ok: true
    });

    broadcastMedkits();
    broadcastState();
    broadcastAdminPlayers();

    setTimeout(spawnMedkit, 8000);
  });

  /* =====================================
     REAPARICIÓN
  ===================================== */

  socket.on("respawn", () => {
    const p = players.get(socket.id);

    if (p && !p.alive) {
      respawnPlayer(p);
    }
  });

  /* =====================================
     DESCONEXIÓN
  ===================================== */

  socket.on("disconnect", () => {
    const p = players.get(socket.id);

    players.delete(socket.id);

    if (p) {
      io.emit("notice", p.name + " ha salido de la arena.");

      broadcastState();
      broadcastAdminPlayers();
    }
  });
});

/* =========================================
   INICIO DEL SERVIDOR
========================================= */

fillMedkits();

setInterval(() => {
  fillMedkits();
  broadcastState();
  broadcastAdminPlayers();
}, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("LEGENDS OF ABDE escuchando en el puerto " + PORT);

  if (!CREATOR_KEY) {
    console.warn(
      "AVISO: configura CREATOR_KEY en las variables de entorno de Render."
    );
  }
});

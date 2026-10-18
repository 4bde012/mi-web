
"use strict";

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3000;
const CREATOR_KEY = process.env.CREATOR_KEY || "";
const MAX_PLAYERS = 40;
const MAX_HEALTH = 100;
const WORLD_LIMIT = 77;
const SHOT_RANGE = 60;

const DATA_DIR = process.env.DATA_DIR || __dirname;
const RANKING_FILE = path.join(DATA_DIR, "ranking.json");
const BLOCKED_FILE = path.join(DATA_DIR, "blocked-players.json");
const VERIFIED_FILE = path.join(DATA_DIR, "verified-players.json");
const SPONSORS_FILE = path.join(DATA_DIR, "sponsors.json");

const WEAPONS = {
  pulse: { name: "PULSE RIFLE", ammo: 30, rate: 220, damage: 25, color: "#00dfff" },
  plasma: { name: "PLASMA DESTROYER", ammo: 12, rate: 500, damage: 50, color: "#b45cff" },
  rapid: { name: "NEON RAPID SMG", ammo: 50, rate: 100, damage: 10, color: "#ff4545" },
  creator: { name: "ABDE CREATOR", ammo: 40, rate: 120, damage: 20, color: "#ffd700" }
};

const SKINS = ["cyber", "shadow", "inferno", "gold"];
const players = new Map();
const medkits = new Map();
const ranking = {};
const blockedNames = new Set();
const verifiedNames = new Set();
const sponsoredNames = new Set();
const adminLogs = [];

function normalize(value) {
  return String(value || "").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function readSet(file, set) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(data)) data.forEach(v => {
      const name = normalize(v);
      if (name) set.add(name);
    });
  } catch {}
}

function writeSet(file, set) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify([...set].sort(), null, 2));
  fs.renameSync(temp, file);
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

function logAdmin(admin, action, details = "") {
  const log = {
    time: new Date().toISOString(),
    admin: admin.name,
    action,
    details: String(details).slice(0, 180)
  };
  adminLogs.unshift(log);
  if (adminLogs.length > 100) adminLogs.pop();
  console.log("[ADMIN]", log.admin, action, details);
}

function ensureRanking(name) {
  const key = normalize(name) || "jugador";
  if (!ranking[key]) ranking[key] = { name, kills: 0, deaths: 0 };
  return ranking[key];
}

function getRanking() {
  return Object.values(ranking)
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    .slice(0, 100);
}

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, skin: p.skin, weapon: p.weapon,
    rank: p.rank, sponsored: sponsoredNames.has(normalize(p.name)),
    verified: verifiedNames.has(normalize(p.name)),
    x: p.x, y: p.y, z: p.z, yaw: p.yaw,
    health: p.isCreator ? MAX_HEALTH : p.health,
    maxHealth: MAX_HEALTH, ammo: p.ammo,
    kills: p.kills, deaths: p.deaths,
    alive: p.isCreator || p.alive,
    flyEnabled: Boolean(p.isCreator && p.flyEnabled)
  };
}

function adminPlayerList() {
  return [...players.values()].map(p => ({
    ...publicPlayer(p), isCreator: p.isCreator
  }));
}

function broadcastState() {
  io.emit("state", [...players.values()].map(publicPlayer));
}

function broadcastAdminPlayers() {
  for (const p of players.values()) {
    if (p.isCreator) io.to(p.id).emit("admin:players", adminPlayerList());
  }
}

function broadcastSponsors() {
  io.emit("sponsor:state", { names: [...sponsoredNames] });
}

function broadcastRanking() {
  io.emit("worldRanking", getRanking());
}

function getCreator(socket) {
  const p = players.get(socket.id);
  if (!p || !p.isCreator) {
    socket.emit("admin:error", "No tienes permisos de administrador.");
    return null;
  }
  return p;
}

function adminResult(socket, ok, message) {
  socket.emit("admin:actionResult", { ok: Boolean(ok), message: String(message) });
}

function getTarget(socket, data) {
  const admin = getCreator(socket);
  if (!admin) return { admin: null, target: null };

  const target = players.get(String(data?.targetId || ""));
  if (!target) {
    adminResult(socket, false, "El jugador ya no está conectado.");
    return { admin, target: null };
  }
  if (target.isCreator || target.id === admin.id) {
    adminResult(socket, false, "No puedes aplicar esa acción al creador.");
    return { admin, target: null };
  }
  return { admin, target };
}

function randomPosition() {
  for (let i = 0; i < 150; i++) {
    const x = Math.random() * 100 - 50;
    const z = Math.random() * 100 - 50;
    if (Math.hypot(x, z) > 14) return { x, y: 0, z };
  }
  return { x: 0, y: 0, z: 20 };
}

function respawnPlayer(p) {
  if (!players.has(p.id)) return;
  const pos = randomPosition();
  Object.assign(p, pos, {
    health: MAX_HEALTH, alive: true, yaw: 0,
    ammo: WEAPONS[p.weapon].ammo, lastShot: 0,
    lastMoveAt: Date.now()
  });
  io.to(p.id).emit("respawned", publicPlayer(p));
  broadcastState();
  broadcastAdminPlayers();
}

function eliminate(target, attacker, adminAction = false) {
  if (!target || !target.alive || target.isCreator) return false;

  target.health = 0;
  target.alive = false;
  target.deaths++;
  ensureRanking(target.name).deaths++;

  if (attacker && attacker.id !== target.id && !adminAction) {
    attacker.kills++;
    ensureRanking(attacker.name).kills++;
  }

  try { saveJSON(RANKING_FILE, ranking); } catch (e) {
    console.error("Error guardando ranking:", e.message);
  }

  io.emit("elimination", {
    attacker: attacker?.id || null,
    victim: target.id,
    attackerKills: attacker?.kills || 0,
    victimDeaths: target.deaths,
    adminAction
  });

  broadcastRanking();
  broadcastState();
  broadcastAdminPlayers();

  setTimeout(() => {
    const current = players.get(target.id);
    if (current && !current.alive) respawnPlayer(current);
  }, 3000);

  return true;
}

function rayBox(origin, dir, box, maxDistance) {
  let minT = 0;
  let maxT = maxDistance;

  for (const axis of ["x", "y", "z"]) {
    const min = box["min" + axis.toUpperCase()];
    const max = box["max" + axis.toUpperCase()];
    const o = origin[axis];
    const d = dir[axis];

    if (Math.abs(d) < 1e-8) {
      if (o < min || o > max) return null;
      continue;
    }

    let a = (min - o) / d;
    let b = (max - o) / d;
    if (a > b) [a, b] = [b, a];
    minT = Math.max(minT, a);
    maxT = Math.min(maxT, b);
    if (minT > maxT) return null;
  }

  return maxT < 0 ? null : (minT >= 0 ? minT : maxT);
}

function findHit(shooter, yaw, pitch) {
  const origin = { x: shooter.x, y: shooter.y + 1.55, z: shooter.z };
  const dir = {
    x: -Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * Math.cos(pitch)
  };

  let nearest = null;
  let bestDistance = SHOT_RANGE;

  for (const target of players.values()) {
    if (target.id === shooter.id || !target.alive) continue;

    const box = {
      minX: target.x - .55, maxX: target.x + .55,
      minY: target.y + .1, maxY: target.y + 2.15,
      minZ: target.z - .55, maxZ: target.z + .55
    };

    const distance = rayBox(origin, dir, box, bestDistance);
    if (distance !== null && distance < bestDistance) {
      nearest = target;
      bestDistance = distance;
    }
  }

  return { target: nearest, origin, dir, distance: bestDistance };
}

function adminSafeTarget(socket, data, action) {
  const { admin, target } = getTarget(socket, data);
  if (!admin || !target) return;
  action(admin, target);
}

readSet(BLOCKED_FILE, blockedNames);
readSet(VERIFIED_FILE, verifiedNames);
readSet(SPONSORS_FILE, sponsoredNames);

try {
  const saved = JSON.parse(fs.readFileSync(RANKING_FILE, "utf8"));
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    Object.assign(ranking, saved);
  }
} catch {}

app.get("/", (req, res) => res.send("LEGENDS OF ABDE: servidor activo."));
app.get("/health", (req, res) => res.json({
  online: true, players: players.size, maxPlayers: MAX_PLAYERS
}));
app.get("/ranking", (req, res) => res.json(getRanking()));

io.on("connection", socket => {
  console.log("Conexión:", socket.id);

  socket.on("joinGame", data => {
    if (players.has(socket.id)) return;
    if (players.size >= MAX_PLAYERS) {
      socket.emit("notice", "La arena está llena.");
      socket.disconnect(true);
      return;
    }

    data = data && typeof data === "object" ? data : {};
    const name = String(data.name || "Jugador").trim().slice(0, 16) || "Jugador";

    if (blockedNames.has(normalize(name))) {
      socket.emit("notice", "Este nombre está bloqueado por el creador.");
      socket.disconnect(true);
      return;
    }

    const isCreator = Boolean(
      CREATOR_KEY &&
      typeof data.creatorKey === "string" &&
      data.creatorKey.length > 0 &&
      data.creatorKey === CREATOR_KEY
    );

    const requestedWeapon = String(data.weapon || "pulse");
    const weapon = WEAPONS[requestedWeapon] &&
      (isCreator || requestedWeapon !== "creator")
      ? requestedWeapon : "pulse";

    const requestedSkin = String(data.skin || "cyber");
    const skin = isCreator ? "creator" :
      (SKINS.includes(requestedSkin) ? requestedSkin : "cyber");

    const pos = randomPosition();
    const record = ensureRanking(name);

    const p = {
      id: socket.id, name, skin, weapon,
      rank: isCreator ? "CREADOR" : "JUGADOR",
      isCreator, flyEnabled: false,
      ...pos, yaw: 0, health: MAX_HEALTH,
      ammo: WEAPONS[weapon].ammo,
      kills: record.kills || 0, deaths: record.deaths || 0,
      alive: true, lastShot: 0, lastMoveAt: Date.now()
    };

    players.set(socket.id, p);

    socket.emit("creatorVerified", { ok: isCreator });
    socket.emit("joined", { you: publicPlayer(p) });
    socket.emit("sponsor:state", { names: [...sponsoredNames] });
    socket.emit("medkits", [...medkits.values()]);
    socket.emit("worldRanking", getRanking());

    broadcastState();
    broadcastAdminPlayers();
    socket.broadcast.emit("notice", name + " ha entrado en la arena.");
  });

  socket.on("admin:getPlayers", () => {
    if (getCreator(socket)) socket.emit("admin:players", adminPlayerList());
  });

  socket.on("admin:getRanking", () => {
    if (getCreator(socket)) socket.emit("worldRanking", getRanking());
  });

  socket.on("admin:getLogs", () => {
    if (getCreator(socket)) socket.emit("admin:logs", adminLogs);
  });

  socket.on("admin:kill", data => adminSafeTarget(socket, data, (admin, target) => {
    const ok = eliminate(target, admin, true);
    if (ok) logAdmin(admin, "ELIMINAR", target.name);
    adminResult(socket, ok, ok ? "Jugador eliminado." : "No se pudo eliminar.");
  }));

  socket.on("admin:heal", data => adminSafeTarget(socket, data, (admin, target) => {
    if (!target.alive) return adminResult(socket, false, "El jugador está eliminado.");
    target.health = MAX_HEALTH;
    logAdmin(admin, "CURAR", target.name);
    io.to(target.id).emit("notice", "El creador te ha curado.");
    broadcastState();
    broadcastAdminPlayers();
    adminResult(socket, true, target.name + " tiene toda la vida.");
  }));

  socket.on("admin:revive", data => adminSafeTarget(socket, data, (admin, target) => {
    if (target.alive) target.health = MAX_HEALTH;
    else respawnPlayer(target);
    logAdmin(admin, "REVIVIR", target.name);
    broadcastState();
    broadcastAdminPlayers();
    adminResult(socket, true, target.name + " está vivo.");
  }));

  socket.on("admin:kick", data => adminSafeTarget(socket, data, (admin, target) => {
    logAdmin(admin, "EXPULSAR", target.name);
    const targetSocket = io.sockets.sockets.get(target.id);
    if (targetSocket) {
      targetSocket.emit("notice", "Has sido expulsado por el creador.");
      targetSocket.disconnect(true);
    }
    adminResult(socket, true, target.name + " ha sido expulsado.");
  }));

  socket.on("admin:block", data => adminSafeTarget(socket, data, (admin, target) => {
    const key = normalize(target.name);
    const wasBlocked = blockedNames.has(key);
    blockedNames.add(key);

    try {
      writeSet(BLOCKED_FILE, blockedNames);
    } catch (error) {
      if (!wasBlocked) blockedNames.delete(key);
      return adminResult(socket, false, "No se pudo guardar el bloqueo.");
    }

    logAdmin(admin, "BLOQUEAR NOMBRE", target.name);
    const targetSocket = io.sockets.sockets.get(target.id);
    if (targetSocket) {
      targetSocket.emit("notice", "Tu nombre ha sido bloqueado.");
      targetSocket.disconnect(true);
    }
    adminResult(socket, true, "Nombre bloqueado: " + target.name + ".");
  }));

  socket.on("admin:unblock", data => {
    if (!getCreator(socket)) return;
    const key = normalize(data?.name);
    if (!blockedNames.has(key)) return adminResult(socket, false, "Nombre no bloqueado.");
    blockedNames.delete(key);
    try { writeSet(BLOCKED_FILE, blockedNames); }
    catch {
      blockedNames.add(key);
      return adminResult(socket, false, "No se pudo guardar el desbloqueo.");
    }
    adminResult(socket, true, "Nombre desbloqueado.");
  });

  socket.on("admin:verify", data => adminSafeTarget(socket, data, (admin, target) => {
    if (typeof data?.enabled !== "boolean") {
      return adminResult(socket, false, "Solicitud no válida.");
    }

    const key = normalize(target.name);
    const wasVerified = verifiedNames.has(key);

    if (data.enabled) verifiedNames.add(key);
    else verifiedNames.delete(key);

    try { writeSet(VERIFIED_FILE, verifiedNames); }
    catch {
      if (wasVerified) verifiedNames.add(key);
      else verifiedNames.delete(key);
      return adminResult(socket, false, "No se pudo guardar la verificación.");
    }

    logAdmin(admin, data.enabled ? "VERIFICAR" : "QUITAR VERIFICACIÓN", target.name);
    broadcastState();
    broadcastAdminPlayers();
    io.to(target.id).emit("notice", data.enabled
      ? "El creador te ha verificado ✓."
      : "El creador ha retirado tu verificación.");
    adminResult(socket, true, data.enabled
      ? target.name + " está verificado ✓."
      : "Verificación retirada.");
  }));

  socket.on("sponsor:set", data => adminSafeTarget(socket, {
    targetId: data?.playerId
  }, (admin, target) => {
    if (typeof data?.sponsored !== "boolean") {
      return adminResult(socket, false, "Solicitud no válida.");
    }

    const key = normalize(target.name);
    const wasSponsored = sponsoredNames.has(key);

    if (data.sponsored) sponsoredNames.add(key);
    else sponsoredNames.delete(key);

    try { writeSet(SPONSORS_FILE, sponsoredNames); }
    catch {
      if (wasSponsored) sponsoredNames.add(key);
      else sponsoredNames.delete(key);
      return adminResult(socket, false, "No se pudo guardar el cambio.");
    }

    broadcastSponsors();
    broadcastState();
    broadcastAdminPlayers();
    logAdmin(admin, "PATROCINADOR", target.name);
    adminResult(socket, true, data.sponsored ? "Marca azul concedida." : "Marca azul retirada.");
  }));

  socket.on("admin:teleport", data => adminSafeTarget(socket, data, (admin, target) => {
    target.x = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, admin.x + 3));
    target.y = 0;
    target.z = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, admin.z + 3));
    target.yaw = admin.yaw;
    target.lastMoveAt = Date.now();
    io.to(target.id).emit("admin:teleported", publicPlayer(target));
    broadcastState();
    broadcastAdminPlayers();
    logAdmin(admin, "TELETRANSPORTAR", target.name);
    adminResult(socket, true, target.name + " teletransportado.");
  }));

  socket.on("admin:setWeapon", data => adminSafeTarget(socket, data, (admin, target) => {
    const weapon = String(data?.weapon || "");
    if (!WEAPONS[weapon] || weapon === "creator") {
      return adminResult(socket, false, "Arma no válida.");
    }
    target.weapon = weapon;
    target.ammo = WEAPONS[weapon].ammo;
    io.to(target.id).emit("admin:weaponChanged", {
      weapon: target.weapon, ammo: target.ammo
    });
    broadcastState();
    broadcastAdminPlayers();
    logAdmin(admin, "CAMBIAR ARMA", target.name);
    adminResult(socket, true, "Arma cambiada.");
  }));

  socket.on("admin:broadcast", data => {
    const admin = getCreator(socket);
    if (!admin) return;
    const message = String(data?.message || "").trim().slice(0, 180);
    if (!message) return adminResult(socket, false, "Escribe un mensaje.");
    io.emit("notice", "📢 " + admin.name + ": " + message);
    logAdmin(admin, "AVISO GLOBAL", message);
    adminResult(socket, true, "Mensaje enviado.");
  });

  socket.on("admin:toggleFly", data => {
    const admin = getCreator(socket);
    if (!admin) return;
    admin.flyEnabled = Boolean(data?.enabled);
    if (!admin.flyEnabled) admin.y = 0;
    socket.emit("admin:flyStatus", { enabled: admin.flyEnabled });
    broadcastState();
    broadcastAdminPlayers();
    logAdmin(admin, "VUELO", admin.flyEnabled ? "Activado" : "Desactivado");
  });

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive || !data) return;

    const x = Number(data.x), y = Number(data.y);
    const z = Number(data.z), yaw = Number(data.yaw);
    if (![x, y, z, yaw].every(Number.isFinite)) return;

    const now = Date.now();
    const elapsed = Math.max(.05, Math.min(.5, (now - p.lastMoveAt) / 1000));
    const distance = Math.hypot(x - p.x, z - p.z);

    if (distance > 14.5 * elapsed + 1.1 ||
        Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) {
      socket.emit("moveCorrection", publicPlayer(p));
      p.lastMoveAt = now;
      return;
    }

    p.x = x;
    p.z = z;
    p.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    p.y = p.isCreator && p.flyEnabled
      ? Math.max(0, Math.min(30, y))
      : Math.max(0, Math.min(2, y));
    p.lastMoveAt = now;
  });

  socket.on("changeWeapon", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;
    const weapon = String(data?.weapon || "");
    if (!WEAPONS[weapon] || (weapon === "creator" && !p.isCreator)) return;
    p.weapon = weapon;
    p.ammo = WEAPONS[weapon].ammo;
    socket.emit("shotResult", { ok: true, ammo: p.ammo, weapon });
    broadcastState();
    broadcastAdminPlayers();
  });

  socket.on("shoot", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive || !data) return;

    const weapon = WEAPONS[p.weapon] || WEAPONS.pulse;
    const now = Date.now();

    if (now - p.lastShot < weapon.rate - 15) {
      return socket.emit("shotResult", {
        ok: false, ammo: p.ammo, message: "Dispara un poco más despacio."
      });
    }

    if (p.ammo <= 0) {
      return socket.emit("shotResult", {
        ok: false, ammo: 0, message: "Pulsa R para recargar."
      });
    }

    const yaw = Number(data.yaw), pitch = Number(data.pitch);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;

    p.lastShot = now;
    p.ammo--;

    const shot = findHit(p, yaw, pitch);
    io.emit("shotEffect", {
      shooterId: p.id,
      x: shot.origin.x, y: shot.origin.y, z: shot.origin.z,
      dx: shot.dir.x, dy: shot.dir.y, dz: shot.dir.z,
      distance: shot.distance, color: weapon.color
    });
    socket.emit("shotResult", { ok: true, ammo: p.ammo });

    const target = shot.target;
    if (!target) return broadcastState();

    if (target.isCreator) {
      socket.emit("hitConfirm", { targetId: target.id, damage: 0, health: MAX_HEALTH });
      return broadcastState();
    }

    target.health = Math.max(0, target.health - weapon.damage);

    socket.emit("hitConfirm", {
      targetId: target.id, damage: weapon.damage, health: target.health
    });

    io.emit("playerHit", {
      id: target.id, targetId: target.id, shooterId: p.id,
      damage: weapon.damage, health: target.health
    });

    if (target.health <= 0) eliminate(target, p, false);
    else {
      broadcastState();
      broadcastAdminPlayers();
    }
  });

  socket.on("reload", () => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;
    p.ammo = WEAPONS[p.weapon].ammo;
    socket.emit("shotResult", { ok: true, ammo: p.ammo });
    socket.emit("notice", "Arma recargada.");
  });

  socket.on("respawn", () => {
    const p = players.get(socket.id);
    if (p && !p.alive) respawnPlayer(p);
  });

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

for (let i = 0; i < 5; i++) {
  const pos = randomPosition();
  const id = crypto.randomUUID();
  medkits.set(id, { id, x: pos.x, y: .8, z: pos.z });
}

setInterval(() => {
  broadcastState();
  broadcastAdminPlayers();
}, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("LEGENDS OF ABDE activo en el puerto " + PORT);
  if (!CREATOR_KEY) console.warn("Configura CREATOR_KEY en Render.");
});

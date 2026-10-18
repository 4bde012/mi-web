
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

const WEAPONS = {
  pulse:   { name: "PULSE RIFLE", ammo: 30, rate: 220, damage: 25, color: "#00dfff" },
  plasma:  { name: "PLASMA DESTROYER", ammo: 12, rate: 500, damage: 50, color: "#b45cff" },
  rapid:   { name: "NEON RAPID SMG", ammo: 50, rate: 100, damage: 10, color: "#ff4545" },
  creator: { name: "ABDE CREATOR", ammo: 40, rate: 120, damage: 20, color: "#ffd700" }
};

const SKINS = ["cyber", "shadow", "inferno", "gold"];
const players = new Map();
const medkits = new Map();
const adminLogs = [];
let ranking = {};

function loadRanking() {
  try {
    if (fs.existsSync(RANKING_FILE)) {
      const data = JSON.parse(fs.readFileSync(RANKING_FILE, "utf8"));
      if (data && typeof data === "object" && !Array.isArray(data)) {
        ranking = data;
      }
    }
  } catch (error) {
    console.error("Error cargando ranking:", error.message);
  }
}

function saveRanking() {
  try {
    fs.mkdirSync(path.dirname(RANKING_FILE), { recursive: true });
    const temp = RANKING_FILE + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(ranking, null, 2), "utf8");
    fs.renameSync(temp, RANKING_FILE);
  } catch (error) {
    console.error("Error guardando ranking:", error.message);
  }
}

function rankingKey(name) {
  return String(name || "Jugador").trim().toLocaleLowerCase("es");
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

function logAdmin(admin, action, details = "") {
  const entry = {
    time: new Date().toISOString(),
    admin: String(admin?.name || "Administrador"),
    action: String(action).slice(0, 80),
    details: String(details).slice(0, 180)
  };

  adminLogs.unshift(entry);
  if (adminLogs.length > 100) adminLogs.length = 100;
  console.log("[ADMIN]", entry.admin, entry.action, entry.details);
}

function adminResult(socket, ok, message) {
  socket.emit("admin:actionResult", { ok: Boolean(ok), message: String(message) });
}

function randomPosition() {
  return {
    x: Math.round((Math.random() * 100 - 50) * 10) / 10,
    y: 0,
    z: Math.round((Math.random() * 100 - 50) * 10) / 10
  };
}

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

function spawnMedkit() {
  if (medkits.size >= MAX_MEDKITS) return;
  const pos = randomPosition();
  const id = crypto.randomUUID();

  medkits.set(id, { id, x: pos.x, y: 0.8, z: pos.z });
  broadcastMedkits();
}

function fillMedkits() {
  while (medkits.size < MAX_MEDKITS) spawnMedkit();
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

  io.to(p.id).emit("respawned", publicPlayer(p));
  broadcastState();
  broadcastAdminPlayers();
}

function killPlayer(target, attacker, adminAction = false) {
  if (!target || !target.alive || target.isCreator) return false;

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

  io.emit("notice",
    (attacker?.name || "Administrador") + " ha eliminado a " + target.name + ".");

  setTimeout(() => {
    const current = players.get(target.id);
    if (current && !current.alive) respawnPlayer(current);
  }, 3000);

  broadcastState();
  broadcastAdminPlayers();
  return true;
}

function findHitPlayer(shooter, yaw, pitch) {
  const dx = -Math.sin(yaw) * Math.cos(pitch);
  const dy = Math.sin(pitch);
  const dz = -Math.cos(yaw) * Math.cos(pitch);

  const origin = { x: shooter.x, y: shooter.y + 1.7, z: shooter.z };
  let best = null;
  let bestDistance = 60;

  for (const target of players.values()) {
    if (target.id === shooter.id || !target.alive) continue;

    const center = { x: target.x, y: target.y + 1.1, z: target.z };
    const rx = center.x - origin.x;
    const ry = center.y - origin.y;
    const rz = center.z - origin.z;
    const along = rx * dx + ry * dy + rz * dz;

    if (along < 0 || along > bestDistance) continue;

    const distance = Math.hypot(
      center.x - (origin.x + dx * along),
      center.y - (origin.y + dy * along),
      center.z - (origin.z + dz * along)
    );

    if (distance <= 1.15) {
      best = target;
      bestDistance = along;
    }
  }

  return {
    target: best,
    origin,
    direction: { x: dx, y: dy, z: dz },
    distance: best ? bestDistance : 60
  };
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

loadRanking();

app.get("/", (req, res) => {
  res.send("LEGENDS OF ABDE: servidor multijugador activo.");
});

app.get("/health", (req, res) => {
  res.json({ online: true, players: players.size, medkits: medkits.size });
});

app.get("/ranking", (req, res) => {
  res.json(getRanking());
});

io.on("connection", socket => {
  socket.on("joinGame", data => {
    if (players.size >= MAX_PLAYERS && !players.has(socket.id)) {
      socket.emit("notice", "La arena está llena.");
      socket.disconnect(true);
      return;
    }

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
      : (WEAPONS[requestedWeapon] && requestedWeapon !== "creator"
          ? requestedWeapon : "pulse");

    const skin = isCreator
      ? "creator"
      : (SKINS.includes(requestedSkin) ? requestedSkin : "cyber");

    const name = String(data.name || "Jugador").trim().slice(0, 16) || "Jugador";
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
      lastShot: 0
    };

    players.set(socket.id, p);
    socket.emit("joined", { you: publicPlayer(p) });
    socket.emit("medkits", Array.from(medkits.values()));
    socket.emit("worldRanking", getRanking());

    broadcastState();
    broadcastAdminPlayers();
    socket.broadcast.emit("notice", name + " ha entrado en la arena.");
  });

  // ===== PANEL ADMIN =====

  socket.on("admin:getPlayers", () => {
    if (getCreator(socket)) socket.emit("admin:players", adminPlayerList());
  });

  socket.on("admin:getRanking", () => {
    if (getCreator(socket)) socket.emit("worldRanking", getRanking());
  });

  socket.on("admin:getStats", () => {
    if (getCreator(socket)) socket.emit("admin:stats", getStats());
  });

  socket.on("admin:getLogs", () => {
    if (getCreator(socket)) socket.emit("admin:logs", adminLogs.slice(0, 100));
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
    adminResult(socket, ok, ok ? "Jugador eliminado." : "No se pudo eliminar.");
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
      adminResult(socket, true, target.name + " ya estaba vivo y ha sido curado.");
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

    target.x = Math.max(-77, Math.min(77, admin.x + 2));
    target.y = 0;
    target.z = Math.max(-77, Math.min(77, admin.z + 2));
    target.yaw = admin.yaw;

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
    if (!admin.flyEnabled) admin.y = 0;

    socket.emit("admin:flyStatus", { enabled: admin.flyEnabled });
    socket.emit("notice", admin.flyEnabled ? "Vuelo activado." : "Vuelo desactivado.");
    broadcastState();
  });

  // ===== MOVIMIENTO =====

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive || !data) return;

    const x = Number(data.x);
    const y = Number(data.y);
    const z = Number(data.z);
    const yaw = Number(data.yaw);

    if (![x, y, z, yaw].every(Number.isFinite)) return;

    p.x = Math.max(-77, Math.min(77, x));
    p.z = Math.max(-77, Math.min(77, z));
    p.yaw = yaw;
    p.y = p.isCreator && p.flyEnabled
      ? Math.max(0, Math.min(30, y))
      : Math.max(0, Math.min(2, y));
  });

  // ===== DISPAROS =====

  socket.on("shoot", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;

    const weapon = WEAPONS[p.weapon] || WEAPONS.pulse;
    const now = Date.now();

    if (now - p.lastShot < weapon.rate - 15) {
      socket.emit("shotResult", {
        ok: false, ammo: p.ammo, message: "Dispara un poco más despacio."
      });
      return;
    }

    if (p.ammo <= 0) {
      socket.emit("shotResult", { ok: false, ammo: 0, message: "Pulsa R para recargar." });
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

    socket.emit("shotResult", { ok: true, ammo: p.ammo });

    if (shot.target) {
      const target = shot.target;

      if (target.isCreator) {
        target.health = MAX_HEALTH;
        socket.emit("hitConfirm", { targetId: target.id, damage: 0, health: MAX_HEALTH });
        broadcastState();
        return;
      }

      target.health = Math.max(0, target.health - weapon.damage);

      socket.emit("hitConfirm", { targetId: target.id, damage: weapon.damage, health: target.health });

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
    }
  });

  socket.on("reload", () => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;

    p.ammo = WEAPONS[p.weapon]?.ammo || WEAPONS.pulse.ammo;
    socket.emit("shotResult", { ok: true, ammo: p.ammo });
    socket.emit("notice", "Arma recargada.");
    broadcastState();
  });

  // ===== BOTIQUINES =====

  socket.on("collectMedkit", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive || !data?.id) return;

    const kit = medkits.get(String(data.id));

    if (!kit) {
      socket.emit("medkitCollected", {
        id: String(data.id), playerId: p.id, health: p.health, ok: false
      });
      return;
    }

    const distance = Math.hypot(p.x - kit.x, p.z - kit.z);

    if (distance > 3.5 || p.health >= MAX_HEALTH) {
      socket.emit("medkitCollected", {
        id: kit.id, playerId: p.id, health: p.health, ok: false
      });
      return;
    }

    p.health = Math.min(MAX_HEALTH, p.health + MEDKIT_HEAL);
    medkits.delete(kit.id);

    io.emit("medkitCollected", {
      id: kit.id, playerId: p.id, health: p.health, ok: true
    });

    broadcastMedkits();
    broadcastState();
    setTimeout(spawnMedkit, 8000);
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

fillMedkits();

setInterval(() => {
  fillMedkits();
  broadcastState();
  broadcastAdminPlayers();
}, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("LEGENDS OF ABDE escuchando en el puerto " + PORT);

  if (!CREATOR_KEY) {
    console.warn("AVISO: configura CREATOR_KEY en las variables de entorno.");
  }
});

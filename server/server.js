
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
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 40;
const MAX_HEALTH = 100;
const MEDKIT_HEAL = 40;
const MAX_MEDKITS = 5;
const CREATOR_KEY = process.env.CREATOR_KEY || "";

const RANKING_FILE =
  process.env.RANKING_FILE ||
  path.join(__dirname, "ranking.json");

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
const CREATOR_SKIN = "creator";

const players = new Map();
const medkits = new Map();

let ranking = {};

// =========================
// RANKING MUNDIAL
// =========================

function loadRanking() {
  try {
    if (fs.existsSync(RANKING_FILE)) {
      const contents = fs.readFileSync(RANKING_FILE, "utf8");
      const parsed = JSON.parse(contents);

      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        ranking = parsed;
      }
    }
  } catch (error) {
    console.error(
      "No se pudo leer el ranking:",
      error.message
    );

    ranking = {};
  }
}

function saveRanking() {
  try {
    const folder = path.dirname(RANKING_FILE);

    fs.mkdirSync(folder, { recursive: true });

    const tempFile = RANKING_FILE + ".tmp";

    fs.writeFileSync(
      tempFile,
      JSON.stringify(ranking, null, 2),
      "utf8"
    );

    fs.renameSync(tempFile, RANKING_FILE);
  } catch (error) {
    console.error(
      "No se pudo guardar el ranking:",
      error.message
    );
  }
}

function playerRankingKey(name) {
  return String(name || "Jugador")
    .trim()
    .toLocaleLowerCase("es");
}

function ensureRankingEntry(name) {
  const key = playerRankingKey(name);

  if (!ranking[key]) {
    ranking[key] = {
      name: String(name || "Jugador").slice(0, 16),
      kills: 0,
      deaths: 0
    };
  } else {
    ranking[key].name =
      String(name || "Jugador").slice(0, 16);

    ranking[key].kills = Math.max(
      0,
      Number(ranking[key].kills) || 0
    );

    ranking[key].deaths = Math.max(
      0,
      Number(ranking[key].deaths) || 0
    );
  }

  return ranking[key];
}

function getWorldRanking() {
  return Object.values(ranking)
    .map(entry => ({
      name: String(entry.name || "Jugador"),
      kills: Math.max(0, Number(entry.kills) || 0),
      deaths: Math.max(0, Number(entry.deaths) || 0)
    }))
    .sort((a, b) =>
      b.kills - a.kills ||
      a.deaths - b.deaths ||
      a.name.localeCompare(b.name)
    )
    .slice(0, 100);
}

function broadcastRanking() {
  io.emit("worldRanking", getWorldRanking());
}

loadRanking();

// =========================
// RUTAS DEL SERVIDOR
// =========================

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
  res.json(getWorldRanking());
});

// =========================
// JUGADORES
// =========================

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
    alive: p.isCreator ? true : p.alive,
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
    alive: p.isCreator ? true : p.alive,
    isCreator: p.isCreator
  }));
}

function broadcastState() {
  io.emit(
    "state",
    Array.from(players.values(), publicPlayer)
  );
}

function broadcastMedkits() {
  io.emit("medkits", Array.from(medkits.values()));
}

function broadcastAdminPlayerList() {
  for (const p of players.values()) {
    if (p.isCreator) {
      io.to(p.id).emit(
        "admin:players",
        adminPlayerList()
      );
    }
  }
}

// =========================
// BOTIQUINES
// =========================

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

// =========================
// REAPARICIÓN
// =========================

function respawnPlayer(p) {
  if (!players.has(p.id)) return;

  // El creador no necesita reaparecer porque no puede morir.
  if (p.isCreator && p.rank === "CREADOR") {
    p.health = MAX_HEALTH;
    p.alive = true;

    broadcastState();
    broadcastAdminPlayerList();

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
  broadcastAdminPlayerList();
}

// =========================
// DETECCIÓN DE DISPAROS
// =========================

function findHitPlayer(shooter, yaw, pitch) {
  const dx = -Math.sin(yaw) * Math.cos(pitch);
  const dy = Math.sin(pitch);
  const dz = -Math.cos(yaw) * Math.cos(pitch);

  const origin = {
    x: shooter.x,
    y: shooter.y + 1.7,
    z: shooter.z
  };

  let best = null;
  let bestDistance = 60;

  for (const target of players.values()) {
    if (target.id === shooter.id || !target.alive) {
      continue;
    }

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

    const closest = {
      x: origin.x + dx * along,
      y: origin.y + dy * along,
      z: origin.z + dz * along
    };

    const distance = Math.hypot(
      center.x - closest.x,
      center.y - closest.y,
      center.z - closest.z
    );

    if (distance <= 1.15) {
      best = target;
      bestDistance = along;
    }
  }

  return {
    target: best,
    origin,
    direction: {
      x: dx,
      y: dy,
      z: dz
    },
    distance: best ? bestDistance : 60
  };
}

// =========================
// PERMISOS DE ADMINISTRADOR
// =========================

function getCreator(socket) {
  const p = players.get(socket.id);

  if (!p || !p.isCreator || p.rank !== "CREADOR") {
    socket.emit(
      "admin:error",
      "No tienes permisos de administrador."
    );

    return null;
  }

  return p;
}

// =========================
// ELIMINACIÓN SEGURA
// =========================

function killPlayer(
  target,
  attacker,
  isAdminAction = false
) {
  if (!target || !target.alive) return false;

  // PROTECCIÓN: el creador nunca puede morir.
  if (target.isCreator && target.rank === "CREADOR") {
    target.health = MAX_HEALTH;
    target.alive = true;

    broadcastState();
    broadcastAdminPlayerList();

    return false;
  }

  target.health = 0;
  target.alive = false;
  target.deaths++;

  const victimEntry = ensureRankingEntry(target.name);
  victimEntry.deaths++;

  if (
    !isAdminAction &&
    attacker &&
    attacker.id !== target.id
  ) {
    attacker.kills++;
    ensureRankingEntry(attacker.name).kills++;
  }

  saveRanking();
  broadcastRanking();

  io.emit("elimination", {
    attacker: attacker ? attacker.id : null,
    victim: target.id,
    attackerKills: attacker ? attacker.kills : 0,
    victimDeaths: target.deaths,
    adminAction: isAdminAction
  });

  io.emit(
    "notice",
    (attacker ? attacker.name : "Administrador") +
    " ha eliminado a " + target.name + "."
  );

  setTimeout(() => {
    const current = players.get(target.id);

    if (current && !current.alive) {
      respawnPlayer(current);
    }
  }, 3000);

  broadcastState();
  broadcastAdminPlayerList();

  return true;
}

// =========================
// CONEXIÓN MULTIJUGADOR
// =========================

io.on("connection", socket => {

  socket.on("joinGame", data => {
    if (
      players.size >= MAX_PLAYERS &&
      !players.has(socket.id)
    ) {
      socket.emit("notice", "La arena está llena.");
      socket.disconnect(true);
      return;
    }

    data = data && typeof data === "object" ? data : {};

    const isCreator =
      CREATOR_KEY.length > 0 &&
      typeof data.creatorKey === "string" &&
      data.creatorKey.length > 0 &&
      data.creatorKey === CREATOR_KEY;

    const requestedWeapon =
      typeof data.weapon === "string"
        ? data.weapon
        : "pulse";

    const requestedSkin =
      typeof data.skin === "string"
        ? data.skin
        : "cyber";

    let weapon = "pulse";
    let skin = "cyber";

    if (isCreator) {
      weapon = WEAPONS[requestedWeapon]
        ? requestedWeapon
        : "pulse";

      skin = CREATOR_SKIN;
    } else {
      weapon =
        WEAPONS[requestedWeapon] &&
        requestedWeapon !== "creator"
          ? requestedWeapon
          : "pulse";

      skin = SKINS.includes(requestedSkin)
        ? requestedSkin
        : "cyber";
    }

    const pos = randomPosition();

    const name = String(data.name || "Jugador")
      .trim()
      .slice(0, 16) || "Jugador";

    const entry = ensureRankingEntry(name);

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
      reloadUntil: 0
    };

    players.set(socket.id, p);

    socket.emit("joined", {
      you: publicPlayer(p)
    });

    socket.emit("medkits", Array.from(medkits.values()));
    socket.emit("worldRanking", getWorldRanking());

    broadcastState();
    broadcastAdminPlayerList();

    socket.broadcast.emit(
      "notice",
      p.name + " ha entrado en la arena."
    );
  });

  // =========================
  // PANEL DE ADMINISTRADOR
  // =========================

  socket.on("admin:getPlayers", () => {
    const admin = getCreator(socket);
    if (!admin) return;

    socket.emit("admin:players", adminPlayerList());
  });

  socket.on("admin:kill", data => {
    const admin = getCreator(socket);
    if (!admin) return;

    const targetId = String(data?.targetId || "");
    const target = players.get(targetId);

    if (!target) {
      socket.emit("admin:killResult", {
        ok: false,
        message: "Ese jugador ya no está conectado."
      });

      return;
    }

    if (target.id === admin.id) {
      socket.emit("admin:killResult", {
        ok: false,
        message: "No puedes seleccionarte a ti mismo."
      });

      return;
    }

    if (target.isCreator && target.rank === "CREADOR") {
      socket.emit("admin:killResult", {
        ok: false,
        message: "No puedes eliminar al creador."
      });

      return;
    }

    if (!target.alive) {
      socket.emit("admin:killResult", {
        ok: false,
        message: "Ese jugador ya está eliminado."
      });

      return;
    }

    const success = killPlayer(target, admin, true);

    socket.emit("admin:killResult", {
      ok: success,
      message: success
        ? "Jugador eliminado."
        : "No se pudo eliminar al jugador."
    });
  });

  socket.on("admin:toggleFly", data => {
    const admin = getCreator(socket);
    if (!admin) return;

    const enabled = Boolean(data?.enabled);

    admin.flyEnabled = enabled;

    if (!enabled) {
      admin.y = 0;
    }

    socket.emit("admin:flyStatus", {
      enabled: admin.flyEnabled
    });

    socket.emit(
      "notice",
      admin.flyEnabled
        ? "Modo vuelo activado."
        : "Modo vuelo desactivado."
    );

    broadcastState();
  });

  socket.on("admin:getRanking", () => {
    const admin = getCreator(socket);
    if (!admin) return;

    socket.emit("worldRanking", getWorldRanking());
  });

  socket.on("admin:getStats", () => {
    const admin = getCreator(socket);
    if (!admin) return;

    let totalKills = 0;
    let totalDeaths = 0;

    for (const entry of Object.values(ranking)) {
      totalKills += Number(entry.kills) || 0;
      totalDeaths += Number(entry.deaths) || 0;
    }

    socket.emit("admin:stats", {
      online: players.size,
      maxPlayers: MAX_PLAYERS,
      totalKills,
      totalDeaths,
      rankingPlayers: Object.keys(ranking).length
    });
  });

  // =========================
  // MOVIMIENTO
  // =========================

  socket.on("move", data => {
    const p = players.get(socket.id);

    if (!p || !p.alive || !data) return;

    const x = Number(data.x);
    const y = Number(data.y);
    const z = Number(data.z);
    const yaw = Number(data.yaw);

    if (![x, y, z, yaw].every(Number.isFinite)) {
      return;
    }

    p.x = Math.max(-77, Math.min(77, x));
    p.z = Math.max(-77, Math.min(77, z));
    p.yaw = yaw;

    if (p.isCreator && p.flyEnabled) {
      p.y = Math.max(0, Math.min(30, y));
    } else {
      p.y = Math.max(0, Math.min(2, y));
    }
  });

  // =========================
  // DISPAROS
  // =========================

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

    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      socket.emit("shotResult", {
        ok: false,
        ammo: p.ammo
      });

      return;
    }

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

    if (shot.target) {
      const target = shot.target;

      // PROTECCIÓN: los disparos no dañan al creador.
      if (target.isCreator && target.rank === "CREADOR") {
        target.health = MAX_HEALTH;
        target.alive = true;

        socket.emit("hitConfirm", {
          targetId: target.id,
          damage: 0,
          health: MAX_HEALTH
        });

        broadcastState();
        broadcastAdminPlayerList();

        return;
      }

      target.health = Math.max(
        0,
        target.health - weapon.damage
      );

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
        broadcastAdminPlayerList();
      }
    }
  });

  // =========================
  // RECARGA
  // =========================

  socket.on("reload", () => {
    const p = players.get(socket.id);

    if (!p || !p.alive) return;

    p.ammo =
      WEAPONS[p.weapon]?.ammo ||
      WEAPONS.pulse.ammo;

    socket.emit("shotResult", {
      ok: true,
      ammo: p.ammo
    });

    socket.emit("notice", "Arma recargada.");

    broadcastState();
  });

  // =========================
  // RECOGER BOTIQUINES
  // =========================

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

    const distance = Math.hypot(
      p.x - kit.x,
      p.z - kit.z
    );

    if (
      distance > 3.5 ||
      p.health >= MAX_HEALTH
    ) {
      socket.emit("medkitCollected", {
        id: kit.id,
        playerId: p.id,
        health: p.health,
        ok: false
      });

      return;
    }

    p.health = Math.min(
      MAX_HEALTH,
      p.health + MEDKIT_HEAL
    );

    medkits.delete(kit.id);

    io.emit("medkitCollected", {
      id: kit.id,
      playerId: p.id,
      health: p.health,
      ok: true
    });

    broadcastMedkits();
    broadcastState();

    setTimeout(spawnMedkit, 8000);
  });

  // =========================
  // SOLICITUD DE REAPARICIÓN
  // =========================

  socket.on("respawn", () => {
    const p = players.get(socket.id);

    if (p && !p.alive) {
      respawnPlayer(p);
    }
  });

  // =========================
  // DESCONEXIÓN
  // =========================

  socket.on("disconnect", () => {
    const p = players.get(socket.id);

    players.delete(socket.id);

    if (p) {
      io.emit(
        "notice",
        p.name + " ha salido de la arena."
      );

      broadcastState();
      broadcastAdminPlayerList();
    }
  });
});

// =========================
// INICIO DEL SERVIDOR
// =========================

fillMedkits();

setInterval(() => {
  fillMedkits();
  broadcastState();
  broadcastAdminPlayerList();
}, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    "LEGENDS OF ABDE escuchando en el puerto " + PORT
  );

  if (!CREATOR_KEY) {
    console.warn(
      "AVISO: configura CREATOR_KEY en las variables de entorno."
    );
  }
});

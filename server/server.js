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

const SPONSORS_FILE = process.env.SPONSORS_FILE ||
  path.join(__dirname, "sponsors.json");

const WORLD_LIMIT = 77;
const PLAYER_RADIUS = 0.65;
const MAX_MOVE_SPEED = 14.5;
const SHOT_RANGE = 60;

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

/* =====================================================
   TICKS AZULES DE PATROCINADORES
   ===================================================== */

const sponsoredNames = new Set();

function normalizeSponsorName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function isSponsored(name) {
  return sponsoredNames.has(normalizeSponsorName(name));
}

function loadSponsors() {
  try {
    if (!fs.existsSync(SPONSORS_FILE)) return;

    const data = JSON.parse(
      fs.readFileSync(SPONSORS_FILE, "utf8")
    );

    if (Array.isArray(data)) {
      sponsoredNames.clear();

      for (const name of data) {
        const normalized = normalizeSponsorName(name);

        if (normalized) {
          sponsoredNames.add(normalized);
        }
      }
    }

    console.log(
      "Patrocinadores cargados:",
      sponsoredNames.size
    );
  } catch (error) {
    console.error(
      "Error cargando patrocinadores:",
      error.message
    );
  }
}

function saveSponsors() {
  const directory = path.dirname(SPONSORS_FILE);

  fs.mkdirSync(directory, { recursive: true });

  const tempFile = SPONSORS_FILE + ".tmp";

  fs.writeFileSync(
    tempFile,
    JSON.stringify([...sponsoredNames].sort(), null, 2),
    "utf8"
  );

  fs.renameSync(tempFile, SPONSORS_FILE);
}

function broadcastSponsors() {
  io.emit("sponsor:state", {
    names: [...sponsoredNames]
  });
}

/* =====================================================
   COLISIONES DEL MUNDO
   ===================================================== */

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

  addCollider(0, 5, -80, 160, 10, 3);
  addCollider(0, 5, 80, 160, 10, 3);
  addCollider(-80, 5, 0, 3, 10, 160);
  addCollider(80, 5, 0, 3, 10, 160);

  addCollider(0, 0.35, 0, 18, 0.7, 18);

  addCollider(-18, 3, -18, 5, 6, 5);
  addCollider(18, 3, -18, 5, 6, 5);
  addCollider(-18, 3, 18, 5, 6, 5);
  addCollider(18, 3, 18, 5, 6, 5);

  addCollider(0, 1.2, -28, 13, 2.4, 3);
  addCollider(0, 1.2, 28, 13, 2.4, 3);
  addCollider(-28, 1.2, 0, 3, 2.4, 13);
  addCollider(28, 1.2, 0, 3, 2.4, 13);

  addCollider(-10, 0.65, -10, 9, 1.3, 1.4);
  addCollider(10, 0.65, -10, 9, 1.3, 1.4);
  addCollider(-10, 0.65, 10, 9, 1.3, 1.4);
  addCollider(10, 0.65, 10, 9, 1.3, 1.4);

  for (let i = 0; i < 20; i++) {
    const angle = i * Math.PI * 2 / 20;
    const x = Math.cos(angle) * 53;
    const z = Math.sin(angle) * 53;

    addCollider(x, 1.7, z, 1, 3.4, 1);
  }
}

buildWorldColliders();

function positionBlocked(x, z) {
  if (
    x < -WORLD_LIMIT || x > WORLD_LIMIT ||
    z < -WORLD_LIMIT || z > WORLD_LIMIT
  ) {
    return true;
  }

  for (const c of WORLD_COLLIDERS) {
    if (c.minY > 1.95) continue;

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

    if (
      positionBlocked(
        x1 + (x2 - x1) * t,
        z1 + (z2 - z1) * t
      )
    ) {
      return true;
    }
  }

  return false;
}

function randomPosition() {
  for (let i = 0; i < 200; i++) {
    const x = Math.round((Math.random() * 100 - 50) * 10) / 10;
    const z = Math.round((Math.random() * 100 - 50) * 10) / 10;

    if (!positionBlocked(x, z)) {
      return { x, y: 0, z };
    }
  }

  return { x: 0, y: 0, z: 15 };
}

/* =====================================================
   RANKING
   ===================================================== */

function loadRanking() {
  try {
    if (!fs.existsSync(RANKING_FILE)) return;

    const data = JSON.parse(
      fs.readFileSync(RANKING_FILE, "utf8")
    );

    if (
      data &&
      typeof data === "object" &&
      !Array.isArray(data)
    ) {
      ranking = data;
    }
  } catch (error) {
    console.error(
      "Error cargando ranking:",
      error.message
    );
  }
}

function saveRanking() {
  try {
    fs.mkdirSync(path.dirname(RANKING_FILE), {
      recursive: true
    });

    const temp = RANKING_FILE + ".tmp";

    fs.writeFileSync(
      temp,
      JSON.stringify(ranking, null, 2),
      "utf8"
    );

    fs.renameSync(temp, RANKING_FILE);
  } catch (error) {
    console.error(
      "Error guardando ranking:",
      error.message
    );
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

  ranking[key].kills = Math.max(
    0,
    Number(ranking[key].kills) || 0
  );

  ranking[key].deaths = Math.max(
    0,
    Number(ranking[key].deaths) || 0
  );

  return ranking[key];
}

function getRanking() {
  return Object.values(ranking)
    .map(p => ({
      name: String(p.name || "Jugador"),
      kills: Math.max(0, Number(p.kills) || 0),
      deaths: Math.max(0, Number(p.deaths) || 0)
    }))
    .sort(
      (a, b) =>
        b.kills - a.kills ||
        a.deaths - b.deaths
    )
    .slice(0, 100);
}

function broadcastRanking() {
  io.emit("worldRanking", getRanking());
}

/* =====================================================
   JUGADORES
   ===================================================== */

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    skin: p.skin,
    weapon: p.weapon,
    rank: p.rank,

    // El estado del patrocinador se envía a todos.
    sponsored: isSponsored(p.name),

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

    // También aparece en la lista del panel.
    sponsored: isSponsored(p.name),

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
  io.emit(
    "state",
    Array.from(players.values(), publicPlayer)
  );
}

function broadcastMedkits() {
  io.emit("medkits", Array.from(medkits.values()));
}

function broadcastAdminPlayers() {
  for (const p of players.values()) {
    if (p.isCreator) {
      io.to(p.id).emit(
        "admin:players",
        adminPlayerList()
      );
    }
  }
}

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

  console.log(
    "[ADMIN]",
    entry.admin,
    entry.action,
    entry.details
  );
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

  if (!admin) {
    return { admin: null, target: null };
  }

  const target = players.get(
    String(data?.targetId || "")
  );

  if (!target) {
    adminResult(
      socket,
      false,
      "El jugador ya no está conectado."
    );

    return { admin, target: null };
  }

  if (target.isCreator || target.id === admin.id) {
    adminResult(
      socket,
      false,
      "Esta acción no se puede aplicar al creador."
    );

    return { admin, target: null };
  }

  return { admin, target };
}

/* =====================================================
   BOTIQUINES Y REAPARICIÓN
   ===================================================== */

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

/* =====================================================
   ELIMINACIONES
   ===================================================== */

function killPlayer(target, attacker, adminAction = false) {
  if (!target || !target.alive || target.isCreator) {
    return false;
  }

  target.health = 0;
  target.alive = false;
  target.deaths++;

  ensureRanking(target.name).deaths++;

  if (
    !adminAction &&
    attacker &&
    attacker.id !== target.id
  ) {
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

/* =====================================================
   RAYOS Y DETECCIÓN DE IMPACTOS
   ===================================================== */

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

    if (t1 > t2) [t1, t2] = [t2, t1];

    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);

    if (tMin > tMax) return null;
  }

  if (tMax < 0) return null;

  return tMin >= 0 ? tMin : tMax;
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

  let wallDistance = SHOT_RANGE;

  for (const box of WORLD_COLLIDERS) {
    const distance = rayBoxDistance(
      origin,
      direction,
      box,
      SHOT_RANGE
    );

    if (
      distance !== null &&
      distance < wallDistance
    ) {
      wallDistance = distance;
    }
  }

  let best = null;
  let bestDistance = wallDistance;

  for (const target of players.values()) {
    if (target.id === shooter.id || !target.alive) {
      continue;
    }

    const minY = target.y + 0.1;
    const maxY = target.y + 2.2;
    const radius = 0.85;

    const box = {
      minX: target.x - radius,
      maxX: target.x + radius,
      minY,
      maxY,
      minZ: target.z - radius,
      maxZ: target.z + radius
    };

    const distance = rayBoxDistance(
      origin,
      direction,
      box,
      bestDistance
    );

    if (
      distance !== null &&
      distance <= bestDistance
    ) {
      best = target;
      bestDistance = distance;
    }
  }

  return {
    target: best,
    origin,
    direction,
    distance: best ? bestDistance : wallDistance
  };
}

/* =====================================================
   TELETRANSPORTE
   ===================================================== */

function findSafePositionNear(x, z) {
  const offsets = [
    [2, 0], [-2, 0], [0, 2], [0, -2],
    [3, 3], [-3, 3], [3, -3], [-3, -3],
    [5, 0], [-5, 0], [0, 5], [0, -5]
  ];

  for (const [dx, dz] of offsets) {
    const px = Math.max(
      -WORLD_LIMIT,
      Math.min(WORLD_LIMIT, x + dx)
    );

    const pz = Math.max(
      -WORLD_LIMIT,
      Math.min(WORLD_LIMIT, z + dz)
    );

    if (!positionBlocked(px, pz)) {
      return { x: px, y: 0, z: pz };
    }
  }

  return randomPosition();
}

/* =====================================================
   HTTP
   ===================================================== */

// Cargar los datos guardados antes de aceptar jugadores.
loadRanking();
loadSponsors();

app.get("/", (req, res) => {
  res.send(
    "LEGENDS OF ABDE: servidor multijugador activo."
  );
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

/* =====================================================
   SOCKET.IO
   ===================================================== */

io.on("connection", socket => {
  console.log("Conexión:", socket.id);

  /* ENTRADA A LA PARTIDA */

  socket.on("joinGame", data => {
    if (
      players.size >= MAX_PLAYERS &&
      !players.has(socket.id)
    ) {
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

    const requestedWeapon = String(
      data.weapon || "pulse"
    );

    const requestedSkin = String(
      data.skin || "cyber"
    );

    const weapon = isCreator
      ? (
          WEAPONS[requestedWeapon]
            ? requestedWeapon
            : "pulse"
        )
      : (
          WEAPONS[requestedWeapon] &&
          requestedWeapon !== "creator"
            ? requestedWeapon
            : "pulse"
        );

    const skin = isCreator
      ? "creator"
      : (
          SKINS.includes(requestedSkin)
            ? requestedSkin
            : "cyber"
        );

    const name =
      String(data.name || "Jugador")
        .trim()
        .slice(0, 16) || "Jugador";

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

    // El HTML usa este evento para abrir el panel
    // solamente cuando el servidor valida al creador.
    socket.emit("creatorVerified", {
      ok: isCreator
    });

    socket.emit("joined", {
      you: publicPlayer(p)
    });

    // El HTML recibe la lista de nombres patrocinados.
    socket.emit("sponsor:state", {
      names: [...sponsoredNames]
    });

    socket.emit(
      "medkits",
      Array.from(medkits.values())
    );

    socket.emit("worldRanking", getRanking());

    broadcastState();
    broadcastAdminPlayers();

    socket.broadcast.emit(
      "notice",
      name + " ha entrado en la arena."
    );
  });

  /* ===================================================
     EVENTOS DEL PANEL DE ADMINISTRADOR
     =================================================== */

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
      socket.emit(
        "admin:logs",
        adminLogs.slice(0, 100)
      );
    }
  });

  /* ===================================================
     CONCEDER Y RETIRAR TICKS AZULES
     =================================================== */

  socket.on("sponsor:set", data => {
    const admin = getCreator(socket);

    if (!admin) return;

    const targetId = String(data?.playerId || "");
    const enable = data?.sponsored;

    if (!targetId || typeof enable !== "boolean") {
      socket.emit("sponsor:result", {
        ok: false,
        message: "Solicitud no válida."
      });

      adminResult(
        socket,
        false,
        "Solicitud no válida."
      );

      return;
    }

    const target = players.get(targetId);

    if (!target) {
      socket.emit("sponsor:result", {
        ok: false,
        message: "El jugador ya no está conectado."
      });

      adminResult(
        socket,
        false,
        "El jugador ya no está conectado."
      );

      return;
    }

    if (target.isCreator || target.id === admin.id) {
      socket.emit("sponsor:result", {
        ok: false,
        message: "No puedes cambiar tu propio tick."
      });

      adminResult(
        socket,
        false,
        "No puedes cambiar tu propio tick."
      );

      return;
    }

    const sponsorName = normalizeSponsorName(
      target.name
    );

    if (!sponsorName) {
      adminResult(
        socket,
        false,
        "El nombre no es válido."
      );

      return;
    }

    const wasSponsored = sponsoredNames.has(
      sponsorName
    );

    if (enable) {
      sponsoredNames.add(sponsorName);
    } else {
      sponsoredNames.delete(sponsorName);
    }

    try {
      saveSponsors();
    } catch (error) {
      // Si no se puede guardar, deshacer el cambio.
      if (wasSponsored) {
        sponsoredNames.add(sponsorName);
      } else {
        sponsoredNames.delete(sponsorName);
      }

      console.error(
        "Error guardando el tick azul:",
        error.message
      );

      socket.emit("sponsor:result", {
        ok: false,
        message: "No se pudo guardar el cambio."
      });

      adminResult(
        socket,
        false,
        "No se pudo guardar el cambio. Revisa el almacenamiento."
      );

      return;
    }

    // Actualizar el juego y el panel para todos.
    broadcastSponsors();
    broadcastState();
    broadcastAdminPlayers();

    logAdmin(
      admin,
      enable ? "DAR TICK AZUL" : "QUITAR TICK AZUL",
      target.name
    );

    io.to(target.id).emit(
      "notice",
      enable
        ? "¡El creador te ha concedido el tick azul!"
        : "El creador te ha retirado el tick azul."
    );

    socket.emit("sponsor:result", {
      ok: true,
      sponsored: enable,
      playerName: target.name,
      message: enable
        ? "Tick azul concedido."
        : "Tick azul retirado."
    });

    adminResult(
      socket,
      true,
      enable
        ? "Tick azul concedido a " + target.name + "."
        : "Tick azul retirado a " + target.name + "."
    );
  });

  /* ELIMINAR JUGADOR */

  socket.on("admin:kill", data => {
    const { admin, target } = targetForAdmin(
      socket,
      data
    );

    if (!admin || !target) return;

    if (!target.alive) {
      adminResult(
        socket,
        false,
        "Ese jugador ya está eliminado."
      );

      return;
    }

    const ok = killPlayer(target, admin, true);

    if (ok) {
      logAdmin(admin, "ELIMINAR", target.name);
    }

    adminResult(
      socket,
      ok,
      ok
        ? "Jugador eliminado."
        : "No se pudo eliminar."
    );
  });

  /* CURAR JUGADOR */

  socket.on("admin:heal", data => {
    const { admin, target } = targetForAdmin(
      socket,
      data
    );

    if (!admin || !target) return;

    if (!target.alive) {
      adminResult(
        socket,
        false,
        "El jugador está eliminado. Revívelo primero."
      );

      return;
    }

    target.health = MAX_HEALTH;

    logAdmin(admin, "CURAR", target.name);

    io.to(target.id).emit(
      "notice",
      "El administrador te ha curado."
    );

    adminResult(
      socket,
      true,
      target.name + " tiene toda la vida."
    );

    broadcastState();
    broadcastAdminPlayers();
  });

  /* REVIVIR JUGADOR */

  socket.on("admin:revive", data => {
    const { admin, target } = targetForAdmin(
      socket,
      data
    );

    if (!admin || !target) return;

    if (target.alive) {
      target.health = MAX_HEALTH;

      broadcastState();
      broadcastAdminPlayers();

      adminResult(
        socket,
        true,
        target.name +
          " ya estaba vivo y ha sido curado."
      );

      return;
    }

    respawnPlayer(target);

    logAdmin(admin, "REVIVIR", target.name);

    io.to(target.id).emit(
      "notice",
      "El administrador te ha revivido."
    );

    adminResult(
      socket,
      true,
      target.name + " ha vuelto a la arena."
    );
  });

  /* TELETRANSPORTAR JUGADOR */

  socket.on("admin:teleport", data => {
    const { admin, target } = targetForAdmin(
      socket,
      data
    );

    if (!admin || !target) return;

    if (!target.alive) {
      adminResult(
        socket,
        false,
        "Primero debes revivir al jugador."
      );

      return;
    }

    const pos = findSafePositionNear(
      admin.x,
      admin.z
    );

    target.x = pos.x;
    target.y = pos.y;
    target.z = pos.z;
    target.yaw = admin.yaw;
    target.lastMoveAt = Date.now();

    io.to(target.id).emit(
      "admin:teleported",
      publicPlayer(target)
    );

    io.to(target.id).emit(
      "notice",
      "El administrador te ha teletransportado."
    );

    logAdmin(
      admin,
      "TELETRANSPORTAR",
      target.name
    );

    adminResult(
      socket,
      true,
      target.name + " ha sido teletransportado."
    );

    broadcastState();
    broadcastAdminPlayers();
  });

  /* EXPULSAR JUGADOR */

  socket.on("admin:kick", data => {
    const { admin, target } = targetForAdmin(
      socket,
      data
    );

    if (!admin || !target) return;

    logAdmin(admin, "EXPULSAR", target.name);

    const targetSocket = io.sockets.sockets.get(
      target.id
    );

    if (targetSocket) {
      targetSocket.emit(
        "notice",
        "Has sido expulsado por el administrador."
      );

      targetSocket.disconnect(true);
    }

    adminResult(
      socket,
      true,
      target.name + " ha sido expulsado."
    );
  });

  /* CAMBIAR ARMA */

  socket.on("admin:setWeapon", data => {
    const { admin, target } = targetForAdmin(
      socket,
      data
    );

    if (!admin || !target) return;

    const weapon = String(data?.weapon || "");

    if (!WEAPONS[weapon] || weapon === "creator") {
      adminResult(
        socket,
        false,
        "Arma no válida."
      );

      return;
    }

    target.weapon = weapon;
    target.ammo = WEAPONS[weapon].ammo;

    io.to(target.id).emit(
      "admin:weaponChanged",
      {
        weapon: target.weapon,
        ammo: target.ammo
      }
    );

    io.to(target.id).emit(
      "notice",
      "El administrador te ha cambiado el arma."
    );

    logAdmin(
      admin,
      "CAMBIAR ARMA",
      target.name + " → " + WEAPONS[weapon].name
    );

    adminResult(
      socket,
      true,
      "Arma cambiada a " +
        WEAPONS[weapon].name + "."
    );

    broadcastState();
    broadcastAdminPlayers();
  });

  /* MENSAJE GLOBAL */

  socket.on("admin:broadcast", data => {
    const admin = getCreator(socket);

    if (!admin) return;

    const message = String(
      data?.message || ""
    ).trim().slice(0, 180);

    if (!message) {
      adminResult(
        socket,
        false,
        "Escribe un mensaje."
      );

      return;
    }

    logAdmin(
      admin,
      "MENSAJE GLOBAL",
      message
    );

    io.emit(
      "notice",
      "📢 " + admin.name + ": " + message
    );

    adminResult(
      socket,
      true,
      "Mensaje enviado a todos."
    );
  });

  /* VUELO DEL CREADOR */

  socket.on("admin:toggleFly", data => {
    const admin = getCreator(socket);

    if (!admin) return;

    admin.flyEnabled = Boolean(data?.enabled);

    if (!admin.flyEnabled) {
      admin.y = 0;
    }

    socket.emit(
      "admin:flyStatus",
      { enabled: admin.flyEnabled }
    );

    socket.emit(
      "notice",
      admin.flyEnabled
        ? "Vuelo activado."
        : "Vuelo desactivado."
    );

    broadcastState();
    broadcastAdminPlayers();
  });

  /* ===================================================
     MOVIMIENTO
     =================================================== */

  socket.on("move", data => {
    const p = players.get(socket.id);

    if (!p || !p.alive || !data || typeof data !== "object") {
      return;
    }

    const x = Number(data.x);
    const y = Number(data.y);
    const z = Number(data.z);
    const yaw = Number(data.yaw);

    if (![x, y, z, yaw].every(Number.isFinite)) {
      return;
    }

    const now = Date.now();

    const elapsed = Math.max(
      0.05,
      Math.min(0.5, (now - p.lastMoveAt) / 1000)
    );

    const distance = Math.hypot(
      x - p.x,
      z - p.z
    );

    const maxDistance =
      MAX_MOVE_SPEED * elapsed + 0.9;

    if (
      distance > maxDistance ||
      pathBlocked(p.x, p.z, x, z)
    ) {
      socket.emit(
        "moveCorrection",
        publicPlayer(p)
      );

      p.lastMoveAt = now;
      return;
    }

    p.x = x;
    p.z = z;

    p.yaw = Math.atan2(
      Math.sin(yaw),
      Math.cos(yaw)
    );

    if (p.isCreator && p.flyEnabled) {
      p.y = Math.max(0, Math.min(30, y));
    } else {
      p.y = Math.max(0, Math.min(2, y));
    }

    p.lastMoveAt = now;
  });

  /* ===================================================
     CAMBIO DE ARMAS
     =================================================== */

  socket.on("changeWeapon", data => {
    const p = players.get(socket.id);

    if (!p || !p.alive) return;

    const weapon = String(data?.weapon || "");

    if (!WEAPONS[weapon]) return;

    if (weapon === "creator" && !p.isCreator) {
      return;
    }

    p.weapon = weapon;
    p.ammo = WEAPONS[weapon].ammo;

    socket.emit("shotResult", {
      ok: true,
      ammo: p.ammo,
      weapon: p.weapon
    });

    socket.emit(
      "notice",
      "Arma equipada: " + WEAPONS[weapon].name
    );

    broadcastState();
    broadcastAdminPlayers();
  });

  /* ===================================================
     DISPAROS
     =================================================== */

  socket.on("shoot", data => {
    const p = players.get(socket.id);

    if (!p || !p.alive || !data || typeof data !== "object") {
      return;
    }

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

    const yaw = Number(data.yaw);
    const pitch = Number(data.pitch);

    if (
      !Number.isFinite(yaw) ||
      !Number.isFinite(pitch)
    ) {
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

    if (!shot.target) {
      broadcastState();
      return;
    }

    const target = shot.target;

    // El creador sigue siendo invulnerable.
    if (target.isCreator) {
      socket.emit("hitConfirm", {
        targetId: target.id,
        damage: 0,
        health: MAX_HEALTH
      });

      broadcastState();
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
      broadcastAdminPlayers();
    }
  });

  /* RECARGAR */

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

  /* ===================================================
     BOTIQUINES
     =================================================== */

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
    broadcastAdminPlayers();

    setTimeout(spawnMedkit, 8000);
  });

  /* ===================================================
     REAPARICIÓN
     =================================================== */

  socket.on("respawn", () => {
    const p = players.get(socket.id);

    if (p && !p.alive) {
      respawnPlayer(p);
    }
  });

  /* ===================================================
     DESCONEXIÓN
     =================================================== */

  socket.on("disconnect", () => {
    const p = players.get(socket.id);

    players.delete(socket.id);

    if (p) {
      io.emit(
        "notice",
        p.name + " ha salido de la arena."
      );

      broadcastState();
      broadcastAdminPlayers();
    }
  });
});

/* =====================================================
   INICIO DEL SERVIDOR
   ===================================================== */

fillMedkits();

setInterval(() => {
  fillMedkits();
  broadcastState();
  broadcastAdminPlayers();
}, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    "LEGENDS OF ABDE escuchando en el puerto " + PORT
  );

  if (!CREATOR_KEY) {
    console.warn(
      "AVISO: configura CREATOR_KEY en las variables de entorno de Render."
    );
  }
});

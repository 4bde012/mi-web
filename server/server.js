
"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

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

const WEAPONS = {
  pulse: { name: "PULSE RIFLE", ammo: 30, rate: 220, damage: 25, color: "#00dfff" },
  plasma: { name: "PLASMA DESTROYER", ammo: 12, rate: 500, damage: 50, color: "#b45cff" },
  rapid: { name: "NEON RAPID SMG", ammo: 50, rate: 100, damage: 10, color: "#ff4545" }
};

const SKINS = ["cyber", "shadow", "inferno", "gold"];
const players = new Map();
const medkits = new Map();

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
    health: p.health,
    maxHealth: MAX_HEALTH,
    ammo: p.ammo,
    kills: p.kills,
    deaths: p.deaths,
    alive: p.alive
  };
}

function broadcastState() {
  io.emit("state", Array.from(players.values(), publicPlayer));
}

function broadcastMedkits() {
  io.emit("medkits", Array.from(medkits.values()));
}

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
  p.ammo = WEAPONS[p.weapon].ammo;
  p.lastShot = 0;

  io.to(p.id).emit("respawned", publicPlayer(p));
  broadcastState();
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

  let best = null;
  let bestDistance = 60;

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
    direction: { x: dx, y: dy, z: dz },
    distance: best ? bestDistance : 60
  };
}

io.on("connection", socket => {
  socket.on("joinGame", data => {
    if (players.size >= MAX_PLAYERS && !players.has(socket.id)) {
      socket.emit("notice", "La arena está llena.");
      socket.disconnect(true);
      return;
    }

    data = data && typeof data === "object" ? data : {};

    const weapon = WEAPONS[data.weapon] ? data.weapon : "pulse";
    const skin = SKINS.includes(data.skin) ? data.skin : "cyber";
    const pos = randomPosition();

    const p = {
      id: socket.id,
      name: String(data.name || "Jugador").trim().slice(0, 16) || "Jugador",
      skin,
      weapon,
      rank: "JUGADOR",
      x: pos.x,
      y: 0,
      z: pos.z,
      yaw: 0,
      health: MAX_HEALTH,
      ammo: WEAPONS[weapon].ammo,
      kills: 0,
      deaths: 0,
      alive: true,
      lastShot: 0,
      reloadUntil: 0
    };

    players.set(socket.id, p);

    socket.emit("joined", { you: publicPlayer(p) });
    socket.emit("medkits", Array.from(medkits.values()));

    broadcastState();
    socket.broadcast.emit("notice", p.name + " ha entrado en la arena.");
  });

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive || !data) return;

    const x = Number(data.x);
    const y = Number(data.y);
    const z = Number(data.z);
    const yaw = Number(data.yaw);

    if (![x, y, z, yaw].every(Number.isFinite)) return;

    // Limitar posiciones para evitar valores fuera de la arena.
    p.x = Math.max(-77, Math.min(77, x));
    p.y = Math.max(0, Math.min(30, y));
    p.z = Math.max(-77, Math.min(77, z));
    p.yaw = yaw;
  });

  socket.on("shoot", data => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;

    const weaponId = WEAPONS[p.weapon] ? p.weapon : "pulse";
    const weapon = WEAPONS[weaponId];
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

    p.lastShot = now;
    p.ammo--;

    const yaw = Number(data?.yaw);
    const pitch = Number(data?.pitch);

    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      socket.emit("shotResult", { ok: false, ammo: p.ammo });
      return;
    }

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
        target.alive = false;
        target.deaths++;
        p.kills++;

        io.emit("elimination", {
          attacker: p.id,
          victim: target.id,
          attackerKills: p.kills,
          victimDeaths: target.deaths
        });

        io.emit("notice", p.name + " ha eliminado a " + target.name + ".");

        setTimeout(() => {
          const current = players.get(target.id);
          if (current && !current.alive) respawnPlayer(current);
        }, 3000);
      }

      broadcastState();
    }
  });

  socket.on("reload", () => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;

    p.ammo = WEAPONS[p.weapon].ammo;
    socket.emit("shotResult", { ok: true, ammo: p.ammo });
    socket.emit("notice", "Arma recargada.");
    broadcastState();
  });

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
    }
  });
});

fillMedkits();

setInterval(() => {
  fillMedkits();
  broadcastState();
}, 500);

server.listen(PORT, "0.0.0.0", () => {
  console.log("LEGENDS OF ABDE escuchando en el puerto " + PORT);
});

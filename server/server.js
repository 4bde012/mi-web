
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
  pulse: {
    ammo: 30,
    damage: 25,
    rate: 220,
    color: 0x00dfff
  },
  plasma: {
    ammo: 12,
    damage: 50,
    rate: 500,
    color: 0xb45cff
  },
  rapid: {
    ammo: 50,
    damage: 10,
    rate: 100,
    color: 0xff4545
  }
};

const players = new Map();
const lastShots = new Map();
const medkits = new Map();
let medkitCounter = 0;

function spawnMedkit() {
  const id = "medkit_" + (++medkitCounter);

  medkits.set(id, {
    id,
    x: Math.random() * 120 - 60,
    y: 0.7,
    z: Math.random() * 120 - 60
  });

  io.emit("medkits", Array.from(medkits.values()));
}

for (let i = 0; i < 5; i++) {
  spawnMedkit();
}

setInterval(() => {
  if (medkits.size < 5) spawnMedkit();
}, 8000);

app.use(express.json());

app.get("/", (req, res) => {
  res.send("LEGENDS OF ABDE - Servidor activo");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    game: "LEGENDS OF ABDE",
    players: players.size,
    maxPlayers: MAX_PLAYERS
  });
});

function clamp(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n)
    ? Math.max(min, Math.min(max, n))
    : min;
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    rotation: p.yaw,
    health: p.health,
    maxHealth: p.maxHealth,
    weapon: p.weapon,
    ammo: p.ammo,
    skin: p.skin,
    alive: p.alive,
    creator: p.creator,
    rank: p.creator ? "CREADOR" : "JUGADOR",
    kills: p.kills,
    deaths: p.deaths
  };
}

function broadcastState() {
  io.emit(
    "state",
    Array.from(players.values()).map(publicPlayer)
  );
}

function noticePlayer(id, message) {
  io.to(id).emit("notice", message);
}

function respawnPlayer(p) {
  p.x = Math.random() * 20 - 10;
  p.y = 0;
  p.z = Math.random() * 20 - 10;
  p.health = p.maxHealth;
  p.ammo = WEAPONS[p.weapon].ammo;
  p.alive = true;
  p.yaw = 0;

  io.to(p.id).emit("respawned", publicPlayer(p));
}

/*
 * Comprueba si un rayo alcanza a un jugador.
 * El servidor calcula el impacto para que no dependa
 * de que el cliente indique un objetivo.
 */
function findHitPlayer(shooter, direction, maxDistance = 60) {
  let closestPlayer = null;
  let closestDistance = maxDistance;

  for (const target of players.values()) {
    if (target.id === shooter.id || !target.alive) {
      continue;
    }

    // Centro aproximado del cuerpo del jugador.
    const center = {
      x: target.x,
      y: target.y + 1.1,
      z: target.z
    };

    const ox = center.x - shooter.x;
    const oy = center.y - (shooter.y + 1.7);
    const oz = center.z - shooter.z;

    // Distancia proyectada sobre la dirección del disparo.
    const projection =
      ox * direction.x +
      oy * direction.y +
      oz * direction.z;

    if (projection < 0 || projection > closestDistance) {
      continue;
    }

    // Distancia entre el centro del cuerpo y el rayo.
    const cx = ox - direction.x * projection;
    const cy = oy - direction.y * projection;
    const cz = oz - direction.z * projection;

    const distanceSquared = cx * cx + cy * cy + cz * cz;

    // Radio aproximado de impacto del avatar.
    if (distanceSquared <= 0.85 * 0.85) {
      closestPlayer = target;
      closestDistance = projection;
    }
  }

  return closestPlayer;
}

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  socket.on("joinGame", (data = {}) => {
    if (players.has(socket.id)) {
      socket.emit("joined", {
        you: publicPlayer(players.get(socket.id))
      });
      return;
    }

    if (players.size >= MAX_PLAYERS) {
      socket.emit("notice", "El servidor está lleno.");
      return;
    }

    const name =
      String(data.name || "Jugador").trim().slice(0, 20)
      || "Jugador";

    const requestedWeapon = String(data.weapon || "pulse");
    const weapon = Object.hasOwn(WEAPONS, requestedWeapon)
      ? requestedWeapon
      : "pulse";

    const requestedSkin = String(data.skin || "cyber");
    const skin = SKINS.includes(requestedSkin)
      ? requestedSkin
      : "cyber";

    const creator =
      CREATOR_KEY.length > 0 &&
      String(data.creatorKey || "") === CREATOR_KEY;

    const p = {
      id: socket.id,
      name,
      x: Math.random() * 20 - 10,
      y: 0,
      z: Math.random() * 20 - 10,
      yaw: 0,
      health: 100,
      maxHealth: 100,
      weapon,
      ammo: WEAPONS[weapon].ammo,
      skin,
      alive: true,
      creator,
      kills: 0,
      deaths: 0
    };

    players.set(socket.id, p);

    socket.emit("joined", {
      you: publicPlayer(p)
    });

    socket.emit("creatorVerified", {
      ok: creator
    });

    socket.emit("notice", "¡Bienvenido a LEGENDS OF ABDE!");

    broadcastState();
  });

  socket.on("move", (data = {}) => {
    const p = players.get(socket.id);

    if (!p || !p.alive) return;

    p.x = clamp(data.x, -77, 77);
    p.y = clamp(data.y, 0, 20);
    p.z = clamp(data.z, -77, 77);

    // El cliente envía yaw, no rotation.
    p.yaw = clamp(data.yaw ?? data.rotation, -100000, 100000);

    broadcastState();
  });

  socket.on("shoot", (data = {}) => {
    const p = players.get(socket.id);

    if (!p || !p.alive) return;

    const weapon = WEAPONS[p.weapon];

    if (!weapon) return;

    const now = Date.now();
    const previousShot = lastShots.get(socket.id) || 0;

    if (now - previousShot < weapon.rate) return;

    if (p.ammo <= 0) {
      socket.emit("shotResult", {
        ok: false,
        ammo: 0,
        hit: false
      });

      noticePlayer(socket.id, "¡No tienes munición! Pulsa R.");
      return;
    }

    lastShots.set(socket.id, now);
    p.ammo -= 1;

    // Validar la dirección recibida.
    const yaw = clamp(data.yaw, -100000, 100000);
    const pitch = clamp(data.pitch, -1.4, 1.4);

    // Dirección compatible con la cámara de Three.js.
    const direction = {
      x: -Math.sin(yaw) * Math.cos(pitch),
      y: Math.sin(pitch),
      z: -Math.cos(yaw) * Math.cos(pitch)
    };

    const hitPlayer = findHitPlayer(p, direction, 60);

    socket.emit("shotResult", {
      ok: true,
      hit: Boolean(hitPlayer),
      ammo: p.ammo,
      weapon: p.weapon
    });

    // Efecto visual del disparo para los jugadores conectados.
    io.emit("shotEffect", {
      shooterId: p.id,
      x: p.x,
      y: p.y + 1.7,
      z: p.z,
      dx: direction.x,
      dy: direction.y,
      dz: direction.z,
      distance: 60,
      color: weapon.color
    });

    if (hitPlayer) {
      hitPlayer.health = Math.max(
        0,
        hitPlayer.health - weapon.damage
      );

      // Confirmar el daño al atacante.
      socket.emit("hitConfirm", {
        targetId: hitPlayer.id,
        targetName: hitPlayer.name,
        damage: weapon.damage,
        health: hitPlayer.health
      });

      // Avisar al jugador alcanzado.
      io.to(hitPlayer.id).emit("playerHit", {
        id: hitPlayer.id,
        targetId: hitPlayer.id,
        shooterId: p.id,
        damage: weapon.damage,
        health: hitPlayer.health
      });

      console.log(
        `${p.name} ha causado ${weapon.damage} de daño a ${hitPlayer.name}`
      );

      if (hitPlayer.health <= 0) {
        hitPlayer.alive = false;
        p.kills += 1;
        hitPlayer.deaths += 1;

        io.emit("elimination", {
          attacker: p.id,
          attackerKills: p.kills,
          victim: hitPlayer.id,
          killerId: p.id,
          victimId: hitPlayer.id,
          killerName: p.name,
          victimName: hitPlayer.name
        });

        setTimeout(() => {
          const current = players.get(hitPlayer.id);

          if (current && !current.alive) {
            respawnPlayer(current);
            broadcastState();
          }
        }, 3000);
      }
    }

    broadcastState();
  });

  socket.on("reload", () => {
    const p = players.get(socket.id);

    if (!p || !p.alive) return;

    const weapon = WEAPONS[p.weapon];

    if (!weapon) return;

    p.ammo = weapon.ammo;

    socket.emit("shotResult", {
      ok: true,
      ammo: p.ammo,
      hit: false
    });

    noticePlayer(socket.id, "¡Arma recargada!");

    broadcastState();
  });

  socket.on("respawn", () => {
    const p = players.get(socket.id);

    if (!p) return;

    respawnPlayer(p);
    broadcastState();
  });

  socket.on("disconnect", () => {
    console.log("Jugador desconectado:", socket.id);

    players.delete(socket.id);
    lastShots.delete(socket.id);

    broadcastState();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LEGENDS OF ABDE activo en el puerto ${PORT}`);
});

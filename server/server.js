
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
    rate: 220
  },
  plasma: {
    ammo: 12,
    damage: 50,
    rate: 500
  },
  rapid: {
    ammo: 50,
    damage: 10,
    rate: 100
  }
};

const players = new Map();
const lastShots = new Map();

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
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.max(min, Math.min(max, number));
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    z: p.z,
    rotation: p.rotation,
    health: p.health,
    maxHealth: p.maxHealth,
    weapon: p.weapon,
    ammo: p.ammo,
    skin: p.skin,
    alive: p.alive,
    creator: p.creator,
    kills: p.kills
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
  p.y = 1;
  p.z = Math.random() * 20 - 10;
  p.health = p.maxHealth;
  p.alive = true;

  io.to(p.id).emit("respawned", publicPlayer(p));
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
      String(data.name || "Jugador")
        .trim()
        .slice(0, 20) || "Jugador";

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

    const weaponInfo = WEAPONS[weapon];

    const p = {
      id: socket.id,
      name,
      x: Math.random() * 20 - 10,
      y: 1,
      z: Math.random() * 20 - 10,
      rotation: 0,
      health: 100,
      maxHealth: 100,
      weapon,
      ammo: weaponInfo.ammo,
      skin,
      alive: true,
      creator,
      kills: 0
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

    if (!p || !p.alive) {
      return;
    }

    p.x = clamp(data.x, -1000, 1000);
    p.y = clamp(data.y, -100, 1000);
    p.z = clamp(data.z, -1000, 1000);
    p.rotation = clamp(data.rotation, -100000, 100000);

    // Actualiza la posición de los demás jugadores.
    broadcastState();
  });

  socket.on("shoot", (data = {}) => {
    const p = players.get(socket.id);

    if (!p || !p.alive) {
      return;
    }

    const weapon = WEAPONS[p.weapon];

    if (!weapon) {
      return;
    }

    const now = Date.now();
    const lastShot = lastShots.get(socket.id) || 0;

    if (now - lastShot < weapon.rate) {
      return;
    }

    lastShots.set(socket.id, now);

    if (p.ammo <= 0) {
      noticePlayer(socket.id, "¡No tienes munición! Recarga.");
      return;
    }

    p.ammo -= 1;

    const angle = Number(data.angle);
    const targetId = String(data.targetId || "");

    let hitPlayer = null;

    // Si el cliente indica un objetivo válido,
    // comprobamos que esté delante y cerca de la línea de tiro.
    if (Number.isFinite(angle) && targetId) {
      const target = players.get(targetId);

      if (
        target &&
        target.id !== p.id &&
        target.alive
      ) {
        const dx = target.x - p.x;
        const dz = target.z - p.z;
        const distance = Math.sqrt(dx * dx + dz * dz);

        const targetAngle = Math.atan2(dx, dz);
        const difference = Math.atan2(
          Math.sin(targetAngle - angle),
          Math.cos(targetAngle - angle)
        );

        if (distance <= 100 && Math.abs(difference) < 0.25) {
          hitPlayer = target;
        }
      }
    }

    socket.emit("shotResult", {
      hit: Boolean(hitPlayer),
      ammo: p.ammo,
      weapon: p.weapon
    });

    io.emit("shotEffect", {
      shooterId: p.id,
      x: p.x,
      y: p.y,
      z: p.z,
      angle: Number.isFinite(angle) ? angle : p.rotation,
      weapon: p.weapon
    });

    if (hitPlayer) {
      hitPlayer.health = Math.max(
        0,
        hitPlayer.health - weapon.damage
      );

      io.emit("playerHit", {
        shooterId: p.id,
        targetId: hitPlayer.id,
        damage: weapon.damage,
        health: hitPlayer.health
      });

      if (hitPlayer.health <= 0) {
        hitPlayer.alive = false;
        p.kills += 1;

        io.emit("elimination", {
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

    if (!p || !p.alive) {
      return;
    }

    const weapon = WEAPONS[p.weapon];

    if (!weapon) {
      return;
    }

    p.ammo = weapon.ammo;

    socket.emit("notice", "¡Arma recargada!");

    broadcastState();
  });

  socket.on("respawn", () => {
    const p = players.get(socket.id);

    if (!p) {
      return;
    }

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


const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"]
});

const players = new Map();
const grenadeTimers = new Map();

const COLORS = [0x4dbbff, 0x9b75ff, 0x43e0b0, 0xffbd55];
let colorIndex = 0;
let nextGrenadeId = 1;

app.get("/", (req, res) => {
  res.send("ABDE STRIKE server is running.");
});

io.on("connection", socket => {
  console.log("Conectado:", socket.id);

  socket.on("joinGame", data => {
    const name = String(data?.name || "Jugador")
      .replace(/[<>]/g, "")
      .slice(0, 16);

    players.set(socket.id, {
      name,
      x: (Math.random() - 0.5) * 8,
      y: 0,
      z: (Math.random() - 0.5) * 8,
      yaw: 0,
      color: COLORS[colorIndex++ % COLORS.length],
      lastPulse: 0,
      lastGrenade: 0
    });

    broadcastState();
  });

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !data) return;

    p.x = clamp(Number(data.x) || 0, -20.5, 20.5);
    p.y = clamp(Number(data.y) || 0, 0, 12);
    p.z = clamp(Number(data.z) || 0, -20.5, 20.5);
    p.yaw = clamp(Number(data.yaw) || 0, -1000, 1000);

    broadcastState();
  });

  socket.on("firePulse", data => {
    const p = players.get(socket.id);
    if (!p || !data) return;

    const now = Date.now();
    if (now - p.lastPulse < 280) return;
    p.lastPulse = now;

    let dx = Number(data.dx) || 0;
    let dy = Number(data.dy) || 0;
    let dz = Number(data.dz) || -1;
    const length = Math.hypot(dx, dy, dz) || 1;

    dx /= length;
    dy /= length;
    dz /= length;

    const origin = {
      x: clamp(Number(data.x) || p.x, -25, 25),
      y: clamp(Number(data.y) || 1.7, 0, 15),
      z: clamp(Number(data.z) || p.z, -25, 25)
    };

    io.emit("pulse", {
      ...origin, dx, dy, dz, owner: socket.id
    });

    // Comprobación básica de impactos en el servidor.
    let closest = null;
    let closestDistance = Infinity;

    for (const [id, target] of players.entries()) {
      if (id === socket.id) continue;

      const tx = target.x - origin.x;
      const ty = target.y + 1.2 - origin.y;
      const tz = target.z - origin.z;

      const along = tx * dx + ty * dy + tz * dz;
      if (along < 0 || along > 22) continue;

      const nearX = tx - dx * along;
      const nearY = ty - dy * along;
      const nearZ = tz - dz * along;
      const distance = Math.hypot(nearX, nearY, nearZ);

      if (distance < 1.25 && along < closestDistance) {
        closest = id;
        closestDistance = along;
      }
    }

    if (closest) {
      io.emit("tag", {
        scorer: socket.id,
        target: closest
      });
    }
  });

  socket.on("throwGrenade", data => {
    const p = players.get(socket.id);
    if (!p || !data) return;

    const now = Date.now();
    if (now - p.lastGrenade < 700) return;
    p.lastGrenade = now;

    const x = clamp(Number(data.x) || p.x, -25, 25);
    const y = clamp(Number(data.y) || 1.7, 0, 15);
    const z = clamp(Number(data.z) || p.z, -25, 25);

    const vx = clamp(Number(data.vx) || 0, -15, 15);
    const vy = clamp(Number(data.vy) || 5, -15, 15);
    const vz = clamp(Number(data.vz) || -8, -15, 15);

    const id = nextGrenadeId++;

    io.emit("grenadeThrown", {
      id, owner: socket.id, x, y, z, vx, vy, vz
    });

    // El servidor controla el momento de la explosión.
    const timer = setTimeout(() => {
      grenadeTimers.delete(id);

      // Estimación de la posición al explotar.
      const t = 2;
      const end = {
        x: clamp(x + vx * t, -22, 22),
        y: Math.max(0.18, Math.min(8, y + vy * t - 4.9 * t * t)),
        z: clamp(z + vz * t, -22, 22)
      };

      let points = 0;

      // Daño simplificado por proximidad.
      for (const [playerId, target] of players.entries()) {
        if (playerId === socket.id) continue;

        const distance = Math.hypot(
          target.x - end.x,
          (target.y + 1) - end.y,
          target.z - end.z
        );

        if (distance <= 4) points++;
      }

      io.emit("grenadeExplode", {
        id,
        scorer: socket.id,
        x: end.x,
        y: end.y,
        z: end.z,
        points
      });
    }, 2000);

    grenadeTimers.set(id, timer);
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    console.log("Desconectado:", socket.id);
    broadcastState();
  });
});

function broadcastState() {
  const state = {};

  for (const [id, p] of players.entries()) {
    state[id] = {
      name: p.name,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      color: p.color
    };
  }

  io.emit("state", state);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("ABDE STRIKE escuchando en el puerto", PORT);
});

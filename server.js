
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const players = new Map();

app.get("/", (req, res) => {
  res.status(200).send("LEGENDS OF ABDE server is running!");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    players: players.size
  });
});

function createPlayer(id) {
  return {
    id,
    x: 0,
    y: 0,
    z: 0,
    rotation: 0,
    health: 100,
    weapon: "pistol",
    connected: true
  };
}

function sendState() {
  io.emit("state", Array.from(players.values()));
}

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  socket.on("joinGame", (data = {}) => {
    const player = createPlayer(socket.id);

    if (data && typeof data === "object") {
      if (typeof data.name === "string") {
        player.name = data.name.slice(0, 20);
      }

      if (typeof data.x === "number") player.x = data.x;
      if (typeof data.y === "number") player.y = data.y;
      if (typeof data.z === "number") player.z = data.z;
    }

    players.set(socket.id, player);

    socket.emit("joined", {
      id: socket.id,
      player
    });

    sendState();

    console.log("Jugador dentro de la partida:", socket.id);
  });

  socket.on("move", (data = {}) => {
    const player = players.get(socket.id);
    if (!player || !data || typeof data !== "object") return;

    for (const key of ["x", "y", "z", "rotation"]) {
      if (
        typeof data[key] === "number" &&
        Number.isFinite(data[key])
      ) {
        player[key] = data[key];
      }
    }

    if (typeof data.health === "number") {
      player.health = Math.max(0, Math.min(100, data.health));
    }

    if (typeof data.weapon === "string") {
      player.weapon = data.weapon.slice(0, 20);
    }

   sendState();
      id: socket.id,
      ...player
    });
  });

  socket.on("attack", (data = {}) => {
    const player = players.get(socket.id);
    if (!player) return;

    // Relay the attack to the other connected players.
    // Damage is not applied automatically because the client
    // must identify which player was actually hit.
    socket.broadcast.emit("attack", {
      id: socket.id,
      playerId: socket.id,
      weapon: player.weapon,
      ...(data && typeof data === "object" ? data : {})
    });

    // If the client supplies a targetId, notify that target.
    const targetId =
      data && typeof data.targetId === "string"
        ? data.targetId
        : null;

    if (targetId && targetId !== socket.id && players.has(targetId)) {
      io.to(targetId).emit("hit", {
        attackerId: socket.id,
        targetId,
        weapon: player.weapon
      });
    }
  });

  socket.on("disconnect", (reason) => {
    players.delete(socket.id);
    console.log("Jugador desconectado:", socket.id, reason);
    sendState();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LEGENDS OF ABDE escuchando en el puerto ${PORT}`);
});

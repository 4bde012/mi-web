const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 40;
const CREATOR_KEY = process.env.CREATOR_KEY || "";

const players = new Map();
const lastShots = new Map();

const WEAPONS = {
  pulse:   { ammo: 30, damage: 20, rate: 220 },
  plasma:  { ammo: 12, damage: 35, rate: 500 },
  rapid:   { ammo: 50, damage: 10, rate: 100 },
  creator: { ammo: 20, damage: 50, rate: 300 }
};

const SKINS = ["cyber", "shadow", "inferno", "gold"];

app.get("/", (req, res) => {
  res.json({
    game: "LEGENDS OF ABDE",
    status: "online",
    players: players.size,
    maxPlayers: MAX_PLAYERS
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", players: players.size, maxPlayers: MAX_PLAYERS });
});

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-79, Math.min(79, n)) : fallback;
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    rank: p.rank,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    health: p.health,
    kills: p.kills,
    deaths: p.deaths,
    skin: p.skin,
    weapon: p.weapon,
    ammo: p.ammo
  };
}

function broadcastState() {
  io.emit("state", { players: [...players.values()].map(publicPlayer) });
}

io.on("connection", socket => {
  if (players.size >= MAX_PLAYERS) {
    socket.emit("notice", "Servidor lleno. Prueba más tarde.");
    socket.disconnect(true);
    return;
  }

  socket.emit("connected", { id: socket.id, maxPlayers: MAX_PLAYERS });

  socket.on("joinGame", data => {
    if (players.has(socket.id)) return;
    data = data && typeof data === "object" ? data : {};

    const name = String(data.name || "Jugador")
      .replace(/[<>]/g, "").trim().slice(0, 16) || "Jugador";

    const suppliedKey = String(data.creatorKey || "");
    const creatorExists = [...players.values()].some(p => p.rank === "CREADOR");
    const isCreator = Boolean(
      CREATOR_KEY &&
      suppliedKey.length === CREATOR_KEY.length &&
      suppliedKey === CREATOR_KEY &&
      !creatorExists
    );

    const skin = isCreator ? "creator" :
      (SKINS.includes(data.skin) ? data.skin : "cyber");
    const weapon = isCreator ? "creator" :
      (["pulse", "plasma", "rapid"].includes(data.weapon) ? data.weapon : "pulse");

    const p = {
      id: socket.id,
      name: isCreator ? "ABDE" : name,
      rank: isCreator ? "CREADOR" : "JUGADOR",
      x: Math.random() * 12 - 6,
      y: 0,
      z: Math.random() * 12 - 6,
      yaw: 0,
      health: 100,
      kills: 0,
      deaths: 0,
      skin,
      weapon,
      ammo: WEAPONS[weapon].ammo,
      respawnAt: 0
    };

    players.set(socket.id, p);

    socket.emit("joined", { you: publicPlayer(p) });
    socket.emit("creatorVerified", { ok: isCreator });
    socket.emit("playerCount", players.size);
    io.emit("playerJoined", publicPlayer(p));
    broadcastState();
  });

  socket.on("move", data => {
    const p = players.get(socket.id);
    if (!p || !data || typeof data !== "object" || p.health <= 0) return;

    p.x = num(data.x, p.x);
    p.y = Math.max(0, Math.min(8, Number(data.y) || 0));
    p.z = num(data.z, p.z);
    p.yaw = Number.isFinite(Number(data.yaw)) ? Number(data.yaw) : p.yaw;

    // Solo el servidor conserva la skin y el arma autorizadas.
    broadcastState();
  });

  socket.on("shoot", data => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0 || !data) return;

    const weapon = WEAPONS[p.weapon];
    if (!weapon || p.ammo <= 0) {
      socket.emit("shotResult", { ammo: p.ammo, ok: false });
      return;
    }

    const now = Date.now();
    if (now - (lastShots.get(socket.id) || 0) < weapon.rate) return;
    lastShots.set(socket.id, now);
    p.ammo--;

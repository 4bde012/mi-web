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
  res.send("LEGENDS OF ABDE - Servidor funcionando");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", players: players.size });
});

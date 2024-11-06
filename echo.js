const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());
//app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true })); // Parse URL-encoded body
app.use(express.static(path.join(__dirname))); // Serve files in the current directory

const server = http.createServer(app);
const io = new Server(server, {
  path: "/connect",
  transports: ["websocket"],
});

const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "echo_db",
});

const connectedClients = {};

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error("Authentication error"));
  }

  try {
    const validToken = await verifyToken(token);
    if (validToken) {
      socket.token = token;
      connectedClients[socket.id] = socket;
      return next();
    } else {
      return next(new Error("Invalid token"));
    }
  } catch (error) {
    return next(new Error("Token verification failed"));
  }
});

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("ping", () => {
    socket.emit("pong", 0);
  });

  socket.on("disconnect", () => {
    delete connectedClients[socket.id];
    console.log(`User disconnected: ${socket.id}`);
  });
});

async function verifyToken(token) {
  try {
    const [rows] = await db.promise().query("SELECT * FROM tokens WHERE token = ?", [token]);
    return rows.length > 0;
  } catch (error) {
    console.error("Token verification failed:", error);
    return false;
  }
}

function generateNewToken() {
  return crypto.randomBytes(32).toString("hex"); // Generates a 64-character hex string
}

app.post("/token", (req, res) => {
  const { purchase_code, site_url } = req.body;

  if (!purchase_code || !site_url) {
    return res.status(400).json({ status: 400, message: "Missing purchase_code or site_url" });
  }

  const token = generateNewToken();

  const sql = "INSERT INTO tokens (purchase_code, site_url, token) VALUES (?, ?, ?)";
  db.query(sql, [purchase_code, site_url, token], (err, result) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).json({ status: 500, message: "Database error" });
    }

    return res.status(200).json({ status: 200, data: { token } });
  });
});

app.post("/check", async (req, res) => {
  const { purchase_code, token } = req.body;

  try {
    const [rows] = await db.promise().query("SELECT * FROM tokens WHERE purchase_code = ? AND token = ?", [purchase_code, token]);

    if (rows.length > 0) {
      res.json({ status: 200, message: "Token is valid" });
    } else {
      res.json({ status: 500, message: "Token is invalid" });
    }
  } catch (error) {
    console.error("Error checking token:", error);
    res.status(500).json({ status: 500, message: "Error checking token" });
  }
});

app.post("/delete", async (req, res) => {
  const { purchase_code, token } = req.body;

  try {
    const [result] = await db.promise().query("DELETE FROM tokens WHERE purchase_code = ? AND token = ?", [purchase_code, token]);

    if (result.affectedRows > 0) {
      res.json({ status: 200, message: "Token deleted successfully" });
    } else {
      res.json({ status: 500, message: "Token not found or already deleted" });
    }
  } catch (error) {
    console.error("Error deleting token:", error);
    res.status(500).json({ status: 500, message: "Error deleting token" });
  }
});

server.listen(3000, () => {
  console.log("WebSocket server listening on port 3000");
});

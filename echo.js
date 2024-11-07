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
app.use("/", express.static(path.join(__dirname, "public")));

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
  console.log(`User connected with ID: ${socket.id}`);

  // Listen for the "status" event sent from the client
  socket.on("status", async (onlineId, callback) => {
    console.log(`Received status check for online ID: ${onlineId}`);
    // Check if the socket ID exists in connectedClients
    const isConnected = !!connectedClients[onlineId];
    // Send the connection status back to the client
    callback(isConnected);
  });

  // Broadcast message to all clients when a message is received
  socket.on("notify", (data) => {
    console.log(`Received notify event from ${socket.id}:`, data);
    // Broadcast the data to all connected clients except the sender
    if (data.name && data.content) {
      socket.broadcast.emit(data.name, data.content);
    } else {
      socket.broadcast.emit("notify", data);
    }
  });

  // Example of handling 'ping' and sending 'pong' back to all clients
  socket.on("ping", () => {
    console.log(`Received ping from ${socket.id}`);
    socket.emit("pong", { message: "pong" });
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log(`User disconnected with ID: ${socket.id}`);
    delete connectedClients[socket.id];
    socket.broadcast.emit("offline", socket.id);
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

// Add the /notify endpoint
app.post("/notify", (req, res) => {
  const { token, event_name, event_content, event_volatile, name, content } = req.body;

  if (name && content) {
    io.emit(name, content);
  } else {
    const payload = {
      event_name,
      event_content,
      event_volatile: event_volatile || false,
    };

    io.emit("notify", payload); // Broadcast to all clients
    res.json({ status: 200, message: "Notification sent successfully" });
  }
});

// Add the /status endpoint
app.post("/status", (req, res) => {
  const { token, socket_id } = req.body;

  // Verify token
  verifyToken(token)
    .then((isValid) => {
      if (!isValid) {
        return res.status(403).json({ status: 403, message: "Invalid token" });
      }

      // Check if the client with the given socket_id is connected
      const isConnected = !!connectedClients[socket_id];
      res.json({
        status: 200,
        data: { connected: isConnected },
      });
    })
    .catch((error) => {
      console.error("Error verifying token:", error);
      res.status(500).json({ status: 500, message: "Token verification failed" });
    });
});

server.listen(3000, () => {
  console.log("WebSocket server listening on port 3000");
});

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
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
      socket.join(token); // Join a room with the name of the token
      return next();
    } else {
      return next(new Error("Invalid token"));
    }
  } catch (error) {
    return next(new Error("Token verification failed"));
  }
});

io.on("connection", (socket) => {
  console.log(`User connected with ID: ${socket.id} and joined room: ${socket.token}`);

  socket.on("status", async (onlineId, callback) => {
    const isConnected = !!connectedClients[onlineId];
    callback(isConnected);
  });

  socket.on("notify", (data) => {
    console.log(`Received notify event from ${socket.id}:`, data);

    if (data.name && data.content) {
      socket.to(socket.token).emit(data.name, data.content); // Emit only to clients in the same token room
    } else {
      const isVolatile = data.event_volatile === true || data.event_volatile === "1" || data.event_volatile === 1;
      if (data.event_name && data.event_content) {
        if (isVolatile) {
          socket.to(socket.token).volatile.emit(data.event_name, data.event_content); // Volatile emit
        } else {
          socket.to(socket.token).emit(data.event_name, data.event_content); // Non-volatile emit
        }
      } else {
        socket.to(socket.token).emit("notify", data); // Emit only to clients in the same token room
      }
    }
  });

  socket.on("ping", () => {
    console.log(`Received ping from ${socket.id}`);
    socket.emit("pong", { message: "pong" });
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected with ID: ${socket.id}`);
    delete connectedClients[socket.id];
    socket.to(socket.token).emit("offline", socket.id);
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
  return crypto.randomBytes(32).toString("hex");
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

app.post("/notify", (req, res) => {
  const { token, event_name, event_content, event_volatile, name, content } = req.body;

  verifyToken(token)
    .then((isValid) => {
      if (!isValid) {
        return res.status(403).json({ status: 403, message: "Invalid token" });
      }

      // Emit based on provided event information
      if (name && content) {
        // Send to clients in the same token room, using `name` as the event name
        io.to(token).emit(name, content);
      } else {
        // Convert `event_volatile` to a boolean for easier checking
        const isVolatile = event_volatile === true || event_volatile === "1" || event_volatile === 1;
        if (event_name && event_content) {
          if (isVolatile) {
            io.to(token).volatile.emit(event_name, event_content); // Volatile emit
          } else {
            io.to(token).emit(event_name, event_content); // Non-volatile emit
          }
        } else {
          io.to(token).emit("notify", {
            event_name,
            event_content,
            event_volatile: isVolatile,
          });
        }
      }

      res.json({ status: 200, message: "Notification sent successfully" });
    })
    .catch((error) => {
      console.error("Error verifying token:", error);
      res.status(500).json({ status: 500, message: "Token verification failed" });
    });
});

app.post("/status", (req, res) => {
  const { token, socket_id } = req.body;

  verifyToken(token)
    .then((isValid) => {
      if (!isValid) {
        return res.status(403).json({ status: 403, message: "Invalid token" });
      }

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

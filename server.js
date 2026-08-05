// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Serves the admin portal at / and the parent app at /index.html
app.use(express.static(__dirname));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/students", require("./routes/students"));
app.use("/api/scores", require("./routes/scores"));
app.use("/api/attendance", require("./routes/attendance"));
app.use("/api/notices", require("./routes/notices"));
app.use("/api/messages", require("./routes/messages"));
app.use("/api/almanac", require("./routes/almanac"));
app.use("/api/syllabus", require("./routes/syllabus"));
app.use("/api/submissions", require("./routes/submissions"));

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server" });
});

app.listen(PORT, () => {
  console.log(`Argus backend running on http://localhost:${PORT}`);
  console.log(`Admin portal:  http://localhost:${PORT}/admin.html`);
});

const express = require("express");
const fileUpload = require("express-fileupload");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 8080;

const BASE_DIR = __dirname;
const SERVICE_JSON = path.join(BASE_DIR, "storage/service_account.json");
const SHEET_ID_FILE = path.join(BASE_DIR, "storage/sheet_id.txt");

// Middleware
app.use(express.static(path.join(BASE_DIR, "static")));
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

// ----------------------
// Upload service_account.json
// ----------------------
app.post("/upload-json", (req, res) => {
    if (!req.files || !req.files.file) return res.status(400).send("No file uploaded");
    const file = req.files.file;
    file.mv(SERVICE_JSON, (err) => {
        if (err) return res.status(500).send(err);
        res.json({ status: "ok" });
    });
});

// ----------------------
// Save Sheet ID
// ----------------------
app.post("/save-sheet-id", (req, res) => {
    const sheet_id = req.body.sheet_id;
    if (!sheet_id) return res.status(400).send("Missing Sheet ID");

    // Ensure storage directory exists
    const storageDir = path.join(BASE_DIR, "storage");
    if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir);
    }

    // Write Sheet ID
    fs.writeFileSync(SHEET_ID_FILE, sheet_id);
    res.json({ status: "ok" });
});

// ----------------------
// Serve index.html
// ----------------------
app.get("/", (req, res) => {
    res.sendFile(path.join(BASE_DIR, "static/index.html"));
});

// ----------------------
// Run scraper command
// ----------------------
function runScript(scriptPath, args = [], wsClients = []) {
    const proc = spawn("node", [scriptPath, ...args]);
    proc.stdout.on("data", (data) => {
        wsClients.forEach(ws => ws.send(data.toString()));
    });
    proc.stderr.on("data", (data) => {
        wsClients.forEach(ws => ws.send(data.toString()));
    });
    proc.on("close", (code) => {
        wsClients.forEach(ws => ws.send(`Process exited with code ${code}\n`));
    });
}

// ----------------------
// API Endpoints to run scrapers
// ----------------------
let wsClients = [];

app.post("/run-facebook-scraper", (req, res) => {
    const sheet_id = fs.existsSync(SHEET_ID_FILE) ? fs.readFileSync(SHEET_ID_FILE, "utf-8").trim() : null;
    if (!sheet_id) return res.json({ status: "error", message: "Sheet ID not set" });
    runScript(path.join(BASE_DIR, "node_scripts/facebook_scraper.js"), [`--sheet=${sheet_id}`, `--key=${SERVICE_JSON}`], wsClients);
    res.json({ status: "started" });
});

app.post("/run-website-scraper", (req, res) => {
    runScript(path.join(BASE_DIR, "node_scripts/website_scraper.js"), [], wsClients);
    res.json({ status: "started" });
});

app.post("/run-email-filter", (req, res) => {
    runScript(path.join(BASE_DIR, "node_scripts/email_filter.js"), [], wsClients);
    res.json({ status: "started" });
});

// ----------------------
// WebSocket for logs
// ----------------------
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const wss = new WebSocket.Server({ server, path: "/ws/logs" });

wss.on("connection", (ws) => {
    wsClients.push(ws);
    ws.on("close", () => { wsClients = wsClients.filter(c => c !== ws); });
});

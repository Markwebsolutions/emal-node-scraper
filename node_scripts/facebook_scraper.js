const puppeteerExtra = require("puppeteer-extra");
const stealth = require("puppeteer-extra-plugin-stealth");
const puppeteer = require("puppeteer");
const { google } = require("googleapis");
const pLimit = require("p-limit").default;
const minimist = require("minimist");
const path = require("path");
const fs = require("fs");

puppeteerExtra.use(stealth());
const argv = minimist(process.argv.slice(2));

// Paths
const SERVICE_JSON = argv.key
    ? path.resolve(argv.key)
    : path.join(__dirname, "service_account.json");

const SPREADSHEET_ID = argv.sheet;

console.log("Using SERVICE_JSON:", SERVICE_JSON);
console.log("Using SPREADSHEET_ID:", SPREADSHEET_ID);

if (!SPREADSHEET_ID) {
    console.error("❌ Missing --sheet parameter");
    process.exit(1);
}
if (!fs.existsSync(SERVICE_JSON)) {
    console.error("❌ service_account.json NOT found:", SERVICE_JSON);
    process.exit(1);
}

// -----------------------------------------
// GOOGLE SHEETS
// -----------------------------------------
async function getSheets() {
    const auth = new google.auth.GoogleAuth({
        keyFile: SERVICE_JSON,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const client = await auth.getClient();
    return google.sheets({ version: "v4", auth: client });
}

// Load sheet rows
async function getFacebookLinks() {
    const sheets = await getSheets();

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: "Sheet1!A1:Z9999",
    });

    const rows = res.data.values || [];
    if (!rows.length) throw "Spreadsheet empty";

    const header = rows[0];

    const fbIndex = header.indexOf("Facebook Link");
    const emailIndex = header.indexOf("Business Email");
    const nameIndex = header.indexOf("Business Name");

    if (fbIndex === -1 || emailIndex === -1 || nameIndex === -1)
        throw "❌ Required columns missing: Facebook Link, Business Email, Business Name";

    let list = [];
    for (let i = 1; i < rows.length; i++) {
        const fb = rows[i][fbIndex];
        const name = rows[i][nameIndex] || "Unknown Business";

        if (fb && fb.trim() !== "") {
            list.push({
                row: i + 1,
                url: fb.trim(),
                name,
            });
        }
    }

    console.log(`📌 Total Facebook URLs Found: ${list.length}`);
    return { list, fbIndex, emailIndex };
}

// -----------------------------------------
// EMAIL EXTRACTOR
// -----------------------------------------
function extractEmail(text) {
    const regex = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
    const found = text.match(regex);
    return found ? found[1] : "";
}

// -----------------------------------------
// Utility: Convert column number → A, B, C...
// -----------------------------------------
function colLetter(n) {
    let s = "";
    while (n > 0) {
        let mod = (n - 1) % 26;
        s = String.fromCharCode(65 + mod) + s;
        n = Math.floor((n - mod) / 26);
    }
    return s;
}

// -----------------------------------------
// BATCH WRITER (Option A)
// -----------------------------------------
let pendingUpdates = [];
const BATCH_SIZE = 10;  // write every 10 rows

async function flushBatch(emailIndex, fbIndex) {
    if (pendingUpdates.length === 0) return;

    const sheets = await getSheets();

    const data = pendingUpdates.map((item) => ({
        range: `Sheet1!${colLetter(item.colIndex + 1)}${item.row}`,
        values: [[item.value]],
    }));

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
            valueInputOption: "RAW",
            data,
        },
    });

    console.log(`📝 Batch update done → ${pendingUpdates.length} rows\n`);

    pendingUpdates = [];
}

async function queueWrite(row, colIndex, value, emailIndex, fbIndex) {
    pendingUpdates.push({ row, colIndex, value });

    if (pendingUpdates.length >= BATCH_SIZE) {
        await flushBatch(emailIndex, fbIndex);
    }
}

// -----------------------------------------
// SCRAPER
// -----------------------------------------
async function scrapeFacebookEmail(url, browser) {
    try {
        const page = await browser.newPage();

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
        );

        console.log(`🌐 Visiting → ${url}`);

        await page.goto(url, {
            waitUntil: "networkidle2",
            timeout: 45000,
        });

        await new Promise((r) => setTimeout(r, 3000));

        const html = await page.content();
        await page.close();

        return extractEmail(html);

    } catch (err) {
        console.log("❌ Scrape error:", err.message);
        return "";
    }
}

// -----------------------------------------
// MAIN
// -----------------------------------------
(async () => {
    console.log("🚀 Facebook Email Scraper Started (Batch Mode)");

    const { list, fbIndex, emailIndex } = await getFacebookLinks();

    const browser = await puppeteerExtra.launch({
        headless: true,
        executablePath:
            process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const limit = pLimit(5);

    const tasks = list.map((item) =>
        limit(async () => {
            console.log(`\n🔍 Business: ${item.name}`);
            console.log(`📄 Row: ${item.row}`);

            const email = await scrapeFacebookEmail(item.url, browser);

            if (email) {
                console.log(`📧 Email Found → ${email}`);
                await queueWrite(item.row, emailIndex, email, emailIndex, fbIndex);
            } else {
                console.log(`❌ No email found → Storing FB link`);
                await queueWrite(item.row, fbIndex, item.url, emailIndex, fbIndex);
            }
        })
    );

    await Promise.all(tasks);

    // write remaining rows
    await flushBatch(emailIndex, fbIndex);

    await browser.close();
    console.log("\n🎉 COMPLETE — Batch updates finished!");
})();

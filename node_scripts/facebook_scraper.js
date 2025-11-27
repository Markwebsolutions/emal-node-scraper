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

const SERVICE_JSON = argv.key ? path.resolve(argv.key) : path.join(__dirname, "service_account.json");
const SPREADSHEET_ID = argv.sheet;

console.log("Using SERVICE_JSON:", SERVICE_JSON);
console.log("Using SPREADSHEET_ID:", SPREADSHEET_ID);

if (!SPREADSHEET_ID) {
    console.error("❌ Missing --sheet parameter");
    process.exit(1);
}
if (!fs.existsSync(SERVICE_JSON)) {
    console.error("❌ service_account.json not found:", SERVICE_JSON);
    process.exit(1);
}

async function getSheets() {
    const auth = new google.auth.GoogleAuth({
        keyFile: SERVICE_JSON,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const client = await auth.getClient();
    return google.sheets({ version: "v4", auth: client });
}

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

    const list = rows
        .slice(1)
        .map((row, i) => {
            const fb = row[fbIndex];
            const name = row[nameIndex] || "Unknown Business";

            return fb ? { row: i + 2, url: fb.trim(), name } : null;
        })
        .filter(Boolean);

    console.log(`📌 Total Facebook URLs Found: ${list.length}`);
    return { list, fbIndex, emailIndex };
}

// ✔ extract ONLY mailto emails
function extractEmail(html) {
    const mailto = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return mailto ? mailto[1] : "";
}

// Convert column number to letter (1 = A)
function colLetter(n) {
    let s = "";
    while (n > 0) {
        let mod = (n - 1) % 26;
        s = String.fromCharCode(65 + mod) + s;
        n = Math.floor((n - mod) / 26);
    }
    return s;
}

async function writeSingleCell(row, colIndex, value) {
    const sheets = await getSheets();
    const col = colLetter(colIndex + 1);
    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Sheet1!${col}${row}`,
        valueInputOption: "RAW",
        requestBody: { values: [[value]] },
    });
}

async function scrapeFacebookEmail(url, browser) {
    try {
        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
        await page.goto(url, { waitUntil: "networkidle2", timeout: 35000 });

        const html = await page.content();
        await page.close();

        return extractEmail(html);
    } catch (err) {
        console.log("❌ Error:", err.message);
        return "";
    }
}

(async () => {
    console.log("🚀 Facebook Email Scraper Started");

    const { list, fbIndex, emailIndex } = await getFacebookLinks();

    const browser = await puppeteerExtra.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const limit = pLimit(3);

    const tasks = list.map(item =>
        limit(async () => {
            console.log(`\n🔍 Scraping Business: ${item.name}`);
            console.log(`🌐 Page: ${item.url}`);
            console.log(`📄 Sheet Row: ${item.row}`);

            const email = await scrapeFacebookEmail(item.url, browser);

            if (email) {
                console.log(`📧 Email Found → ${email}`);
                await writeSingleCell(item.row, emailIndex, email);
            } else {
                console.log(`❌ Email NOT found → storing FB link back`);
                await writeSingleCell(item.row, fbIndex, item.url);
            }

            console.log(`✅ Updated row ${item.row}\n`);
        })
    );

    await Promise.all(tasks);
    await browser.close();

    console.log("🎉 REAL-TIME Updates Complete!");
})();

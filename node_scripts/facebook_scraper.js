const puppeteerExtra = require("puppeteer-extra");
const stealth = require("puppeteer-extra-plugin-stealth");
const puppeteer = require("puppeteer");
const { google } = require("googleapis");
const pLimit = require("p-limit").default;
const minimist = require("minimist");
const path = require("path");
const fs = require("fs");

puppeteerExtra.use(stealth());

// CLI arguments
const argv = minimist(process.argv.slice(2));

const SERVICE_JSON = argv.key
    ? path.resolve(argv.key)
    : path.join(__dirname, "service_account.json");

const SPREADSHEET_ID = argv.sheet;

// validations
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

// ======================================================================
// GOOGLE SHEETS AUTH
// ======================================================================
async function getSheets() {
    const auth = new google.auth.GoogleAuth({
        keyFile: SERVICE_JSON,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const client = await auth.getClient();
    return google.sheets({ version: "v4", auth: client });
}

// ======================================================================
// READ SHEET (Facebook Link + Business Email + Business Name)
// ======================================================================
async function getFacebookLinks() {
    const sheets = await getSheets();

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: "Sheet1!A1:Z9999",
    });

    const rows = res.data.values || [];
    if (!rows.length) throw "Spreadsheet is empty";

    const header = rows[0];

    const fbIndex = header.indexOf("Facebook Link");
    const emailIndex = header.indexOf("Business Email");
    const nameIndex = header.indexOf("Business Name");

    if (fbIndex === -1) throw "❌ Column 'Facebook Link' missing.";
    if (emailIndex === -1) throw "❌ Column 'Business Email' missing.";
    if (nameIndex === -1) throw "❌ Column 'Business Name' missing.";

    let list = [];
    for (let i = 1; i < rows.length; i++) {
        const fb = rows[i][fbIndex];
        if (fb && fb.trim() !== "") {
            list.push({
                row: i + 1,
                url: fb.trim(),
                name: rows[i][nameIndex] || "Unknown Business",
            });
        }
    }

    console.log(`📌 URLs Loaded: ${list.length}`);
    return { list, emailIndex };
}

// ======================================================================
// EMAIL REGEX (same as your simple script)
// ======================================================================
function extractEmail(text) {
    const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const found = text.match(regex);
    return found ? found[0] : "";
}

// ======================================================================
// COLUMN LETTER UTILITY
// ======================================================================
function columnLetter(colNumber) {
    let temp = "";
    let letter = "";
    while (colNumber > 0) {
        temp = (colNumber - 1) % 26;
        letter = String.fromCharCode(temp + 65) + letter;
        colNumber = (colNumber - temp - 1) / 26;
    }
    return letter;
}

// ======================================================================
// DIRECT WRITE — EXACT same behaviour as your simple script
// ======================================================================
async function writeEmailToSheet(row, email, emailIndex) {
    const sheets = await getSheets();
    const col = columnLetter(emailIndex + 1);

    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Sheet1!${col}${row}`,
        valueInputOption: "RAW",
        requestBody: { values: [[email]] },
    });

    console.log(`✅ Saved Business Email (Row ${row}): ${email}`);
}

// ======================================================================
// SCRAPER
// ======================================================================
async function scrapeFacebookEmail(url, browser) {
    try {
        const page = await browser.newPage();
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/122 Safari/537.36"
        );

        console.log(`🌐 Visiting: ${url}`);
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

        await new Promise(res => setTimeout(res, 4000));

        const HTML = await page.content();
        await page.close();

        return extractEmail(HTML);

    } catch (err) {
        console.log(`❌ Scrape error: ${err.message}`);
        return "";
    }
}

// ======================================================================
// MAIN — EXACT behaviour of your simple script
// ======================================================================
(async () => {
    console.log("🚀 Starting Facebook Email Scraper…");

    const { list, emailIndex } = await getFacebookLinks();

    const browser = await puppeteerExtra.launch({
        headless: true,
        executablePath: puppeteer.executablePath(),
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled"
        ],
    });

    const limit = pLimit(7);

    const tasks = list.map(item =>
        limit(async () => {
            console.log(`\n🔹 Business: ${item.name}`);
            console.log(`🔎 Row ${item.row}: ${item.url}`);

            const email = await scrapeFacebookEmail(item.url, browser);

            if (email) {
                console.log(`📧 Found: ${email}`);
            } else {
                console.log("❌ No email found");
            }

            await writeEmailToSheet(item.row, email, emailIndex);

            await new Promise(res =>
                setTimeout(res, 2000 + Math.random() * 4000)
            );
        })
    );

    await Promise.all(tasks);

    await browser.close();
    console.log("\n🎉 DONE — Emails Updated Row-by-Row (no batch, exact behaviour).");
})();

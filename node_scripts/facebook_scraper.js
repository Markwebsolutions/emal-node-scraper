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
// EMAIL EXTRACTION (OLD VERSION — BEST!)
// -----------------------------------------
function extractEmail(text) {
    const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const found = text.match(regex);
    return found ? found[0] : "";
}

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

async function writeSingleCell(row, colIndex, value) {
    const sheets = await getSheets();
    const col = colLetter(colIndex + 1);

    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Sheet1!${col}${row}`,
        valueInputOption: "RAW",
        requestBody: { values: [[value]] },
    });

    console.log(`📝 Updated Row ${row} → Col ${col} = ${value}`);
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

        console.log(`🌐 Visiting: ${url}`);

        await page.goto(url, {
            waitUntil: "networkidle2",
            timeout: 45000,
        });

        await new Promise(res => setTimeout(res, 3000));

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
    console.log("🚀 Facebook Email Scraper Started");

    const { list, fbIndex, emailIndex } = await getFacebookLinks();

    const browser = await puppeteerExtra.launch({
        headless: true,
        executablePath:
            process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const limit = pLimit(5); // parallel tasks

    const tasks = list.map(item =>
        limit(async () => {
            console.log(`\n🔍 Business: ${item.name}`);
            console.log(`📄 Row: ${item.row}`);

            const email = await scrapeFacebookEmail(item.url, browser);

            if (email) {
                console.log(`📧 Email Found → ${email}`);
                await writeSingleCell(item.row, emailIndex, email);
            } else {
                console.log(`❌ No email found`);
                await writeSingleCell(item.row, fbIndex, item.url);
            }
        })
    );

    await Promise.all(tasks);

    await browser.close();
    console.log("\n🎉 COMPLETE — Live sheet updates done!");
})();

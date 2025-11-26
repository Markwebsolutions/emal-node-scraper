const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const { google } = require("googleapis");
const minimist = require("minimist");

const argv = minimist(process.argv.slice(2));

const BASE_DIR = path.join(__dirname, "..");
const STORAGE_DIR = path.join(BASE_DIR, "storage");
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR);

const SERVICE_JSON = path.join(STORAGE_DIR, "service_account.json");
const SHEET_ID_FILE = path.join(STORAGE_DIR, "sheet_id.txt");

if (process.env.SERVICE_JSON_CONTENT) {
    fs.writeFileSync(SERVICE_JSON, process.env.SERVICE_JSON_CONTENT);
}
if (process.env.SHEET_ID) {
    fs.writeFileSync(SHEET_ID_FILE, process.env.SHEET_ID);
}

if (!fs.existsSync(SERVICE_JSON)) throw new Error("❌ service_account.json missing");
if (!fs.existsSync(SHEET_ID_FILE)) throw new Error("❌ sheet_id.txt missing");

const SPREADSHEET_ID = fs.readFileSync(SHEET_ID_FILE, "utf-8").trim();

async function getSheets() {
    const auth = new google.auth.GoogleAuth({
        keyFile: SERVICE_JSON,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const client = await auth.getClient();
    return google.sheets({ version: "v4", auth: client });
}

async function readSheet() {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: "Sheet1!A1:Z9999",
    });
    const rows = res.data.values || [];
    const header = rows[0];
    return { rows, header };
}

function cleanUrl(url) {
    if (!url || typeof url !== "string") return "";
    if (!url.startsWith("http")) url = "http://" + url;
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.hostname}`;
    } catch {
        return "";
    }
}

function extractMailtoEmails($) {
    const emails = new Set();
    $("a[href^='mailto:']").each((i, el) => {
        const email = $(el).attr("href").replace("mailto:", "").split("?")[0].trim().toLowerCase();
        if (email) emails.add(email);
    });
    return Array.from(emails);
}

async function scrapeMailtoOnly(url) {
    try {
        const res = await axios.get(url, {
            timeout: 10000,
            headers: { "User-Agent": "Mozilla/5.0" },
        });
        const $ = cheerio.load(res.data);
        return extractMailtoEmails($);
    } catch {
        return [];
    }
}

function findContactAboutLinks($, baseUrl) {
    let contact = null;
    let about = null;

    $("a[href]").each((i, el) => {
        const href = $(el).attr("href")?.toLowerCase() || "";
        if (!contact && href.includes("contact"))
            contact = new URL(href, baseUrl).href;

        if (!about && href.includes("about"))
            about = new URL(href, baseUrl).href;
    });

    return { contact, about };
}

// -------------------------
// NEW FUNCTION: Write a single row instantly
// -------------------------
async function updateSingleRow(rowNumber, rowData) {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Sheet1!A${rowNumber}:Z${rowNumber}`,
        valueInputOption: "RAW",
        requestBody: { values: [rowData] },
    });
}

(async () => {
    const { rows, header } = await readSheet();
    const websiteIndex = header.indexOf("Business Website");
    const fbIndex = header.indexOf("Facebook Link");
    const emailIndex = header.indexOf("Business Email");

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const businessName = row[0] || "Unknown";

        const url = cleanUrl(row[websiteIndex]);

        let emails = [];
        let fbLink = "";
        let contact = null;
        let about = null;

        console.log("\n==========================================");
        console.log(`🔍 ROW ${i + 1}`);
        console.log(`🏢 Business: ${businessName}`);
        console.log(`🌐 Website: ${url || "No website"}`);
        console.log("------------------------------------------");

        if (url) {
            console.log("📄 Step 1: Homepage...");
            emails = await scrapeMailtoOnly(url);

            const mainRes = await axios.get(url);
            const $ = cheerio.load(mainRes.data);

            ({ contact, about } = findContactAboutLinks($, url));

            $("a[href]").each((i, el) => {
                const href = $(el).attr("href")?.toLowerCase() || "";
                if (!fbLink && (href.includes("facebook.com") || href.includes("fb.com"))) {
                    fbLink = new URL(href, url).href;
                }
            });

            if (!emails.length && contact) {
                console.log(`📄 Step 2: Contact Page: ${contact}`);
                emails = await scrapeMailtoOnly(contact);
            }

            if (!emails.length && about) {
                console.log(`📄 Step 3: About Page: ${about}`);
                emails = await scrapeMailtoOnly(about);
            }
        }

        row[emailIndex] = emails.join(", ");
        row[fbIndex] = fbLink;

        // -------- WRITE IMMEDIATELY --------
        await updateSingleRow(i + 1, row);

        if (emails.length) {
            console.log(`📧 Email Found: ${emails.join(", ")}`);
        } else {
            console.log("❌ No email found");
            if (fbLink) console.log(`➡ Using Facebook instead: ${fbLink}`);
        }

        console.log(`✔ Row ${i + 1} saved to Google Sheets`);
        console.log("==========================================\n");
    }

    console.log("✅ Scraper Finished (live writing mode)");
})();

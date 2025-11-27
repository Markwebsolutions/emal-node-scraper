const SERVICE_JSON = argv.key || "service_account.json";
const SPREADSHEET_ID = argv.sheet || "";

// ======================================================================
// IMPORTS
// ======================================================================
const puppeteerExtra = require("puppeteer-extra");
const stealth = require("puppeteer-extra-plugin-stealth");
const puppeteer = require("puppeteer");
const { google } = require("googleapis");
const pLimit = require("p-limit").default;   // ⭐ FIXED — correct import

puppeteerExtra.use(stealth());

// ======================================================================
// GOOGLE SHEETS AUTH
// ======================================================================
async function getSheets() {
    const auth = new google.auth.GoogleAuth({
        keyFile: argv.key || "service_account.json",
        scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const client = await auth.getClient();
    return google.sheets({ version: "v4", auth: client });
}


// ======================================================================
// READ FACEBOOK LINKS FROM SHEET
// ======================================================================
async function getFacebookLinks() {
    const sheets = await getSheets();

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: "Sheet1!A1:Z5000",
    });

    const rows = res.data.values;
    const header = rows[0];

    const fbIndex = header.indexOf("Facebook Link");
    const emailIndex = header.indexOf("Business Email");

    if (fbIndex === -1) throw new Error("❌ Column 'Facebook Link' not found.");
    if (emailIndex === -1) throw new Error("❌ Column 'Business Email' not found.");

    let urls = [];

    for (let i = 1; i < rows.length; i++) {
        let fbLink = rows[i][fbIndex];
        if (fbLink && fbLink.trim() !== "") {
            urls.push({ row: i + 1, url: fbLink });
        }
    }

    console.log(`📌 Loaded ${urls.length} Facebook links.`);
    return { urls, fbIndex, emailIndex };
}

// ======================================================================
// EMAIL REGEX
// ======================================================================
function extractEmail(text) {
    const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const found = text.match(regex);
    return found ? found[0] : "";
}

// ======================================================================
// SCRAPE FACEBOOK
// ======================================================================
async function scrapeFacebookEmail(url, browser) {
    try {
        const page = await browser.newPage();

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
        );

        console.log(`🌐 Visiting: ${url}`);
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

        await new Promise(res => setTimeout(res, 4000));

        const content = await page.content();
        const email = extractEmail(content);

        await page.close();
        return email;

    } catch (err) {
        console.log(`⚠️ Error scraping ${url}: ${err.message}`);
        return "";
    }
}

// ======================================================================
// COLUMN LETTER FUNCTION
// ======================================================================
function getColumnLetter(colNumber) {
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
// WRITE TO SHEET → Business Email column
// ======================================================================
async function writeEmailToSheet(row, email, emailIndex) {
    const sheets = await getSheets();

    const columnLetter = getColumnLetter(emailIndex + 1);

    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Sheet1!${columnLetter}${row}`,
        valueInputOption: "RAW",
        requestBody: { values: [[email]] }
    });

    console.log(`✅ Saved to Business Email (Row ${row}): ${email}`);
}

// ======================================================================
// MAIN — PARALLEL SCRAPING (7 AT A TIME)
// ======================================================================
async function main() {
    console.log("🚀 Starting Facebook Email Scraper...");

    const { urls, emailIndex } = await getFacebookLinks();

    const browser = await puppeteerExtra.launch({
        headless: true,
        executablePath: puppeteer.executablePath(),
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled"
        ]
    });

    const limit = pLimit(7); // ⭐ run 7 at a time safely

    const tasks = urls.map(entry =>
        limit(async () => {
            console.log(`\n🔎 Scraping row ${entry.row}: ${entry.url}`);

            const email = await scrapeFacebookEmail(entry.url, browser);

            if (email) {
                console.log(`📧 Email Found: ${email}`);
            } else {
                console.log("❌ No email found");
            }

            await writeEmailToSheet(entry.row, email, emailIndex);

            const wait = 2000 + Math.random() * 4000;
            await new Promise(res => setTimeout(res, wait));
        })
    );

    await Promise.all(tasks);

    await browser.close();
    console.log("\n🎉 DONE! All Facebook emails processed (Parallel & Zero Skipping).");
}

// RUN
main();

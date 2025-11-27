const puppeteerExtra = require("puppeteer-extra");
const stealth = require("puppeteer-extra-plugin-stealth");
const puppeteer = require("puppeteer");
const { google } = require("googleapis");
const pLimit = require("p-limit").default;
const argv = require("minimist")(process.argv.slice(2));

puppeteerExtra.use(stealth());

// ======================================================================
// ARGS
// ======================================================================
const SERVICE_JSON = argv.key || "service_account.json";
const SPREADSHEET_ID = argv.sheet || "";

// ======================================================================
// GOOGLE SHEETS AUTH
// ======================================================================
async function getSheets() {
const auth = new google.auth.GoogleAuth({
keyFile: SERVICE_JSON,
scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const client = await auth.getClient();
return google.sheets({ version: "v4", auth: client });
}

// ======================================================================
// READ FACEBOOK LINKS
// ======================================================================
async function getFacebookLinks() {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: "Sheet1!A1:Z5000", // Fetch enough rows and columns
    });
    const rows = res.data.values;
    if (!rows || rows.length === 0) throw new Error("No data found in sheet");

    // Normalize headers: trim spaces and lowercase
    const header = rows[0].map(h => h.trim().toLowerCase());
    const fbIndex = header.indexOf("facebook link");
    const emailIndex = header.indexOf("business email");

    if (fbIndex === -1) throw new Error("Column 'Facebook Link' not found");
    if (emailIndex === -1) throw new Error("Column 'Business Email' not found");

    const urls = [];
    for (let i = 1; i < rows.length; i++) {
        const fbLink = rows[i][fbIndex];
        if (fbLink && fbLink.trim() !== "") urls.push({ row: i + 1, url: fbLink });
    }
    console.log(`Loaded ${urls.length} Facebook links`);
    return { urls, emailIndex };
}


// ======================================================================
// EMAIL REGEX
// ======================================================================
function extractEmail(text) {
const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+.[a-zA-Z]{2,}/g;
const found = text.match(regex);
return found ? found[0] : "";
}

// ======================================================================
// SCRAPE FACEBOOK ABOUT SECTION FOR EMAIL
// ======================================================================
async function scrapeFacebookEmail(url, browser) {
try {
const page = await browser.newPage();
await page.setUserAgent(
"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
);
await page.setViewport({ width: 1200, height: 800 });

    console.log(`Visiting: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    const aboutSelector = 'a[href*="about"]';
    await page.waitForSelector(aboutSelector, { timeout: 15000 });
    await page.click(aboutSelector);

    // Wait for dynamic content
    await new Promise(r => setTimeout(r, 5000));

    const content = await page.evaluate(() => document.body.innerText);
    const email = extractEmail(content);
    await page.close();
    return email;
} catch (err) {
    console.log(`Error scraping ${url}: ${err.message}`);
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
// BATCH WRITE EMAILS TO SHEET
// ======================================================================
async function batchWriteEmails(results, emailIndex) {
if (!results.length) return;

const sheets = await getSheets();
const data = results.map(({ row, email }) => {
    const colLetter = getColumnLetter(emailIndex + 1);
    return {
        range: `Sheet1!${colLetter}${row}`,
        values: [[email]],
    };
});

await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
        valueInputOption: "RAW",
        data,
    },
});

console.log(`Batch updated ${results.length} rows successfully`);

}

// ======================================================================
// MAIN
// ======================================================================
async function main() {
if (!SPREADSHEET_ID) {
console.log("No spreadsheet ID provided. Use --sheet=ID");
return;
}

const { urls, emailIndex } = await getFacebookLinks();

const browser = await puppeteerExtra.launch({
    headless: true,
    executablePath: puppeteer.executablePath(),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"]
});

const limit = pLimit(5); // concurrency for scraping
const results = [];

const tasks = urls.map(entry =>
    limit(async () => {
        console.log(`Scraping row ${entry.row}: ${entry.url}`);
        const email = await scrapeFacebookEmail(entry.url, browser);
        results.push({ row: entry.row, email });
        if (email) console.log(`Found email: ${email}`);
        else console.log("No email found");
        await new Promise(r => setTimeout(r, 1000)); // small delay to avoid anti-bot
    })
);

await Promise.all(tasks);
await browser.close();

// Batch update all emails at once
await batchWriteEmails(results, emailIndex);

console.log("All done!");

}

main();
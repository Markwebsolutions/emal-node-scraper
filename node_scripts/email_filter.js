const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

// ------------------------------
// BASE PATHS
// ------------------------------
const BASE_DIR = __dirname;
const SERVICE_JSON = path.join(BASE_DIR, "../storage/service_account.json");
const SHEET_ID_FILE = path.join(__dirname, "../storage/sheet_id.txt");


// ------------------------------
// READ SHEET ID
// ------------------------------
if (!fs.existsSync(SHEET_ID_FILE)) {
  throw new Error("❌ Sheet ID file missing at storage/sheet_id.txt");
}
const SPREADSHEET_ID = fs.readFileSync(SHEET_ID_FILE, "utf-8").trim();

// ------------------------------
// GOOGLE AUTH
// ------------------------------
async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_JSON,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive"
    ],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

// ------------------------------
// READ SHEET1 VALUES
// ------------------------------
async function readSheet() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1",
  });

  const rows = res.data.values || [];
  if (rows.length === 0) throw new Error("❌ Sheet1 is empty!");

  const header = rows[0];
  const dataRows = rows.slice(1);

  return { header, dataRows };
}

// ------------------------------
// FILTER ROWS CONTAINING EMAIL
// ------------------------------
function filterRowsWithEmails(header, dataRows) {
  const emailIndex = header.indexOf("Business Email");
  if (emailIndex === -1) {
    throw new Error("❌ Column 'Business Email' not found in header!");
  }

  return dataRows.filter(row => row[emailIndex] && row[emailIndex].trim() !== "");
}

// ------------------------------
// DELETE OLD SHEET + CREATE NEW ONE
// ------------------------------
async function recreateEmailsOnlySheet(header, filteredRows) {
  const sheets = await getSheets();

  // Fetch full spreadsheet info
  const info = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const allSheets = info.data.sheets;

  // Delete sheet if already exists
  const existing = allSheets.find(s => s.properties.title === "Emails Only");
  if (existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ deleteSheet: { sheetId: existing.properties.sheetId } }],
      },
    });
    console.log("🗑️ Old 'Emails Only' sheet deleted");
  }

  // Create new sheet
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: "Emails Only",
            gridProperties: { rowCount: filteredRows.length + 10 },
          },
        },
      }],
    },
  });

  // Write data
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: "Emails Only!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [header, ...filteredRows],
    },
  });

  console.log(`✅ 'Emails Only' created with ${filteredRows.length} rows.`);
}

// ------------------------------
// MAIN RUNNER
// ------------------------------
(async () => {
  try {
    console.log("📥 Reading sheet...");
    const { header, dataRows } = await readSheet();

    console.log("🔎 Filtering emails...");
    const filteredRows = filterRowsWithEmails(header, dataRows);

    console.log("📝 Writing into new sheet...");
    await recreateEmailsOnlySheet(header, filteredRows);

    console.log("🎉 Done!");
  } catch (err) {
    console.error("❌ ERROR:", err.message);
  }
})();

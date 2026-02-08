
const DRIVE_FOLDER_ID = '1ln--Q37vK1njIaI-1qz7Yf-b9hOfnkCc';
const MAP_PROP_KEY = 'RAG_FILENAME_MAP';

/**
 * 主程式：智慧同步 Google Drive 檔案 (Hybrid 雙重比對版)
 */
function syncDriveToGemini() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const apiKey = scriptProperties.getProperty('GEMINI_API_KEY');
  const storeName = scriptProperties.getProperty('FILE_STORE_NAME');

  if (!storeName) {
    Logger.log("❌ 錯誤：未設定 FILE_STORE_NAME");
    return;
  }

  // 1. 取得並清理對照表
  // 修正：使用 ID 比對來清理，避免路徑前綴不一致導致誤刪
  let nameMap = getFilenameMap();
  const liveDocs = getLiveDocuments(storeName, apiKey); // 取得 [{name, displayName}, ...]
  const liveDocIds = liveDocs.map(d => d.name.split('/').pop());

  let cleanMap = {};
  let mapKeys = Object.keys(nameMap);
  mapKeys.forEach(key => {
    const keyId = key.split('/').pop();
    // 只有當 Map 中的 ID 真的存在於 Live Store 時才保留
    if (liveDocIds.includes(keyId)) {
      cleanMap[key] = nameMap[key];
    }
  });
  saveFilenameMap(cleanMap);
  nameMap = cleanMap;

  // 建立「已存在名稱」清單 (來源：主要靠對照表 + 輔助靠 Gemini 真實名稱)
  // 這樣即使對照表遺失，只要 Gemini 上面名字是對的，也能擋掉重複
  let existingNamesSet = new Set(Object.values(nameMap));
  liveDocs.forEach(d => {
    if (d.displayName) existingNamesSet.add(d.displayName);
  });

  Logger.log(`✅ 知識庫與對照表比對完成。目前有效文件數: ${liveDocs.length}, 對照表紀錄: ${Object.keys(nameMap).length}`);
  Logger.log(`🔒 防重複清單: [${Array.from(existingNamesSet).join(', ')}]`);

  try {
    const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const files = folder.getFiles();
    let fileCount = 0;
    let skippedCount = 0;
    let successCount = 0;

    while (files.hasNext()) {
      const file = files.next();
      fileCount++;
      let displayName = file.getName();
      const mimeType = file.getMimeType();

      let expectedName = displayName;
      if (mimeType === 'application/vnd.google-apps.document' || mimeType === 'application/vnd.google-apps.spreadsheet') {
        if (!expectedName.toLowerCase().endsWith('.pdf')) expectedName += ".pdf";
      }

      // Hybrid 比對
      if (existingNamesSet.has(expectedName)) {
        Logger.log(`⏭️ [${fileCount}] 跳過 (已存在): ${expectedName}`);
        skippedCount++;
        continue;
      }

      // 準備 Blob
      let blobToUpload = null;
      if (mimeType === 'application/pdf' || mimeType === 'text/plain') {
        blobToUpload = file.getBlob();
      } else if (mimeType === 'application/vnd.google-apps.document' || mimeType === 'application/vnd.google-apps.spreadsheet') {
        Logger.log(`🔄 轉換導出: ${displayName}`);
        blobToUpload = file.getAs('application/pdf');
      }

      if (blobToUpload) {
        Logger.log(`📄 [${fileCount}] 啟動同步: ${expectedName}...`);
        try {
          const result = uploadBlobToGemini(blobToUpload, expectedName, storeName, apiKey);
          if (result && result.name) {
            nameMap[result.name] = expectedName;
            saveFilenameMap(nameMap);
            existingNamesSet.add(expectedName); // 立即加入 Set 防止同批次重複
            successCount++;
          }
          Utilities.sleep(2000); // 增加間隔
        } catch (e) {
          Logger.log(`   ❌ 同步失敗: ${e.toString()}`);
        }
      }
    }

    Logger.log("\n" + "=".repeat(50));
    Logger.log(`📊 報告: 掃描 ${fileCount} / 略過 ${skippedCount} / 新增 ${successCount}`);
    Logger.log("=".repeat(50));

  } catch (e) {
    Logger.log(`❌ 系統錯誤: ${e.toString()}`);
  }
}

function getFilenameMap() {
  const props = PropertiesService.getScriptProperties();
  const json = props.getProperty(MAP_PROP_KEY);
  try { return json ? JSON.parse(json) : {}; } catch (e) { return {}; }
}

function saveFilenameMap(map) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(MAP_PROP_KEY, JSON.stringify(map));
}

function getLiveDocuments(storeName, apiKey) {
  let docs = [];
  let nextPageToken = '';
  try {
    do {
      let url = `https://generativelanguage.googleapis.com/v1beta/${storeName}/documents?key=${apiKey}&pageSize=20`;
      if (nextPageToken) url += `&pageToken=${nextPageToken}`;
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      const data = JSON.parse(res.getContentText());
      if (data.documents) {
        docs = docs.concat(data.documents);
      }
      nextPageToken = data.nextPageToken;
    } while (nextPageToken);
  } catch (e) { }
  return docs;
}

function uploadBlobToGemini(blob, displayName, storeName, apiKey) {
  const boundary = "-------314159265358979323846";
  const metadata = { file: { displayName: displayName } };

  let requestBody = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadata) + "\r\n--" + boundary + "\r\nContent-Type: " + blob.getContentType() + "\r\n\r\n";
  const payload = Utilities.newBlob(requestBody).getBytes().concat(blob.getBytes()).concat(Utilities.newBlob("\r\n--" + boundary + "--\r\n").getBytes());

  const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
  const uploadRes = UrlFetchApp.fetch(uploadUrl, { method: "post", contentType: "multipart/related; boundary=" + boundary, payload: payload, headers: { "X-Goog-Upload-Protocol": "multipart" }, muteHttpExceptions: true });

  const fileData = JSON.parse(uploadRes.getContentText());
  const fileName = fileData.file?.name || fileData.name;
  if (!fileName) return null;

  const linkRes = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/${storeName}:importFile?key=${apiKey}`, { method: "post", contentType: "application/json", payload: JSON.stringify({ fileName: fileName }), muteHttpExceptions: true });
  const linkData = JSON.parse(linkRes.getContentText());

  if (linkData && linkData.name) {
    // 強制重試更名邏輯 (解決 ID 亂碼問題)
    Logger.log(`   🔗 取得 ID: ${linkData.name.split('/').pop()}，嘗試更名為: ${displayName}`);
    for (let i = 0; i < 3; i++) {
      Utilities.sleep(1000 * (i + 1));
      if (patchDocumentDisplayName(linkData.name, displayName, apiKey)) {
        Logger.log(`      ✅ 更名成功 (第 ${i + 1} 次嘗試)`);
        break;
      }
    }
  }
  return linkData;
}

function patchDocumentDisplayName(documentName, newDisplayName, apiKey) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/${documentName}?key=${apiKey}&updateMask=display_name`;
    const res = UrlFetchApp.fetch(url, {
      method: "patch",
      contentType: "application/json",
      payload: JSON.stringify({ displayName: newDisplayName }),
      muteHttpExceptions: true
    });
    return res.getResponseCode() === 200;
  } catch (e) {
    return false;
  }
}

function clearCurrentStore() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const storeName = props.getProperty('FILE_STORE_NAME');
  if (!storeName) return "未設定 Store Name";

  let deleteTotal = 0;
  for (let round = 0; round < 3; round++) {
    let allDocs = [];
    let pageToken = '';
    do {
      let url = `https://generativelanguage.googleapis.com/v1beta/${storeName}/documents?key=${apiKey}&pageSize=20`;
      if (pageToken) url += `&pageToken=${pageToken}`;
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) break;
      const data = JSON.parse(res.getContentText());
      if (data.documents) allDocs = allDocs.concat(data.documents);
      pageToken = data.nextPageToken;
    } while (pageToken);

    if (allDocs.length === 0) break;

    allDocs.forEach((doc) => {
      UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/${doc.name}?key=${apiKey}&force=true`, { method: "delete", muteHttpExceptions: true });
      deleteTotal++;
    });
    Utilities.sleep(1000);
  }

  props.deleteProperty(MAP_PROP_KEY);
  return `已執行 ${deleteTotal} 次刪除指令，對照表已重置。`;
}

function doGet(e) {
  const action = e.parameter.action;
  if (!action) return ContentService.createTextOutput("RAG Active").setMimeType(ContentService.MimeType.TEXT);
  let result = { status: 'ok', message: 'Ready', nameMap: {} };
  try {
    if (action === 'sync') {
      syncDriveToGemini();
      result.message = '同步完成';
      result.nameMap = getFilenameMap();
    } else if (action === 'clear') {
      const msg = clearCurrentStore();
      result.message = msg;
    } else if (action === 'getMap') {
      result.nameMap = getFilenameMap();
    }
  } catch (err) {
    result.status = 'error';
    result.message = err.toString();
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.TEXT);
}
function doPost(e) { return doGet(e); }
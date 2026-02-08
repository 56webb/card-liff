const DRIVE_FOLDER_ID = '1ln--Q37vK1njIaI-1qz7Yf-b9hOfnkCc';
const MAP_PROP_KEY = 'RAG_FILENAME_MAP';

/**
 * 【官方推薦】快速建立佈署 RAG：自動建立 Store 並同步
 */
function setupAndSync() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  let storeName = props.getProperty('FILE_STORE_NAME');

  if (!storeName || storeName.startsWith('corpora')) {
    Logger.log("✨ 正在為您建立官方推薦的 Google File Search Store...");
    const url = `https://generativelanguage.googleapis.com/v1beta/fileSearchStores?key=${apiKey}`;
    try {
      const res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify({ displayName: "我的 PDF 知識庫" }),
        muteHttpExceptions: true
      });
      const data = JSON.parse(res.getContentText());
      if (data.name) {
        storeName = data.name;
        props.setProperty('FILE_STORE_NAME', storeName);
        Logger.log(`✅ 建立成功！新 Store ID: ${storeName}`);
      } else {
        Logger.log(`❌ 建立失敗: ${res.getContentText()}`);
        return;
      }
    } catch (e) {
      Logger.log(`❌ 請求發生錯誤: ${e.toString()}`);
      return;
    }
  }

  syncDriveToGemini();
}

/**
 * 核心同步函式 (修正版 - 加入中文對照表與防重複)
 */
function syncDriveToGemini() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const storeName = props.getProperty('FILE_STORE_NAME');

  if (!storeName) {
    Logger.log("❌ 錯誤：未設定 FILE_STORE_NAME");
    return;
  }

  // 載入現有對照表
  let nameMap = getFilenameMap();

  // 取得目前 Store 內已有的文件清單 (用於防止重複上傳)
  const existingDocs = getLiveDocuments(storeName, apiKey);
  Logger.log(`📦 Store 內現有 ${existingDocs.length} 份文件`);

  // 建立目前 Store 內有效的文件名稱集合 (用於快速查找)
  const validDocNames = new Set(existingDocs.map(doc => doc.name));

  if (existingDocs.length > 0) {
    Logger.log(`🔍 Debug: Store ID 範例: ${existingDocs[0].name}`);
    const mapKeys = Object.keys(nameMap);
    if (mapKeys.length > 0) {
      Logger.log(`🔍 Debug: Map Key 範例:   ${mapKeys[0]}`);
    }
  }

  // 暫時移除自動清理邏輯，以對照表為準，避免 API 資料不完整導致誤刪
  const existingNames = new Set();

  // 1. 從 API 回傳的 displayName
  existingDocs.forEach(doc => {
    if (doc.displayName) {
      existingNames.add(doc.displayName);
      Logger.log(`   [API] 已存在: ${doc.displayName}`);
    }
  });

  // 2. 從 nameMap 補足 (最重要的防線)
  Object.values(nameMap).forEach(name => {
    if (!existingNames.has(name)) {
      existingNames.add(name);
      Logger.log(`   [Map] 已存在: ${name}`);
    }
  });

  Logger.log(`🛡️ 防重複機制: 已知 ${existingNames.size} 個檔案名稱`);

  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const files = folder.getFiles();
  let uploadCount = 0;
  let skipCount = 0;

  while (files.hasNext()) {
    const file = files.next();
    const fileName = file.getName(); // 原始中文檔名
    const mimeType = file.getMimeType();

    // 決定最終顯示名稱
    let finalDisplayName = fileName;
    if (mimeType.includes('vnd.google-apps') && !finalDisplayName.toLowerCase().endsWith('.pdf')) {
      finalDisplayName += '.pdf';
    }

    // 檢查是否已存在
    if (existingNames.has(finalDisplayName)) {
      Logger.log(`⏭️ 跳過 (已存在): ${finalDisplayName}`);
      skipCount++;
      continue;
    }

    Logger.log(`📄 處理中: ${fileName} (${mimeType})`);

    // 準備 Blob (如果是 Google 文件，轉換為 PDF)
    let blobToUpload = null;

    if (mimeType === 'application/pdf' || mimeType === 'text/plain') {
      blobToUpload = file.getBlob();
    } else if (mimeType.includes('vnd.google-apps')) {
      Logger.log(`   🔄 正在轉換 Google 文件為 PDF...`);
      blobToUpload = file.getAs('application/pdf');
    } else {
      Logger.log(`   ⚠️ 不支援的檔案格式，跳過。`);
      continue;
    }

    // 開始上傳與導入
    const result = uploadBlobToGemini(blobToUpload, finalDisplayName, storeName, apiKey);
    if (result && result.docName) {
      Logger.log(`   ✅ 同步完成: ${result.docName}`);
      // 保存對照：文件完整路徑 -> 中文檔名
      nameMap[result.docName] = finalDisplayName;
      saveFilenameMap(nameMap);
      // 也加進 existingNames 避免同批次重複
      existingNames.add(finalDisplayName);
      uploadCount++;
    } else {
      Logger.log(`   ❌ 同步失敗 (請查看上方 Log)`);
    }
    Utilities.sleep(1500);
  }

  Logger.log(`\n📊 同步報告: 新增 ${uploadCount} 份, 跳過 ${skipCount} 份`);
  Logger.log(`📝 對照表已更新，共 ${Object.keys(nameMap).length} 筆`);
}

/**
 * 上傳並導入檔案 (回傳包含文件 ID 的結果)
 */
function uploadBlobToGemini(blob, displayName, storeName, apiKey) {
  try {
    const boundary = "-------314159265358979323846";
    const metadata = { file: { displayName: displayName } };

    let requestBody = "--" + boundary + "\r\n" +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata) + "\r\n" +
      "--" + boundary + "\r\n" +
      "Content-Type: " + blob.getContentType() + "\r\n\r\n";

    const payload = Utilities.newBlob(requestBody).getBytes()
      .concat(blob.getBytes())
      .concat(Utilities.newBlob("\r\n--" + boundary + "--\r\n").getBytes());

    // 1. 上傳檔案到 Google Files
    const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
    const uploadRes = UrlFetchApp.fetch(uploadUrl, {
      method: "post",
      headers: { "X-Goog-Upload-Protocol": "multipart" },
      contentType: "multipart/related; boundary=" + boundary,
      payload: payload,
      muteHttpExceptions: true
    });

    const resText = uploadRes.getContentText();
    if (uploadRes.getResponseCode() !== 200) {
      Logger.log(`   ❌ 上傳失敗 (${uploadRes.getResponseCode()}): ${resText}`);
      return null;
    }

    const fileData = JSON.parse(resText);
    if (fileData.file && fileData.file.displayName) {
      Logger.log(`   ✅ 檔案上傳成功: ${fileData.file.displayName} (URI: ${fileData.file.uri})`);
    } else {
      Logger.log(`   ⚠️ 檔案上傳成功，但 displayName 未預期回傳。完整回應: ${resText.substring(0, 200)}`);
    }

    if (!fileData.file || !fileData.file.name) return null;
    const fileResourceName = fileData.file.name;

    // 2. 導入到 Store
    const linkUrl = `https://generativelanguage.googleapis.com/v1beta/${storeName}:importFile?key=${apiKey}`;
    const linkRes = UrlFetchApp.fetch(linkUrl, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ fileName: fileResourceName }),
      muteHttpExceptions: true
    });

    if (linkRes.getResponseCode() !== 200) {
      Logger.log(`   ❌ 導入 Store 失敗: ${linkRes.getContentText()}`);
      return null;
    }

    const linkData = JSON.parse(linkRes.getContentText());
    let finalDocName = linkData.name;

    // 如果回傳是 Operation，等待完成以取得真實 Document Name
    if (finalDocName && finalDocName.includes('/operations/')) {
      Logger.log(`   ⏳ 等待導入作業完成: ${finalDocName.split('/').pop()} ...`);
      for (let i = 0; i < 20; i++) {
        Utilities.sleep(1000);
        try {
          const opUrl = `https://generativelanguage.googleapis.com/v1beta/${finalDocName}?key=${apiKey}`;
          const opRes = UrlFetchApp.fetch(opUrl, { muteHttpExceptions: true });
          const opData = JSON.parse(opRes.getContentText());

          if (opData.done) {
            if (opData.response && opData.response.name) {
              finalDocName = opData.response.name;
              Logger.log(`   ✅ 導入完成，取得文件 ID: ${finalDocName.split('/').pop()}`);
            } else if (opData.error) {
              Logger.log(`   ❌ 導入作業失敗: ${JSON.stringify(opData.error)}`);
              return null; // 作業失敗，視為上傳失敗
            }
            break; // 完成或失敗都跳出迴圈
          }
        } catch (e) {
          Logger.log(`   ⚠️ 檢查作業狀態失敗: ${e}`);
        }
      }
    }

    return { docName: finalDocName || fileResourceName, displayName: displayName };
  } catch (e) {
    Logger.log(`   ❌ 程式執行異常: ${e.toString()}`);
    return null;
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

/**
 * 列出 Store 內所有文件 (含 displayName)
 */
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
  } catch (e) {
    Logger.log(`   ⚠️ 無法取得文件清單: ${e.toString()}`);
  }
  return docs;
}

function clearCurrentStore() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const storeName = props.getProperty('FILE_STORE_NAME');
  if (!storeName) return "未設定 Store Name";

  let deleteTotal = 0;
  for (let round = 0; round < 3; round++) {
    let allDocs = getLiveDocuments(storeName, apiKey);
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
  const props = PropertiesService.getScriptProperties();
  const action = e.parameter.action;
  if (!action) return ContentService.createTextOutput("RAG Active").setMimeType(ContentService.MimeType.TEXT);
  let result = { status: 'ok', message: 'Ready', nameMap: {} };
  try {
    if (action === 'sync') {
      syncDriveToGemini();
      result.message = '同步完成';
      result.nameMap = getFilenameMap();
      result.storeName = props.getProperty('FILE_STORE_NAME'); // 回傳 Store Name
    } else if (action === 'clear') {
      const msg = clearCurrentStore();
      result.message = msg;
    } else if (action === 'getMap') {
      result.nameMap = getFilenameMap();
    } else if (action === 'updateName') {
      // 更新對照表中的中文名稱
      const docName = e.parameter.docName;
      const newName = e.parameter.newName;
      if (docName && newName) {
        let nameMap = getFilenameMap();
        nameMap[docName] = newName;
        saveFilenameMap(nameMap);
        result.message = `已更新: ${newName}`;
        result.nameMap = nameMap;
      } else {
        result.status = 'error';
        result.message = '缺少 docName 或 newName 參數';
      }
    } else if (action === 'askQuestion') {
      // RAG 問答功能
      const question = e.parameter.question;
      const model = e.parameter.model || 'gemini-2.5-flash'; // 預設模型
      if (!question) {
        result.status = 'error';
        result.message = '缺少 question 參數';
      } else {
        const apiKey = props.getProperty('GEMINI_API_KEY');
        const storeName = props.getProperty('FILE_STORE_NAME');
        const ragResult = askRAG(question, storeName, apiKey, model);
        result = ragResult;
      }
    }
  } catch (err) {
    result.status = 'error';
    result.message = err.toString();
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
function doPost(e) { return doGet(e); }

function checkSettings() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const storeName = props.getProperty('FILE_STORE_NAME');

  Logger.log(`API Key: ${apiKey ? '✅ 已設定 (' + apiKey.substring(0, 5) + '...)' : '❌ 未設定'}`);
  Logger.log(`Store Name: ${storeName ? '✅ 已設定 (' + storeName + ')' : '❌ 未設定'}`);
  Logger.log(`\n📝 對照表內容:`);
  const map = getFilenameMap();
  Object.entries(map).forEach(([k, v]) => Logger.log(`   ${v} -> ${k.split('/').pop()}`));
}

/**
 * 除錯用：顯示 Store 內所有文件的詳細資訊
 */
function debugListDocs() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const storeName = props.getProperty('FILE_STORE_NAME');

  const docs = getLiveDocuments(storeName, apiKey);
  Logger.log(`📚 Store 內共 ${docs.length} 份文件:`);
  docs.forEach((doc, i) => {
    Logger.log(`[${i + 1}] name: ${doc.name}`);
    Logger.log(`    displayName: ${doc.displayName || '(無)'}`);
  });
}

/**
 * RAG 問答核心函式
 * 使用 Gemini File Search API 查詢知識庫並回答問題
 * @param {string} question - 使用者問題
 * @param {string} storeName - File Search Store ID
 * @param {string} apiKey - Gemini API Key
 * @param {string} model - 模型名稱 (如 gemini-2.5-flash, gemini-2.5-pro)
 */
function askRAG(question, storeName, apiKey, model) {
  // 預設使用 gemini-2.5-flash
  const modelName = model || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const payload = {
    "contents": [{
      "role": "user",
      "parts": [{ "text": question }]
    }],
    "tools": [{
      "file_search": {
        "file_search_store_names": [storeName]
      }
    }],
    "systemInstruction": {
      "parts": [{ "text": "你是一個專業的知識庫助手。請根據提供的文件內容回答問題。如果文件中沒有相關資訊，請誠實告知。回答時請使用繁體中文。" }]
    }
  };

  try {
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const responseCode = res.getResponseCode();
    const responseText = res.getContentText();

    if (responseCode !== 200) {
      return { status: 'error', message: `API 錯誤 (${responseCode}): ${responseText.substring(0, 500)}` };
    }

    const data = JSON.parse(responseText);

    // 解析回答
    let answer = '';
    let sources = [];
    let nameMap = getFilenameMap();

    if (data.candidates && data.candidates[0] && data.candidates[0].content) {
      answer = data.candidates[0].content.parts[0].text || '';

      // 解析引用來源 (Grounding Metadata)
      const metadata = data.candidates[0].groundingMetadata;
      if (metadata) {
        if (metadata.groundingChunks && metadata.groundingChunks.length > 0) {
          Logger.log(`📚 RAG 回應包含 ${metadata.groundingChunks.length} 個引用來源`);
        } else {
          Logger.log(`⚠️ RAG 回應包含 metadata 但無 chunks`);
        }
      } else {
        Logger.log(`⚠️ RAG 回應未包含 groundingMetadata (模型未引用文件)`);
      }

      if (metadata && metadata.groundingChunks) {
        sources = metadata.groundingChunks.map(chunk => {
          if (chunk.retrievedContext) {
            return {
              title: chunk.retrievedContext.title || '未知來源',
              uri: chunk.retrievedContext.uri || ''
            };
          }
          return null;
        }).filter(s => s !== null);
      }
    }

    return {
      status: 'ok',
      answer: answer,
      sources: sources,
      nameMap: nameMap,
      question: question
    };

  } catch (e) {
    return { status: 'error', message: e.toString() };
  }
}


/**
 * 官方標準 RAG 檢索測試 (參照 Google File Search Quickstart 文件)
 * 使用 gemini-2.5-flash 模型 + file_search 工具
 */
function testRAGRetrieval() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const storeName = props.getProperty('FILE_STORE_NAME');

  if (!apiKey || !storeName) {
    Logger.log("❌ 錯誤：未設定 API Key 或 Store Name");
    return;
  }

  const testQuery = "這份文件主要在講什麼？";
  Logger.log(`\n❓ 正在透過 File Search 測試問題: "${testQuery}"`);
  Logger.log(`📦 使用 Store: ${storeName}`);

  // 使用 gemini-2.5-flash 模型
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  // 依照官方文件建構 Payload
  const payload = {
    "contents": [{
      "role": "user",
      "parts": [{ "text": testQuery }]
    }],
    "tools": [{
      "file_search": {
        "file_search_store_names": [storeName]
      }
    }]
  };

  try {
    Logger.log(`📡 送出請求...`);
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const responseCode = res.getResponseCode();
    const responseText = res.getContentText();

    Logger.log(`回應代碼: ${responseCode}`);

    if (responseCode === 200) {
      const result = JSON.parse(responseText);

      // 解析回答
      if (result.candidates && result.candidates[0] && result.candidates[0].content) {
        const answer = result.candidates[0].content.parts[0].text;
        Logger.log(`\n💡 RAG 回答:\n${answer}`);

        // 檢查是否有來源引用 (Grounding Metadata)
        const metadata = result.candidates[0].groundingMetadata;
        if (metadata && metadata.groundingChunks) {
          Logger.log(`\n📄 檢索到 ${metadata.groundingChunks.length} 個參考片段。`);
          metadata.groundingChunks.forEach((chunk, i) => {
            if (chunk.retrievedContext) {
              Logger.log(`   [${i + 1}] ${chunk.retrievedContext.title || '無標題'}`);
            }
          });
        }
      } else {
        Logger.log("⚠️ API 回應成功但結構不如預期，完整回應如下：");
        Logger.log(responseText.substring(0, 1000));
      }
    } else {
      Logger.log(`❌ 查詢失敗 (${responseCode}):`);
      Logger.log(responseText.substring(0, 1500));
    }
  } catch (e) {
    Logger.log(`❌ 發生錯誤: ${e.toString()}`);
  }
}

/**
 * 列出目前 Store 內所有文件 (含中文名稱對照)
 */
function listStoreDocuments() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const storeName = props.getProperty('FILE_STORE_NAME');

  if (!storeName) {
    Logger.log("❌ 錯誤：未設定 FILE_STORE_NAME");
    return;
  }

  const nameMap = getFilenameMap();
  const url = `https://generativelanguage.googleapis.com/v1beta/${storeName}/documents?key=${apiKey}`;

  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const data = JSON.parse(res.getContentText());

    if (data.documents && data.documents.length > 0) {
      Logger.log(`📚 Store [${storeName}] 中有 ${data.documents.length} 份文件：`);
      data.documents.forEach((doc, i) => {
        const chineseName = nameMap[doc.name];
        // 優先顯示中文，若無則顯示 API displayName，再無則顯示 ID
        const finalShow = chineseName || doc.displayName || doc.name.split('/').pop();
        Logger.log(`   [${i + 1}] ${finalShow}`);
      });
    } else {
      Logger.log(`⚠️ Store [${storeName}] 是空的，尚無文件。`);
    }
  } catch (e) {
    Logger.log(`❌ 發生錯誤: ${e.toString()}`);
  }
}

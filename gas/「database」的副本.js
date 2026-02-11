// ================= 設定區 (安全版) =================
const scriptProperties = PropertiesService.getScriptProperties();

const LINE_CHANNEL_ID = scriptProperties.getProperty('LINE_CHANNEL_ID');
const SUPABASE_URL = scriptProperties.getProperty('SUPABASE_URL');
const SUPABASE_KEY = scriptProperties.getProperty('SUPABASE_KEY');

// 檢查變數是否設定
if (!LINE_CHANNEL_ID || !SUPABASE_URL || !SUPABASE_KEY) {
  Logger.log("❌ 錯誤：請先到「專案設定 > 指令碼屬性」設定所有變數！");
}

// ===== 統一的 JSON 回應函式 =====
function buildJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// 1. API 進入點
// 注意：doPost 已移至 gemini.js 統一處理，避免覆蓋。
// 這裡保留 handleCardWayAPI 供 gemini.js 呼叫。
// ==========================================

function doGet(e) {
  const page = e.parameter.page;

  // 路由：MomoJapan 攻略頁面 (?page=momo)
  if (page === 'momo' || page === 'momojapan') {
    const template = HtmlService.createTemplateFromFile('momojapan');

    // 🔒 安全注入：從後端屬性取得 Key，前端原始碼看不到
    const props = PropertiesService.getScriptProperties();
    template.apiKey = props.getProperty('GEMINI_API_KEY') || "";

    return template.evaluate()
      .setTitle('MomoJapan 日旅攻略')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // 預設首頁：顯示 API 狀態
  return ContentService.createTextOutput("CardWay API Server is running. (Use ?page=momo to access app)")
    .setMimeType(ContentService.MimeType.TEXT);
}

// 核心處理邏輯
function handleCardWayAPI(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action || "save_settings";

    // --- A. 身分驗證 (優先使用前端傳來的 userId，若無則驗證 Token) ---
    let userId = data.userId;

    if (!userId && data.idToken) {
      try {
        const verifyUrl = 'https://api.line.me/oauth2/v2.1/verify';
        const verifyResponse = UrlFetchApp.fetch(verifyUrl, {
          method: 'post',
          payload: { id_token: data.idToken, client_id: LINE_CHANNEL_ID },
          muteHttpExceptions: true
        });

        if (verifyResponse.getResponseCode() === 200) {
          const jwt = JSON.parse(verifyResponse.getContentText());
          userId = jwt.sub; // 取得 LINE User ID
        } else {
          Logger.log("Token Verify Failed: " + verifyResponse.getContentText());
        }
      } catch (e) {
        Logger.log("Verify Exception: " + e.toString());
      }
    }

    // 若驗證失敗，直接回傳錯誤
    if (!userId) {
      return buildJsonResponse({
        success: false,
        msg: "身分驗證失敗：無法取得 User ID"
      });
    }

    // --- B. 路由分發 (Switch Case) ---
    let response;
    switch (action) {
      case "get_settings":
        response = { success: true, settings: getFromSupabase(userId) };
        break;

      case "save_settings":
        // 這裡是用戶在 LIFF 勾選完卡片後儲存的地方
        // 確保 myWallet 包含明確的卡片名稱，例如 {"CTBC": ["LinePay卡"], "CATHAY": ["Cube卡"]}
        response = saveToSupabase(userId, data.myWallet, data.payMap, data.profile);
        break;

      case "submit_survey":
        // 📝 新增：問卷送出功能 (存入 Google Sheet)
        response = handleSurvey(data);
        break;

      case "test_connection":
        response = apiTestConnection();
        break;

      case "test_write":
        response = apiTestWrite();
        break;

      default:
        response = { success: false, msg: `未知的 action: ${action}` };
        break;
    }

    return buildJsonResponse(response);

  } catch (err) {
    return buildJsonResponse({ success: false, msg: "系統錯誤: " + err.toString() });
  }
}

// ==========================================
// 2. Supabase 讀取 (GET)
// ==========================================
function getFromSupabase(userId) {
  // 建議: 將 owned_banks 改為 user_holdings (較直觀)，目前維持原樣
  const url = `${SUPABASE_URL}/rest/v1/user_card_settings?user_id=eq.${userId}&select=owned_banks,payment_bindings,profile`;

  const options = {
    method: 'get',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY
    },
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(url, options);
    if (res.getResponseCode() !== 200) {
      Logger.log("Supabase Read Error: " + res.getContentText());
      return null;
    }

    const data = JSON.parse(res.getContentText());

    if (data.length > 0) {
      const row = data[0];

      // 輔助函式：如果 DB 存的是 JSONB，直接回傳；如果是字串則 parse
      const safeParse = (val, defaultVal) => {
        if (!val) return defaultVal;
        if (typeof val === 'object') return val; // 已經是物件 (JSONB)
        try { return JSON.parse(val); } catch (e) { return defaultVal; }
      };

      return {
        myWallet: safeParse(row.owned_banks, []),
        payMap: safeParse(row.payment_bindings, {}),
        profile: safeParse(row.profile, {})
      };
    }
    // 若無資料，回傳空設定讓前端初始化
    return { myWallet: [], payMap: {}, profile: {} };

  } catch (e) {
    Logger.log("Read Exception: " + e.toString());
    return null;
  }
}

// ==========================================
// 3. Supabase 寫入 (UPSERT)
// ==========================================
function saveToSupabase(userId, myWallet, payMap, profile) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { success: false, msg: "Supabase 設定遺失" };

  const url = `${SUPABASE_URL}/rest/v1/user_card_settings?on_conflict=user_id`;

  // 1. 準備 Payload
  const payload = {
    user_id: userId,
    owned_banks: myWallet, // 這裡存入的資料結構，將是 AI 判斷的依據
    payment_bindings: payMap,
    profile: profile || {},
    updated_at: new Date().toISOString()
  };

  const options = {
    method: 'post',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates' // UPSERT 關鍵
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  let saveSuccess = false;
  let saveMsg = "";

  // 2. 執行寫入
  try {
    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      saveSuccess = true;
    } else {
      saveMsg = `DB Error (${code}): ${res.getContentText()}`;
      Logger.log(saveMsg);
    }
  } catch (e) {
    saveMsg = "Connection Error: " + e.toString();
    Logger.log(saveMsg);
  }

  // 3. (Optional) 儲存問卷回饋，如果有填寫的話
  if (saveSuccess && profile && (profile.wantedFeatures || profile.painPoints)) {
    saveFeedback(userId, profile);
  }

  return { success: saveSuccess, msg: saveMsg };
}

// 獨立出來的 Feedback 儲存函式
function saveFeedback(userId, profile) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/user_feedbacks`;
    const payload = {
      user_id: userId,
      display_name: profile.displayName || "Unknown",
      wanted_features: profile.wantedFeatures,
      pain_points: profile.painPoints,
      support_price: profile.supportPrice || 0
    };

    UrlFetchApp.fetch(url, {
      method: 'post',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log("Feedback Save Error: " + e.toString());
  }
}

// ==========================================
// 4. 測試工具區
// ==========================================
function apiTestConnection() {
  const result = { success: false, log: "" };
  const logger = (msg) => { result.log += msg + "\n"; };

  logger("🔍 連線測試...");
  if (!SUPABASE_URL) return { success: false, log: "Missing URL" };

  // 嘗試讀取一筆資料做測試
  const url = `${SUPABASE_URL}/rest/v1/user_card_settings?select=user_id&limit=1`;
  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true
    });

    if (res.getResponseCode() === 200) {
      logger("✅ 讀取權限 OK");
      result.success = true;
    } else {
      logger(`❌ 讀取失敗: ${res.getResponseCode()} ${res.getContentText()}`);
    }
  } catch (e) {
    logger(`💥 錯誤: ${e.message}`);
  }
  return result;
}

function apiTestWrite() {
  // 模擬寫入一筆測試資料
  const testId = "TEST_" + new Date().getTime();
  return saveToSupabase(testId, ["TestBank"], { "Test": "Data" }, { displayName: "Tester" });
}

// ==========================================
// 5. 問卷處理 (Survey)
// ==========================================
function handleSurvey(data) {
  try {
    // 改為寫入「用戶建議」分頁
    const sheet = getOrCreateSheet("用戶建議");

    // Headers if empty
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["時間戳記", "使用者 ID", "顯示名稱", "功能許願", "願付價格", "痛點"]);
    }

    const timestamp = new Date();

    // 解析 Markdown 內容
    let wish = "";
    let price = "";
    let pain = "";

    if (data.mdContent) {
      const content = data.mdContent;

      // 簡單的解析邏輯 (根據截圖中的格式)
      // ## 💡 功能許願
      const wishMatch = content.match(/## 💡 功能許願\n([\s\S]*?)(?=\n##|$)/);
      if (wishMatch) wish = wishMatch[1].trim();

      // ## 💰 願付價格
      const priceMatch = content.match(/## 💰 願付價格\n([\s\S]*?)(?=\n##|$)/);
      if (priceMatch) price = priceMatch[1].trim();

      // ## 😣 痛點
      const painMatch = content.match(/## 😣 痛點\n([\s\S]*?)(?=\n##|$)/);
      if (painMatch) pain = painMatch[1].trim();
    }

    // 寫入資料：時間, UserID, 名稱, 功能許願, 願付價格, 痛點
    sheet.appendRow([
      timestamp,
      data.userId,
      data.userName || data.displayName,
      wish,
      price,
      pain
    ]);

    return { success: true, msg: "Survey saved" };
  } catch (e) {
    return { success: false, msg: "Survey Save Error: " + e.toString() };
  }
}


// ==========================================
// 6. 意見回饋模式 (Feedback Chat)
// ==========================================
function saveFeedbackChat(userId, displayName, message) {
  try {
    const sheet = getOrCreateSheet("意見回饋_對話");

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["時間戳記", "使用者 ID", "顯示名稱", "留言內容"]);
    }

    sheet.appendRow([
      new Date(),
      userId,
      displayName,
      message
    ]);
    return true;
  } catch (e) {
    Logger.log("Feedback Chat Save Error: " + e.toString());
    return false;
  }
}

function getOrCreateSheet(name) {
  let ss;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {
    // 忽略錯誤，繼續嘗試從屬性讀取 ID
  }

  // 如果找不到綁定的試算表，嘗試從屬性讀取 ID
  if (!ss) {
    const sheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (sheetId) {
      ss = SpreadsheetApp.openById(sheetId);
    }
  }

  if (!ss) {
    throw new Error("找不到試算表！請在 GAS 專案屬性中設定 'SPREADSHEET_ID'。");
  }

  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}
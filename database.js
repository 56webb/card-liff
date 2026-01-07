// ================= 設定區 (安全版) =================
// 取得指令碼屬性服務 (打開保險箱)
const scriptProperties = PropertiesService.getScriptProperties();

// 從保險箱讀取設定
const LINE_CHANNEL_ID = scriptProperties.getProperty('LINE_CHANNEL_ID');
const SUPABASE_URL = scriptProperties.getProperty('SUPABASE_URL');
const SUPABASE_KEY = scriptProperties.getProperty('SUPABASE_KEY');

// 檢查保險箱是否有東西 (除錯用)
if (!LINE_CHANNEL_ID || !SUPABASE_URL || !SUPABASE_KEY) {
  Logger.log("❌ 錯誤：請先到「專案設定 > 指令碼屬性」設定所有變數！");
}
// ===============================================

function doPost(e) {
  if (!e || !e.postData) return ContentService.createTextOutput("No data received");
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action || "save_settings"; // 預設為儲存
    const idToken = data.idToken;

    // 1. 驗證 ID Token
    const verifyUrl = 'https://api.line.me/oauth2/v2.1/verify';
    const verifyResponse = UrlFetchApp.fetch(verifyUrl, {
      method: 'post',
      payload: { id_token: idToken, client_id: LINE_CHANNEL_ID },
      muteHttpExceptions: true
    });

    if (verifyResponse.getResponseCode() !== 200) {
      const errText = verifyResponse.getContentText();
      Logger.log("LINE Token Verify Error: " + errText);
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        msg: "身分驗證失敗 (LINE): " + errText
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const userId = JSON.parse(verifyResponse.getContentText()).sub;

    const response = action === "get_settings" ?
      { success: true, settings: getFromSupabase(userId) } :
      saveToSupabase(userId, data.myWallet, data.payMap);

    return ContentService.createTextOutput(JSON.stringify(response))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    const errObj = { success: false, msg: "系統錯誤: " + err.toString() };
    return ContentService.createTextOutput(JSON.stringify(errObj))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getFromSupabase(userId) {
  const url = `${SUPABASE_URL}/rest/v1/user_card_settings?user_id=eq.${userId}&select=owned_banks,payment_bindings`;
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
      return {
        myWallet: data[0].owned_banks || [],
        payMap: data[0].payment_bindings || {}
      };
    }
    return null;
  } catch (e) {
    Logger.log("Read Exception: " + e.toString());
    return null;
  }
}

function saveToSupabase(userId, myWallet, payMap) {
  const url = `${SUPABASE_URL}/rest/v1/user_card_settings?on_conflict=user_id`;

  const payload = {
    user_id: userId,
    owned_banks: myWallet,
    payment_bindings: payMap,
    updated_at: new Date().toISOString()
  };

  const options = {
    method: 'post',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      return { success: true };
    } else {
      const serverMsg = res.getContentText() || "(空的回應內容)";
      Logger.log("Supabase Save Error: " + serverMsg);
      return { success: false, msg: "資料庫儲存失敗: " + serverMsg };
    }
  } catch (e) {
    return { success: false, msg: "連線異常 (Exception): " + e.toString() };
  }
}
/**
 * CardWay - AI Credit Card Recommendation Bot (RAG Version)
 * 終極修正版：完全 AI 驅動，支援模糊匹配與全表搜尋備援
 */

const PROPS = PropertiesService.getScriptProperties();
const CHANNEL_ACCESS_TOKEN = PROPS.getProperty('CHANNEL_ACCESS_TOKEN');
const SHEET_ID = PROPS.getProperty('SHEET_ID');
const GEMINI_API_KEY = PROPS.getProperty('GEMINI_API_KEY');

function doPost(e) {
    if (!e || !e.postData) return ContentService.createTextOutput("No post data");
    try {
        const json = JSON.parse(e.postData.contents);
        const events = json.events;
        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            if (event.type === 'message' && event.message.type === 'text') {
                handleMessage(event);
            }
        }
    } catch (e) {
        console.error("doPost Error: " + e.message);
    }
    return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
}

function handleMessage(event) {
    const userText = event.message.text.trim();
    const replyToken = event.replyToken;

    // 1. 檢索資料 (先找特定的項目)
    let relevantRules = searchDetailsFromSheet(userText);
    let contextData = "";

    if (relevantRules.length > 0) {
        // A. 找到具體匹配
        contextData = "【從資料庫找到的相關加碼權益】\n";
        relevantRules.forEach((r, i) => {
            contextData += `${i + 1}. [${r.plan}] ${r.category}: ${r.item}\n`;
            if (r.detail) contextData += `   備註：${r.detail}\n`;
        });
    } else {
        // B. 沒找到直接匹配 (支援打錯字) -> 抓出全表大綱給 AI 去判斷
        const allRules = getAllRulesFromSheet();
        contextData = "【資料庫無直接匹配，以下是該卡片的所有權益大綱，請判斷用戶意圖（如打錯字或模糊詢問）並回答】\n";
        allRules.forEach(r => {
            contextData += `- [${r.plan}] ${r.category}: ${r.item}\n`;
        });
    }

    // 2. 呼叫 Gemini AI
    const aiReply = callGemini(userText, contextData);

    // 3. 回覆 LINE
    replyLine(replyToken, [{ type: 'text', text: aiReply }]);
}

function searchDetailsFromSheet(keyword) {
    if (!SHEET_ID) return [];
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Rules');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    data.shift(); // 移除標題
    const normK = keyword.toLowerCase().replace(/[\s\-]/g, '');

    return data.filter(row => {
        const category = String(row[1]).toLowerCase().replace(/[\s\-]/g, '');
        const item = String(row[2]).toLowerCase().replace(/[\s\-]/g, '');
        const detail = String(row[3]).toLowerCase().replace(/[\s\-]/g, '');
        return category.includes(normK) || item.includes(normK) || detail.includes(normK);
    }).map(row => ({ plan: row[0], category: row[1], item: row[2], detail: row[3] }));
}

function getAllRulesFromSheet() {
    if (!SHEET_ID) return [];
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Rules');
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    data.shift();
    // 簡化大綱節省 Token
    return data.map(row => ({ plan: row[0], category: row[1], item: row[2] }));
}

function callGemini(question, contextData) {
    if (!GEMINI_API_KEY) return "系統錯誤：未設定 GEMINI_API_KEY";

    const modelName = 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `你是一位專業的信用卡理財顧問。請根據下方的【已知資訊】回答用戶的問題。

【已知資訊】(來源：國泰世華 CUBE 卡最新官網權益)：
"""
${contextData}
"""

【用戶問題】：
"${question}"

【回答要求】：
0. 要判斷客戶的餐廳是否在飯店內，要確認是否特例。
1. 直接給出結論（刷哪個方案最划算並列出％數）。
2. 如果用戶可能打錯字（例如將「全聯」打成「全連」），請主動修正並根據【已知資訊】給出正確建議。
3. 如果資訊中真的找不到對應項目，請告知這可能僅適用「一般消費 (0.3%回饋)」並提醒用戶這張卡規則複雜，提供資訊僅供參考一切以官網為主https://www.cathay-cube.com.tw/cathaybk/personal/product/credit-card/cards/cube-list。
4. 使用台灣繁體中文，語氣親切專業。
5. 字數限制在150字內`;

    const payload = { "contents": [{ "parts": [{ "text": prompt }] }] };
    const params = {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
    };

    try {
        const res = UrlFetchApp.fetch(url, params);
        const code = res.getResponseCode();
        const body = res.getContentText();
        if (code !== 200) return `AI 連線失敗 (Code ${code})。請檢查 API Key 或配額。`;
        const json = JSON.parse(body);
        return json.candidates[0].content.parts[0].text;
    } catch (e) {
        return `系統錯誤：${e.message}`;
    }
}

function replyLine(replyToken, messages) {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'post',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
        payload: JSON.stringify({ replyToken: replyToken, messages: messages }),
        muteHttpExceptions: true
    });
}

// --- 測試用函式：請執行這個來檢查設定 ---
function debugSettings() {
  const props = PropertiesService.getScriptProperties();
  const channelId = props.getProperty('LINE_CHANNEL_ID');
  const sbUrl = props.getProperty('supabase_URL');
  const sbKey = props.getProperty('service_role_Key');

  Logger.log("=== 設定檢查開始 ===");
  
  if (channelId) {
    Logger.log("✅ LINE_CHANNEL_ID: 讀取成功 (長度: " + channelId.length + ")");
  } else {
    Logger.log("❌ LINE_CHANNEL_ID: 讀取失敗！(是 null)");
  }

  if (sbUrl) {
    Logger.log("✅ supabase_URL: 讀取成功 (" + sbUrl + ")");
  } else {
    Logger.log("❌ supabase_URL: 讀取失敗！");
  }

  if (sbKey) {
    Logger.log("✅ service_role_Key: 讀取成功 (前五碼: " + sbKey.substring(0, 5) + "...)");
  } else {
    Logger.log("❌ service_role_Key: 讀取失敗！");
  }
  
  Logger.log("=== 設定檢查結束 ===");
}
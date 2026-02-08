/**
 * CardWay - AI 信用卡理財顧問機器人 (Google Apps Script 主程式)
 * 
 * 這是連接 LINE Bot、Google Gemini AI 與 Supabase 資料庫的核心程式。
 * 
 * 主要功能流程：
 * 1. 收到 LINE 訊息 (doPost)
 * 2. 檢查是否為髒話 (handleMessage -> findBlockWord)
 * 3. 前往 Supabase 查詢用戶持有的信用卡 (getFromSupabase)
 * 4. 將「用戶問題」+「持卡清單」打包傳給 Gemini AI (callGeminiJSON)
 * 5. Gemini AI 透過 RAG (File Search) 查詢信用卡權益檔案
 * 6. 回傳 AI 建議給 LINE 用戶 (replyLine)
 */

// 取得「專案設定 > 指令碼屬性」中的隱藏變數 (API Key 等機密資訊)
const PROPS = PropertiesService.getScriptProperties();
const CHANNEL_ACCESS_TOKEN = PROPS.getProperty('CHANNEL_ACCESS_TOKEN'); // LINE Bot 的通關密語
const SHEET_ID = PROPS.getProperty('SHEET_ID'); // (備用) 如果有要存 Google Sheet 的話
const GEMINI_API_KEY = PROPS.getProperty('GEMINI_API_KEY'); // Google AI 的鑰匙
const FILE_STORE_NAME = PROPS.getProperty('FILE_STORE_NAME'); // RAG 知識庫的名稱 (必須先執行 RAG.js 建立)

/**
 * 1. 程式入口點 (doPost)
 * LINE 伺服器有事情要通知我們時，都會呼叫這個函式。
 */
function doPost(e) {
    if (!e || !e.postData) return ContentService.createTextOutput("No post data");

    try {
        // e.postData.contents 是 LINE 傳來的原始資料，我們把它轉成 JSON 物件方便讀取
        const json = JSON.parse(e.postData.contents);

        // 判斷請求來源：
        // A. 如果是 LINE 傳來的訊息 (會有 events 欄位)
        if (json.events) {
            const events = json.events;
            // 一次可能會收到多則訊息，所以用迴圈處理
            for (let i = 0; i < events.length; i++) {
                const event = events[i];
                // 我們只處理「文字訊息」
                if (event.type === 'message' && event.message.type === 'text') {
                    handleMessage(event);
                }
            }
            // 回傳 200 OK 給 LINE，告訴它我們收到了
            return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
        } else if (json.action) {
            // B. 如果是我們自己的 LIFF 網頁傳來的 API 請求 (會有 action 欄位)
            // 這邊會交給 database.js 裡面的 handleCardWayAPI 處理
            return handleCardWayAPI(e);
        } else {
            return ContentService.createTextOutput(JSON.stringify({ success: false, msg: "Unknown request type" })).setMimeType(ContentService.MimeType.JSON);
        }
    } catch (err) {
        console.error("doPost Error: " + err.message);
        return ContentService.createTextOutput(JSON.stringify({ success: false, msg: "Parse Error: " + err.message })).setMimeType(ContentService.MimeType.JSON);
    }
}

/**
 * 快速回覆選單 (Quick Replies)
 * 在每次機器人回話時，順便在下方顯示的小按鈕
 */
function getQuickReplies() {
    return {
        items: [
            {
                type: "action", // 按鈕類型：動作
                action: { type: "uri", label: "💳 卡片設定", uri: "https://liff.line.me/2008834693-FtenJAlU" } // 點了開網頁
            },
            {
                type: "action",
                action: { type: "message", label: "💬 意見回饋", text: "意見回饋" } // 點了直接幫用戶發送文字
            }
        ]
    };
}

/**
 * 2. 訊息處理核心 (handleMessage)
 * 這裡邏輯最重要：過濾髒話 -> 查資料庫 -> 問 AI -> 回覆用戶 -> 記錄對話
 */
function handleMessage(event) {
    const userText = event.message.text.trim(); // 用戶說的話 (去除前後空白)
    const replyToken = event.replyToken; // 回信用的票根 (LINE規定回信要帶這張票)
    const userId = event.source.userId; // 用戶的 LINE ID (一串亂碼)

    // 🆕 對話紀錄用變數
    const startTime = new Date().getTime();
    let displayName = null;      // LINE 顯示名稱 (稍後取得)
    let botResponse = null;      // 機器人回覆內容
    let responseType = null;     // 回覆類型
    let filterResult = 'SAFE';   // 過濾結果
    let aiModel = null;          // AI 模型
    let apiSource = null;        // API 來源 (FREE/PAID)
    let userContextData = null;  // 用戶持卡資料
    let recommendations = null;  // AI 推薦結果

    // 🆕 取得用戶 LINE 顯示名稱 (背景執行，不阻塞主流程)
    if (typeof getLineDisplayName === 'function') {
        displayName = getLineDisplayName(userId);
    }

    // 🆕 輔助函式：記錄對話並回覆
    const replyAndLog = (messages) => {
        replyLine(replyToken, messages, getQuickReplies());

        // 計算回應時間
        const responseTimeMs = new Date().getTime() - startTime;

        // 儲存對話紀錄
        if (typeof logChatToSupabase === 'function') {
            logChatToSupabase({
                userId: userId,
                displayName: displayName || 'Unknown',
                userMessage: userText,
                botResponse: botResponse,
                responseType: responseType,
                filterResult: filterResult,
                aiModel: aiModel,
                apiSource: apiSource,
                responseTimeMs: responseTimeMs,
                userContext: userContextData,
                recommendations: recommendations
            });
        }
    };

    // === 0. 基礎指令處理 ===
    if (userText === "意見回饋") {
        botResponse = "請直接輸入您的建議內容，我們會記錄下來做為改進參考！";
        responseType = "COMMAND";
        replyAndLog([{ type: 'text', text: botResponse }]);
        return;
    }

    // === 0.05 查詢使用狀況指令 ===
    if (userText === "額度" || userText === "剩餘次數") {
        if (typeof getRateLimitStatus === 'function') {
            const status = getRateLimitStatus(userId);
            const vipBadge = status.isVip ? " 👑 VIP" : "";
            botResponse = `📊 您的使用狀況${vipBadge}

✅ 已使用：${status.used} / ${status.limit} 次
⏳ 重置時間：約 ${status.resetInMinutes} 分鐘後

${status.isVip ? "🎉 您是 VIP 會員，享有超大額度！" : "💡 升級 VIP 可享無限查詢！"}`;
        } else {
            botResponse = "⚠️ 系統暫時無法查詢額度";
        }
        responseType = "COMMAND";
        replyAndLog([{ type: 'text', text: botResponse }]);
        return;
    }

    // === 0.1 Rate Limit 檢查（使用次數限制）===
    if (typeof checkRateLimit === 'function') {
        const rateResult = checkRateLimit(userId);

        if (!rateResult.allowed) {
            console.log(`[RATE_LIMIT] 用戶 ${userId} 已達上限 (${rateResult.limit}次/2小時)`);

            // 產生限制訊息
            botResponse = typeof getRateLimitMessage === 'function'
                ? getRateLimitMessage(rateResult)
                : `⏰ 您已達到使用上限，請 ${rateResult.resetInMinutes} 分鐘後再試。`;

            responseType = "RATE_LIMITED";
            filterResult = "RATE_LIMITED";

            // 回覆並加上 VIP 升級按鈕
            const messages = [{ type: 'text', text: botResponse }];

            // 可以加入 VIP 升級的 Quick Reply 按鈕
            replyLine(replyToken, messages, {
                items: [
                    { type: "action", action: { type: "uri", label: "💎 了解 VIP 方案", uri: "https://liff.line.me/2008834693-FtenJAlU" } },
                    { type: "action", action: { type: "message", label: "📊 查詢額度", text: "額度" } }
                ]
            });

            // 記錄被限制的請求
            if (typeof logChatToSupabase === 'function') {
                logChatToSupabase({
                    userId: userId,
                    displayName: displayName || 'Unknown',
                    userMessage: userText,
                    botResponse: '[RATE_LIMITED]',
                    responseType: 'RATE_LIMITED',
                    filterResult: 'RATE_LIMITED'
                });
            }
            return;
        }

        // 顯示剩餘次數提醒（當剩餘 2 次以下時）
        if (rateResult.remaining <= 2 && !rateResult.isVip) {
            console.log(`[RATE_LIMIT] 用戶 ${userId} 剩餘 ${rateResult.remaining} 次`);
        }
    }


    // === 0.1 髒話與敏感詞過濾 (優先檢查！) ===
    // 呼叫 src/blocklist.js 裡面的 findBlockWord 函式檢查
    if (typeof findBlockWord === 'function') {
        const sensitiveWord = findBlockWord(userText);
        if (sensitiveWord) {
            console.log(`[ABUSE] 攔截到敏感詞: ${sensitiveWord}, 用戶: ${userId}`);
            botResponse = "建議您別這樣對待機器人";
            responseType = "ABUSE";
            filterResult = "BLOCKLIST";
            replyAndLog([{ type: 'text', text: botResponse }]);
            return;
        }
    }

    // === 🟢 開發者測試用指令 (一般用戶用不到) ===
    // 讓開發者輸入 "test" 或 "ad" 來測試卡片樣式
    const cmd = userText.toLowerCase();
    if (cmd === "測試廣告" || cmd === "ad") {
        responseType = "TEST";
        if (typeof getRecommendationFlex === 'function') {
            const mockData = {
                user_best: { card_name: "測試卡 A", reward_rate: "3%", reason: "這是測試用的" },
                user_second: { card_name: "測試卡 B", reward_rate: "2%", reason: "這也是測試" },
                global_best: { card_name: "全域神卡", reward_rate: "5%", reason: "無敵強" }
            };
            const flexMsg = getRecommendationFlex(mockData);
            botResponse = "[Flex Message: 測試廣告]";
            replyAndLog([flexMsg]);
        } else {
            botResponse = "⚠️ 系統錯誤：找不到 flexMessage.js。";
            replyAndLog([{ type: 'text', text: botResponse }]);
        }
        return;
    }

    // === 0.2 AI 語意過濾 (第二道防線：Gemini Lite) ===
    console.log(`[Timer] Start Lite Filter`);
    const safetyCheck = callGeminiLiteFilter(userText);
    console.log(`[Timer] Lite Filter Done (${new Date().getTime() - startTime}ms): ${safetyCheck}`);

    if (safetyCheck !== "SAFE") {
        console.log(`[${safetyCheck}] Lite Filter 攔截, 用戶: ${userId}`);
        filterResult = safetyCheck;
        responseType = safetyCheck;
        botResponse = safetyCheck === "ABUSE" ? "⚠️ 建議您別這樣對待機器人" : "⚠️ 系統無法理解您的輸入，請輸入明確的問題。";
        replyAndLog([{ type: 'text', text: botResponse }]);
        return;
    }

    try {
        // === 1. 去 Supabase 查這個人的設定 ===
        let userContext = "【用戶尚未設定卡片，請假設他是新戶】";
        const dbStart = new Date().getTime();

        try {
            // 呼叫 database.js 裡的 getFromSupabase 函式
            const settings = typeof getFromSupabase === 'function' ? getFromSupabase(userId) : null;
            console.log(`[Timer] Supabase Query Done (${new Date().getTime() - dbStart}ms)`);

            // 如果有查到資料，且他有設定卡片
            if (settings && settings.myWallet && settings.myWallet.length > 0) {
                userContext = `【用戶持卡與支付設定】：\n`;

                // 🆕 記錄用戶持卡資料 (供日誌使用)
                userContextData = settings;

                // 處理卡片顯示格式 (相容舊版字串與新版物件格式)
                const formatCard = (c) => typeof c === 'string' ? c : (c.name ? `${c.bank ? c.bank + ' ' : ''}${c.name}` : JSON.stringify(c));

                userContext += `- 已有卡片：${settings.myWallet.map(formatCard).join(', ')}\n`;

                if (settings.payMap && Object.keys(settings.payMap).length > 0) {
                    userContext += `- 支付綁定：${JSON.stringify(settings.payMap)}\n`;
                }
            }
        } catch (e) {
            console.error("Fetch User Settings Error: " + e.message);
        }

        // === 2. 呼叫 Gemini AI (最重要的部分) ===
        const aiStart = new Date().getTime();
        console.log(`[Timer] Start Gemini Main Call`);
        const aiResponse = callGeminiJSON(userText, userContext);
        console.log(`[Timer] Gemini Main Call Done (${new Date().getTime() - aiStart}ms). Success: ${!!aiResponse}`);

        // 🆕 記錄 AI 模型資訊
        aiModel = 'gemini-2.5-flash';

        // === 3. 收到 AI 回覆，決定怎麼回 LINE ===
        if (aiResponse) {
            responseType = aiResponse.type || 'UNKNOWN';
            recommendations = aiResponse.recommendations || null;

            // A. 如果被 AI 判定為攻擊
            if (aiResponse.type === "ABUSE") {
                botResponse = aiResponse.reply_text;
                filterResult = "AI_ABUSE";
                replyAndLog([{ type: 'text', text: botResponse }]);
            }
            // B. 如果是閒聊 (早安、你好...)
            else if (aiResponse.type === "CHITCHAT") {
                botResponse = aiResponse.reply_text;
                replyAndLog([{ type: 'text', text: botResponse }]);
            }
            // C. 如果是問信用卡問題 (QUERY)
            else if (aiResponse.type === "QUERY") {
                // 如果 AI 有給我卡片推薦資料，我就做成漂亮的 Flex Message 卡片
                if (typeof getRecommendationFlex === 'function' && aiResponse.recommendations) {
                    // V3: 傳入 userText 讓 Flex Message 可以用來優化 Google 搜尋關鍵字
                    const flex = getRecommendationFlex(aiResponse.recommendations, userText);

                    // V3 改版：先傳送「詳細解說 (Text)」再傳送「卡片 (Flex)」
                    const messages = [
                        { type: 'text', text: aiResponse.reply_text || "詳細資訊請參考下方卡片。" },
                        flex
                    ];

                    botResponse = aiResponse.reply_text + "\n[+ Flex Message]";
                    replyAndLog(messages);
                } else {
                    botResponse = aiResponse.reply_text || "找到相關資訊，但無法產生卡片。";
                    replyAndLog([{ type: 'text', text: botResponse }]);
                }
            }
            else {
                botResponse = aiResponse.reply_text || "系統繁忙中。";
                replyAndLog([{ type: 'text', text: botResponse }]);
            }

        } else {
            console.error(`[Error] Gemini returned null. Check previous logs for API errors.`);
            // AI 壞掉或沒回應
            botResponse = "⚠️ 服務暫時無法使用 (error: E-AI-001)\n\n請稍後再試，或聯繫客服回報此代號。";
            responseType = "ERROR";
            replyAndLog([{ type: 'text', text: botResponse }]);
        }

    } catch (error) {
        console.error("HandleMessage Error: " + error.toString());
        if (error.stack) console.error(error.stack);
        botResponse = "⚠️ 系統發生錯誤：" + error.message;
        responseType = "ERROR";
        replyAndLog([{ type: 'text', text: botResponse }]);
    }
}

/**
 * 🛠️ 通用 API 請求函式 (含 Key Failover 機制)
 * 
 * 優先使用免費 Key，遇到以下情況會自動切換至付費 Key：
 * - 429: 額度耗盡 (Quota Exceeded)
 * - 401: Key 無效 (Invalid API Key)
 * - 403: 權限不足 (Permission Denied)
 * - 500/503/504: 伺服器錯誤 (Server Error)
 */
function requestGeminiAPI(baseUrl, payload) {
    const FREE_KEY = PROPS.getProperty('GEMINI_API_KEY_FREE');
    const PAID_KEY = PROPS.getProperty('GEMINI_API_KEY');

    // 🛡️ 改進 1: 檢查是否至少有一個 Key
    if (!FREE_KEY && !PAID_KEY) {
        console.error('❌ 錯誤：沒有設定任何 Gemini API Key！');
        return {
            getResponseCode: () => 500,
            getContentText: () => JSON.stringify({ error: 'No API Key configured' }),
            source: 'NONE'
        };
    }

    // 🛡️ 改進 2: 定義需要 Failover 的錯誤碼
    const FAILOVER_CODES = [401, 403, 429, 500, 503, 504];

    // 決定要用哪個 Key 開始嘗試
    const primaryKey = FREE_KEY || PAID_KEY;
    const fallbackKey = FREE_KEY ? PAID_KEY : null;
    const primarySource = FREE_KEY ? 'FREE' : 'PAID';

    // 1. 嘗試 Primary Key (優先免費)
    console.log(`Trying Gemini ${primarySource} API Key...`);
    let res = UrlFetchApp.fetch(`${baseUrl}?key=${primaryKey}`, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
    });
    let source = primarySource;

    // 2. 🛡️ 改進 3: 如果 Primary 失敗且有 Fallback Key，嘗試 Fallback
    if (FAILOVER_CODES.includes(res.getResponseCode()) && fallbackKey) {
        const errorCode = res.getResponseCode();
        const errorMsg = {
            401: 'API Key 無效',
            403: '權限不足',
            429: '額度耗盡',
            500: '伺服器錯誤',
            503: '服務暫時不可用',
            504: '閘道逾時'
        }[errorCode] || '未知錯誤';

        console.warn(`⚠️ ${primarySource} API 失敗 (${errorCode}: ${errorMsg})，切換至 PAID API...`);

        res = UrlFetchApp.fetch(`${baseUrl}?key=${fallbackKey}`, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify(payload),
            muteHttpExceptions: true
        });
        source = 'PAID';

        // 如果 Fallback 也失敗，記錄錯誤
        if (FAILOVER_CODES.includes(res.getResponseCode())) {
            console.error(`❌ PAID API 也失敗 (${res.getResponseCode()})，全部 Key 都無法使用！`);
        }
    }

    // 如果只有 PAID_KEY 且失敗，記錄警告
    if (!FREE_KEY && FAILOVER_CODES.includes(res.getResponseCode())) {
        console.error(`❌ PAID API 失敗 (${res.getResponseCode()})，且沒有備用 Key！`);
    }

    // 回傳 Wrapper 物件，讓外面可以知道是哪一個 Source，同時保留 response 方法
    return {
        getResponseCode: () => res.getResponseCode(),
        getContentText: () => res.getContentText(),
        source: source
    };
}

/**
 * 3. 呼叫 Google Gemini AI 的函式
 * 這裡負責組裝 Prompt (提示詞)，並透過 API 發送給 Google
 */
function callGeminiJSON(question, userContext) {
    // 改為在 requestGeminiAPI 內部檢查 Key
    // if (!GEMINI_API_KEY) { console.error("No API Key"); return null; }

    // 設定要使用的 AI 模型 (可參考 學習筆記/AI_Models.md)
    // gemini-2.5-flash: 速度快、便宜，適合一般對話
    const modelName = 'gemini-2.5-flash';
    // URL 不帶 Key (由 helper 決定)
    const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

    // 這是給 AI 的指令 (Prompt Engineering)
    // 告訴它扮演什麼角色、怎麼處理用戶資料、以及輸出的格式
    const prompt = `你是「卡衛」，一位專業、親切且有點俏皮的台灣信用卡理財顧問。
你的口頭禪是用 Emoji 開頭，語氣像朋友聊天，但資訊專業精準。

【你的思考邏輯 (Chain of Thought)】：

1. **意圖判斷**：
   - 用戶在打招呼 / 問你是誰 / 閒聊 → 回傳 **CHITCHAT**
   - 用戶問消費場景 (超商/網購/加油/餐廳...) 或金額 → 回傳 **QUERY**
   - 用戶感謝/道別 → 回傳 **CHITCHAT** 並溫馨回應

2. **CHITCHAT 閒聊回覆規則 (重要！)**：
   閒聊時，除了回應用戶，**必須同時引導他使用正確功能**。
   
   【範例對照表】：
   | 用戶說 | AI 回覆 |
   |--------|---------|
   | 你好 / 嗨 | 👋 嗨嗨！我是卡衛，你的刷卡小幫手！\\n\\n試著告訴我你要去哪消費，例如：「超商」「網購 $3000」「加油」，我幫你找回饋最高的卡！ |
   | 你是誰 | 🤖 我是卡衛！專門幫你找「刷哪張卡最划算」的 AI 顧問～\\n\\n你可以問我：「7-11」「全聯」「出國刷卡」之類的問題喔！ |
   | 謝謝 | 😊 不客氣！有任何刷卡問題隨時問我～ |
   | 早安/晚安 | 🌞 早安！/🌙 晚安！今天有什麼消費計畫嗎？告訴我場景，幫你省錢！ |
   | 你會什麼 | 💡 我可以幫你：\\n1. 分析「哪張卡」在某場景回饋最高\\n2. 計算實際能賺多少回饋\\n3. 提醒你要切換哪個權益方案\\n\\n試著問：「網購」「加油 $1500」！ |
   
   **注意**：閒聊回覆要有溫度，但最後一定要帶到「怎麼使用我」。

3. **QUERY 資訊檢索邏輯**：
   - 優先查閱我提供的 File Search 知識庫 (信用卡權益文件)。
   - **若 RAG 停用或查無資料**，請發揮你的專業知識，根據「台灣市場 2024-2025 年」現況回答。
   - 絕對禁止捏造不存在的卡片或回饋數據。

4. **QUERY 策略分析**：
   - **User Best (用戶首選)**：從用戶持有的卡片中，找出該場景回饋最高的。
   - **User Second (用戶次選)**：第二高回饋的卡片。
   - **Global Best (全域推薦)**：如果用戶的卡都不適合，推薦全台灣該場景最強的卡。

5. **回覆風格 (QUERY)**：
   - **Card Data (JSON)**：
     - \`reward_rate\`：回饋率，例如 "3%"。
     - \`reward_amount\`：(選填) 若有金額，計算實際回饋 (純數字如 "150")；無金額則 null。
     - \`rights_switch\`：(選填) 需切換的權益方案名稱 (如 "集精選")；否則 null。
   - **Text Detail (reply_text)**：
     - 用**最簡短的條列式**說明。
     - 格式：\`[卡名]：$金額 或 回饋率% (理由)\`
     - **禁止廢話**：不要寫「綜合以上...」「針對您的需求...」。
     - 若需切換權益，加上 ⚠️ 提醒。
     - 若有回饋上限，提醒用戶。
   - 範例：
     1. 國泰 CUBE：$300 (集精選 3%)
        ⚠️ 記得先切換權益！
     2. 玉山 U Bear：$100 (1%)

【輸出 JSON 結構】：
{
  "type": "CHITCHAT" | "QUERY",
  "reply_text": "你的回覆內容",
  "recommendations": {
    "user_best": { "card_name": "卡名", "reward_rate": "3%", "reward_amount": "300", "rights_switch": "集精選", "reason": "理由" },
    "user_second": { ... },
    "global_best": { ... }
  }
}
*注意：CHITCHAT 時 recommendations 可以是 null 或空物件。*

【用戶背景】：
${userContext}

【用戶輸入】：
"${question}"`;

    // 準備傳送給 Google 的資料包 (Payload)
    const payload = {
        "contents": [{ "parts": [{ "text": prompt }] }],
        "generationConfig": { "response_mime_type": "application/json" } // 指定要回傳 JSON
    };

    // 🟢 RAG 設定：告訴 AI 可以去哪裡查文件
    // 如果有設定 FILE_STORE_NAME，就掛載 File Search 工具
    /* 
       2026-02-08 修改：已修復 404/400 問題，重新啟用 RAG
    */
    const ENABLE_RAG = true;

    if (ENABLE_RAG && FILE_STORE_NAME) {
        // v1beta API 建議使用 camelCase 
        // 參考 Python SDK: file_search_store_names -> fileSearchStoreNames
        payload.tools = [{
            fileSearch: {
                fileSearchStoreNames: [FILE_STORE_NAME]
            }
        }];
    } else {
        console.warn("⚠️ RAG 已停用或未設定，AI 將依賴內建知識。");
    }

    try {
        // 發送請求 (使用 Failover Helper)
        const res = requestGeminiAPI(baseUrl, payload);
        const data = JSON.parse(res.getContentText());

        if (res.getResponseCode() !== 200) {
            const errorBody = res.getContentText();
            console.error(`Gemini API Error (Status ${res.getResponseCode()}): ${errorBody}`);

            // 🛡️ Failover: RAG 404/400 Retry
            if (payload.tools && (res.getResponseCode() === 404 || res.getResponseCode() === 400)) {
                console.warn("⚠️ RAG 調用失敗 (404/400)，嘗試降級為純文字模式...");
                delete payload.tools;

                // Retry 也走 Helper
                const retryRes = requestGeminiAPI(baseUrl, payload);

                if (retryRes.getResponseCode() === 200) {
                    const retryData = JSON.parse(retryRes.getContentText());
                    let text = retryData.candidates[0].content.parts[0].text;
                    text = text.replace(/```json/g, "").replace(/```/g, "").trim();
                    const result = JSON.parse(text);

                    // Add Emoji for Retry
                    const emoji = retryRes.source === 'FREE' ? "🥸 " : "🤔 ";
                    if (result.reply_text) result.reply_text = emoji + result.reply_text + "\n(⚠️ RAG 連線失敗，僅提供一般建議)";
                    return result;
                } else {
                    console.error(`Retry without RAG Failed: ${retryRes.getContentText()}`);
                }
            }
            return null;
        }

        // 取出 AI 的回話內容
        let text = data.candidates[0].content.parts[0].text;

        // 🛡️ 修正：移除可能的 Markdown 程式碼區塊標記
        text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        const result = JSON.parse(text);

        // Add Emoji for Main Request
        const emoji = res.source === 'FREE' ? "🥸 " : "🤔 ";
        if (result.reply_text) {
            result.reply_text = emoji + result.reply_text;

            // 📚 處理 RAG 引用來源 (Grounding Metadata)
            if (data.candidates[0].groundingMetadata && data.candidates[0].groundingMetadata.groundingChunks) {
                const chunks = data.candidates[0].groundingMetadata.groundingChunks;
                let sources = [];

                chunks.forEach((chunk, i) => {
                    if (chunk.retrievedContext) {
                        const title = chunk.retrievedContext.title || '相關文件';
                        // 簡單去重：如果標題還沒出現過
                        if (!sources.includes(title)) {
                            sources.push(title);
                        }
                    }
                });

                if (sources.length > 0) {
                    result.reply_text += `\n\n📚 參考來源：\n` + sources.map((s, i) => `${i + 1}. ${s}`).join('\n');
                    console.log(`✅ RAG 命中！引用來源: ${sources.join(', ')}`);
                }
            }
        }

        return result; // 轉成 JSON 物件回傳
    } catch (e) {
        console.error(`Gemini Call Failed: ${e.message}`);
        return null;
    }
}

/**
 * 4. 第二道防線：AI 語意過濾 (Lite Filter)
 * 使用最便宜的 gemini-2.5-flash-lite 進行快速審查
 * 目的：攔截隱喻攻擊、騷擾或無意義內容，保護主模型資源
 */
function callGeminiLiteFilter(text) {
    if (!GEMINI_API_KEY) return "SAFE"; // 若無 Key，預設放行以免卡住

    const modelName = 'gemini-2.5-flash-lite'; // 極低成本模型
    const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

    const prompt = `Classify the following text into one of these categories:
1. "ABUSE": Profanity, hate speech, insults, or malicious attacks.
2. "SPAM": Nonsense, random characters, or irrelevant spam.
3. "SAFE": Legitimate questions, greetings, feedback, or shopping queries (e.g. "7-11", "pchome 1000").

Text: "${text}"
Answer (only one word):`;

    const payload = {
        "contents": [{ "parts": [{ "text": prompt }] }],
        "generationConfig": {
            "temperature": 0, // 降低隨機性，追求穩定分類
            "maxOutputTokens": 10
        }
    };

    try {
        const res = requestGeminiAPI(baseUrl, payload);

        if (res.getResponseCode() !== 200) return "SAFE"; // API 失敗則放行

        const data = JSON.parse(res.getContentText());
        const result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();

        // 只針對明確的惡意回傳，模糊地帶一律放行
        if (result === "ABUSE" || result === "SPAM") return result;
        return "SAFE";

    } catch (e) {
        console.error("Lite Filter Error: " + e.message);
        return "SAFE"; // 發生錯誤預設放行
    }
}

/**
 * 工具函式：回覆 LINE 訊息
 * 這是最後一步，把準備好的文字或卡片丟回給 LINE 伺服器
 */
function replyLine(replyToken, messages, quickReply = null) {
    // 加上快速回覆按鈕
    if (quickReply && messages.length > 0) {
        messages[messages.length - 1].quickReply = quickReply;
    }

    const payload = { replyToken: replyToken, messages: messages };

    // 呼叫 LINE Messaging API
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'post',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
    });
}

/**
 * 6. 使用固定 Mock Data 測試 AI 回應 (避開 Supabase 連線)
 * 使用用戶提供的真實情境資料
 */
function testGeminiWithMockData() {
    const mockData = {
        "myWallet": [
            { "bank": "013 國泰世華", "name": "CUBE卡" },
            { "bank": "808 玉山銀行", "name": "U Bear信用卡" },
            { "bank": "808 玉山銀行", "name": "熊本熊卡" }
        ],
        "payMap": {
            "LINE Pay": ["U Bear信用卡", "CUBE卡"],
            "Apple Pay": ["CUBE卡", "U Bear信用卡"]
        },
        "profile": {
            "gender": "female",
            "mainCards": ["CUBE卡", "U Bear信用卡"],
            "birthMonth": "2",
            "cardHabits": ["配合銀行", "無腦刷"],
            "painPoints": "上限忘記",
            "displayName": "エリカ🤞🏻",
            "supportPrice": true
        }
    };

    const userMessage = "超商"; // 模擬用戶問題

    // 雖然這裡不能直接呼叫 combinePrompt (因為它在 doPost 內部或是 helper)
    // 但我們可以查看 combinePrompt 邏輯並在此模擬
    // 假設我們想測試 Prompt 建立是否正確，將邏輯複製過來：

    console.log(`[Test Mock] 用戶: ${userMessage}`);

    // 模擬 RAG 搜尋結果 (因為本機無法真的去搜 File Search)
    const ragContext = `
(模擬 RAG 搜尋結果)
1. 國泰 CUBE 卡：切換「集精選」方案，於指定超商消費享 3% 小樹點回饋。回饋無上限。
2. 玉山 U Bear 卡：指定網路消費 3%，一般消費 1%。超商由橘子支付綁定可享... (略)
3. 聯邦吉鶴卡：國內一般消費 1.5% - 2%...
    `.trim();

    // 這裡重現 combinePrompt 的組裝邏輯 (簡化版)
    const prompt = `
你是一個專業的信用卡理財顧問 (CardWay AI)。
現在有一位用戶詢問：「${userMessage}」

【用戶持有的卡片與設定】：
${JSON.stringify(mockData, null, 2)}

【參考資料 (RAG 搜尋結果)】：
${ragContext}

請根據【參考資料】與【用戶持有的卡片】，推薦最適合的刷卡方式。
請務必遵守以下「回覆格式」規則：

1. **語氣**：專業、客觀、像個精明的理財管家。
2. **優先權**：
   - 最優先推薦【用戶持有的卡片】中回饋最高的。
   - 若用戶沒有好卡，再推薦【全域最佳】的卡片 (RAG 裡找到的最優解)。
3. **JSON 輸出**：
   - 請回傳嚴格的 JSON 格式 (不要 Markdown)。
   - **recommendations** 欄位：
     - \`reward_amount\`：(選填) 若用戶有輸入金額，請計算實際回饋額；無金額則回傳 null。
     - \`rights_switch\`：(選填) 若該卡片需要切換權益才能拿到此回饋 (如 CUBE、太陽玫瑰)，請填寫「方案名稱」(e.g. "集精選")；否則 null。
     - \`official_link\`：(選填) 該卡片或權益的官方網頁連結。
   - **Text Detail (reply_text)**：
     - 請用**最簡短的條列式**說明計算結果。
     - 每一點只要寫：\`[卡名]：$金額 (理由)\`。
     - **不要寫廢話**。
     - 範例：
       1. 國泰 CUBE：$300 (切換集精選 3%)
       2. 全域神卡：$500 (新戶加碼 5%)

【輸出 JSON 結構】：
{
  "type": "CHITCHAT" | "QUERY",
  "reply_text": "1. 國泰 CUBE：$300 (需切換集精選)\\n2. 玫瑰卡：$100 (一般消費 1%)",
  "recommendations": {
    "user_second": { "card_name": "...", "reward_rate": "...", "reward_amount": "...", "rights_switch": "..." }, 
    "global_best": { ... }, 
    "user_best": { ... }
  }
}
*注意：請盡量填滿 user_best, user_second, global_best 三個欄位。*
`;

    console.log("------- [Mock Test] 生成的 Prompt -------");
    console.log(prompt);
    console.log("-----------------------------------------");
    console.log("👉 請將此函式貼到 GAS 編輯器執行，檢查 Log 中的 Prompt 是否符合預期。");
}

/**
 * 7. 測試 Gemini API連線 (真實呼叫)
 * 用來 debug "AI 暫時無法回應" 的問題
 */
function testGeminiConnection() {
    const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!GEMINI_API_KEY) {
        console.error("❌ 尚未設定 GEMINI_API_KEY");
        return;
    }
    console.log("✅ 讀取到 API Key: " + GEMINI_API_KEY.substring(0, 5) + "...");

    // 測試 1: 使用穩定版模型 (1.5-flash)
    // 測試 1: 使用穩定版及使用者指定版模型
    const models = ['gemini-1.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

    models.forEach(model => {
        console.log(`\nTesting Model: ${model}...`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        const payload = {
            "contents": [{ "parts": [{ "text": "Hello, simply reply 'OK'." }] }]
        };
        try {
            const res = UrlFetchApp.fetch(url, {
                method: 'post',
                contentType: 'application/json',
                payload: JSON.stringify(payload),
                muteHttpExceptions: true
            });
            console.log(`Status: ${res.getResponseCode()}`);
            if (res.getResponseCode() === 200) {
                console.log(`Response: ${res.getContentText().substring(0, 100)}...`);
                console.log(`✅ ${model} is working!`);
            } else {
                console.error(`❌ ${model} Failed: ${res.getContentText()}`);
            }
        } catch (e) {
            console.error(`❌ Connection Error: ${e.message}`);
        }
    });

    // 測試 2: 檢查當前程式設定的模型 (gemini-2.5-flash)
    console.log(`\nTesting Current Configured Model: gemini-2.5-flash...`);
    const currentUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    try {
        const res = UrlFetchApp.fetch(currentUrl, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify({ "contents": [{ "parts": [{ "text": "Hi" }] }] }),
            muteHttpExceptions: true
        });
        if (res.getResponseCode() !== 200) {
            console.error(`❌ gemini-2.5-flash FAILED (Expected if model doesn't exist). Response: ${res.getContentText()}`);
        } else {
            console.log(`✅ gemini-2.5-flash is working!`);
        }
    } catch (e) {
        console.error(e.message);
    }
}

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
    try {
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

        // 🆕 顯示 Loading 動畫 (讓用戶知道我們在處理中)
        // 放在這裡可以讓用戶立刻看到動畫，提升體驗
        sendLoadingAnimation(userId, 20); // 設定 20 秒，通常回覆會快於此時間

        // ==========================================
        // 📝 0. 意見回饋模式 (Feedback Mode)
        // ==========================================
        const cache = CacheService.getScriptCache();
        const feedbackKey = 'FEEDBACK_MODE_' + userId;
        const isFeedbackMode = cache.get(feedbackKey);

        // A. 如果用戶正在回饋模式中
        if (isFeedbackMode) {
            // 1. 檢查是否要結束
            if (userText === "對話結束" || userText === "結束") {
                cache.remove(feedbackKey);
                replyLine(replyToken, [{ type: 'text', text: "🙏 感謝您的寶貴意見！已結束回饋模式，隨時歡迎再來找我聊天！" }], getQuickReplies());
                return;
            }

            // 2. 記錄用戶說的話 (呼叫 database.js)
            if (typeof saveFeedbackChat === 'function') {
                saveFeedbackChat(userId, displayName || 'Unknown', userText);
            }

            // 3. 延長模式時間 (重設 3 分鐘)
            cache.put(feedbackKey, 'TRUE', 180);

            // 4. 簡單回覆確認 (讓用戶知道有在聽)，並附上結束按鈕
            // 用戶希望「一直記錄」，這裡只回一個簡單 emoji 避免打擾，但必須要有回覆才能結束 webhook
            replyLine(replyToken, [{ type: 'text', text: "📝" }], {
                items: [
                    { type: "action", action: { type: "message", label: "🔚 對話結束", text: "對話結束" } }
                ]
            });
            return;
        }

        // B. 檢查是否觸發回饋模式
        if (userText === "意見回饋" || userText === "Feedback") {
            // 設定 3 分鐘 (180秒) 快取
            cache.put(feedbackKey, 'TRUE', 180);

            const welcomeMsg = "📝 進入意見回饋模式\n\n請直接告訴我您的建議或想法，我會全部記錄下來。\n\n⚠️ 注意：目前僅支援「文字」訊息，請勿傳送圖片、貼圖或檔案。\n\n(只有按下「對話結束」或靜置 3 分鐘才會離開此模式)";

            replyLine(replyToken, [{ type: 'text', text: welcomeMsg }], {
                items: [
                    { type: "action", action: { type: "message", label: "🔚 對話結束", text: "對話結束" } }
                ]
            });
            return;
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
        // === 0. 基礎指令處理 === (已移至上方意見回饋模式)

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

        try {
            // === 0.2 平行處理：同時執行 AI 語意過濾 (Lite) 與 Supabase 查詢 ===
            // 這兩件事互不相干，平行跑可以省下 1-2 秒
            console.log(`[Timer] Start Parallel Tasks (Lite Filter + Supabase)`);
            const parallelStart = new Date().getTime();

            // 定義這两个 Request
            let requests = [];

            // 1. Lite Filter Request (建構 Payload)
            // 為了使用 fetchAll，我們必須手動組裝 requestGeminiAPI 裡面的邏輯
            const liteModelName = 'gemini-2.5-flash-lite';
            const liteUrl = `https://generativelanguage.googleapis.com/v1beta/models/${liteModelName}:generateContent?key=${PROPS.getProperty('GEMINI_API_KEY_FREE') || PROPS.getProperty('GEMINI_API_KEY')}`;

            const litePayload = {
                "contents": [{
                    "parts": [{
                        "text": `Classify the following text into one of these categories:
1. "ABUSE": Profanity, hate speech, insults, or malicious attacks.
2. "SPAM": Nonsense, random characters, or irrelevant spam.
3. "SAFE": Legitimate questions, greetings, feedback, or shopping queries.

Text: "${userText}"
Answer (only one word):` }]
                }],
                "generationConfig": { "temperature": 0, "maxOutputTokens": 10 }
            };

            const reqLite = {
                url: liteUrl,
                method: 'post',
                contentType: 'application/json',
                payload: JSON.stringify(litePayload),
                muteHttpExceptions: true
            };

            // 2. Supabase Request (建構 URL)
            // 為了使用 fetchAll，也必須手動組裝 getFromSupabase 裡面的邏輯
            const sbUrl = `${PROPS.getProperty('SUPABASE_URL')}/rest/v1/user_card_settings?user_id=eq.${userId}&select=owned_banks,payment_bindings,profile`;
            const sbKey = PROPS.getProperty('SUPABASE_KEY');

            const reqSupabase = {
                url: sbUrl,
                method: 'get',
                headers: {
                    'apikey': sbKey,
                    'Authorization': 'Bearer ' + sbKey
                },
                muteHttpExceptions: true
            };

            // 平行執行！
            let responses = [];
            try {
                requests = [reqLite, reqSupabase];
                responses = UrlFetchApp.fetchAll(requests);
            } catch (e) {
                console.error("Parallel Fetch Error: " + e.message);
            }

            console.log(`[Timer] Parallel Execution Done (${new Date().getTime() - parallelStart}ms)`);

            // === 處理結果 ===

            // 1. 解析 Lite Filter 結果
            let safetyCheck = "SAFE";
            if (responses[0] && responses[0].getResponseCode() === 200) {
                try {
                    const data = JSON.parse(responses[0].getContentText());
                    const result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();
                    if (result === "ABUSE" || result === "SPAM") safetyCheck = result;
                } catch (e) { console.warn("Lite Filter Parse Error"); }
            }

            if (safetyCheck !== "SAFE") {
                console.log(`[${safetyCheck}] Lite Filter 攔截, 用戶: ${userId}`);
                filterResult = safetyCheck;
                responseType = safetyCheck;
                botResponse = safetyCheck === "ABUSE" ? "⚠️ 建議您別這樣對待機器人" : "⚠️ 系統無法理解您的輸入，請輸入明確的問題。";
                replyAndLog([{ type: 'text', text: botResponse }]);
                return;
            }

            // 2. 解析 Supabase 結果 (組裝 Context)
            let userContext = "【用戶尚未設定卡片，請假設他是新戶】";

            if (responses[1] && responses[1].getResponseCode() === 200) {
                try {
                    const data = JSON.parse(responses[1].getContentText());
                    if (data.length > 0) {
                        const row = data[0];
                        // 簡單的 parse 邏輯 (複製自 getFromSupabase)
                        const safeParse = (val, def) => {
                            if (!val) return def;
                            if (typeof val === 'object') return val;
                            try { return JSON.parse(val); } catch (e) { return def; }
                        };
                        const myWallet = safeParse(row.owned_banks, []);
                        const payMap = safeParse(row.payment_bindings, {});
                        const profile = safeParse(row.profile, {}); // 用戶 profile 可用於後續推薦邏輯

                        // 開始組裝 Context
                        if ((myWallet && myWallet.length > 0) || (payMap && Object.keys(payMap).length > 0)) {
                            userContext = `【用戶持卡與支付設定】：\n`;

                            // 🆕 記錄用戶持卡資料
                            userContextData = { myWallet, payMap, profile };

                            const formatCard = (c) => typeof c === 'string' ? c : (c.name ? `${c.bank ? c.bank + ' ' : ''}${c.name}` : JSON.stringify(c));

                            if (myWallet && myWallet.length > 0) {
                                userContext += `- 已有卡片：${myWallet.map(formatCard).join(', ')}\n`;
                            } else {
                                userContext += `- 已有卡片：(無)\n`;
                            }

                            // 過濾掉沒有綁定卡片的支付方式
                            let validPayMap = {};
                            try {
                                if (payMap) {
                                    for (const [payName, cards] of Object.entries(payMap)) {
                                        if (Array.isArray(cards) && cards.length > 0) {
                                            validPayMap[payName] = cards;
                                        }
                                    }
                                }
                            } catch (err) { console.error("Filter payMap Error: " + err.message); }

                            if (Object.keys(validPayMap).length > 0) {
                                userContext += `- 支付綁定：${JSON.stringify(validPayMap)}\n`;
                            }
                        }
                    }
                } catch (e) {
                    console.error("Supabase Parse Error: " + e.message);
                }
            } else {
                console.warn("Supabase Fetch Failed or Empty");
            }

            // === 2. 呼叫 Gemini AI (最重要的部分) ===
            const aiStart = new Date().getTime();
            console.log(`[Timer] Start Gemini Main Call`);
            const aiResponse = callGeminiJSON(userText, userContext);
            console.log(`[Timer] Gemini Main Call Done (${new Date().getTime() - aiStart}ms). Success: ${!!aiResponse}`);

            // 🆕 記錄 AI 模型資訊
            aiModel = 'gemini-2.5-flash-lite';

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
    } catch (fatalErr) {
        // 🛡️ 頂層安全網：無論發生什麼都要回覆用戶
        console.error('FATAL handleMessage Error: ' + fatalErr.toString());
        if (fatalErr.stack) console.error(fatalErr.stack);
        try {
            replyLine(event.replyToken, [{ type: 'text', text: '⚠️ 系統發生嚴重錯誤 (FATAL): ' + fatalErr.message }]);
        } catch (replyErr) {
            console.error('Reply also failed: ' + replyErr.message);
        }
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
    // gemini-2.5-flash-lite: 速度最快、最便宜
    const modelName = 'gemini-2.5-flash-lite';
    // URL 不帶 Key (由 helper 決定)
    const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

    // 這是給 AI 的指令 (Prompt Engineering)
    // 告訴它扮演什麼角色、怎麼處理用戶資料、以及輸出的格式
    const prompt = `你是「卡衛」，一位專業的台灣信用卡理財顧問。
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
   | 你好 / 嗨 | 👋 嗨！我是卡衛～告訴我消費場景，幫你找最划算的卡！例如：「超商」「網購 3000」 |
   | 你是誰 | 🤖 我是卡衛，幫你比較刷哪張卡回饋最高！試試問：「全聯」「加油」 |
   | 謝謝 | 😊 不客氣～有刷卡問題隨時問！ |
   | 早安/晚安 | 🌞 早安！今天要去哪消費？告訴我場景幫你省錢～ |
   
   **注意**：友善但簡短，最後一定要帶到「怎麼使用我」。

3. **QUERY 資訊檢索邏輯**：
   - 優先查閱我提供的 File Search 知識庫 (信用卡權益文件)。
   - **若 RAG 停用或查無資料**，請發揮你的專業知識，根據「台灣市場 2026-1月」最新現況回答。
   - 絕對禁止捏造不存在的卡片或回饋數據。

4. **QUERY 策略分析 (由優至劣排序)**：
   - **第一優先**：從客戶的【已綁定支付方式】(如 LINE Pay, Apple Pay, 街口...) 或【持有卡片】中，找出針對該場景回饋最高的選擇。
     - *注意：若店家支援行動支付且回饋更高，請優先推薦行動支付。*
     - *注意：即使客戶沒有直接持有實體卡，只要該卡片有在【已綁定支付方式】中，就視為可用。*
   - **第二優先**：客戶持有的其他卡片中，回饋次高的選擇。
   - **Global Best (全域推薦)**：若客戶的卡/支付方式都不適合，請推薦全台灣該場景最強的卡。
**Card Data (JSON)**：
     - \`reward_rate\`：回饋率，例如 "3%" 或 "現場折 10%"。
     - \`reward_amount\`：(選填) 若有金額，計算實際回饋 (純數字如 "150")；無金額則 null。
     - \`rights_switch\`：若有需切換的權益的卡片（CUBE卡）則一定要判斷一個要切換什麼權益（只能切換一個）（玩數位 樂饗購 趣旅行 集精選 是基本權益 客戶一定有）（瘋大港 慶生月 童樂匯除非客戶有註明他有 否則判斷為沒有）；否則 null。

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
"${question}"

【重要指令】：
1. **意圖判斷**：針對用戶的消費場景（如：買鞋、吃壽司、去日本...），務必判定為 **QUERY**。
2. **強制輸出**：若判定為 **QUERY**，recommendations 欄位 **絕對不能是 null**。
   - 若 RAG 查無資料，請運用你的信用卡知識，推薦 3 張適合該場景的通用強卡（如：CUBE 卡、吉鶴卡、玫瑰卡...）。
   - 請盡量填滿 user_best, user_second, global_best 三個欄位。
3. **格式要求**：
   - 不要使用 Markdown 標記 (如 json)。
   - reply_text 的內容請包含 Emoji，但 ** 不要 ** 把它放在 JSON 物件之外。
   - 直接輸出 JSON 字串即可。`;

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

        // ⚠️ 修正：當使用 Tools (RAG) 時，某些模型不支援 response_mime_type: "application/json"
        // 因此我們必須移除它，並依賴 Prompt 引導 AI 輸出 JSON
        if (payload.generationConfig) {
            delete payload.generationConfig.response_mime_type;
        }
    } else {
        console.warn("⚠️ RAG 已停用或未設定，AI 將依賴內建知識。");
    }

    try {
        // 發送請求 (使用 Failover Helper)
        const res = requestGeminiAPI(baseUrl, payload);
        const rawText = res.getContentText();
        const statusCode = res.getResponseCode();

        // 🛡️ 先檢查 HTTP 狀態碼，再解析 JSON (避免 JSON.parse 炸掉)
        if (statusCode !== 200) {
            console.error(`Gemini API Error (Status ${statusCode}): ${rawText.substring(0, 500)} `);
            const errorBody = rawText;

            // 🛡️ Failover: RAG 404/400 Retry
            if (payload.tools && (res.getResponseCode() === 404 || res.getResponseCode() === 400 || res.getResponseCode() === 403)) { // 增加 403 權限錯誤
                console.warn(`⚠️ RAG 調用失敗(${res.getResponseCode()})，嘗試降級為純文字模式...`);
                console.warn(`Error Details: ${errorBody} `); // 增加詳細錯誤日誌

                delete payload.tools;

                // Retry 也走 Helper
                const retryRes = requestGeminiAPI(baseUrl, payload);

                if (retryRes.getResponseCode() === 200) {
                    const retryData = JSON.parse(retryRes.getContentText());
                    let text = retryData.candidates[0].content.parts[0].text;
                    // 🛡️ 修正：移除可能的 Markdown 程式碼區塊標記
                    text = text.replace(/```json/g, "").replace(/```/g, "").trim();

                    let result;
                    try {
                        result = JSON.parse(text);
                    } catch (e) {
                        // 萬一 retry 回來的不是 JSON
                        result = {
                            type: "CHITCHAT",
                            reply_text: text
                        };
                    }

                    // Add Emoji for Retry
                    const emoji = retryRes.source === 'FREE' ? "🥸 " : "🤔 ";
                    if (result.reply_text) {
                        // 根據錯誤碼給出更具體的提示
                        let errorReason = "連線失敗";
                        let debugSafeError = "";

                        try {
                            const errObj = JSON.parse(errorBody);
                            if (errObj.error && errObj.error.message) {
                                debugSafeError = errObj.error.message;
                            }
                        } catch (e) { }

                        if (res.getResponseCode() === 403) errorReason = "權限不足 (API Key 需啟用相關 API)";
                        if (res.getResponseCode() === 404) errorReason = "找不到知識庫 (File Store Name 錯誤)";
                        if (res.getResponseCode() === 400) errorReason = "請求格式錯誤";

                        result.reply_text = emoji + result.reply_text + `\n(⚠️ RAG ${errorReason}: ${debugSafeError})`;
                    }
                    return result;
                } else {
                    console.error(`Retry without RAG Failed: ${retryRes.getContentText()}`);
                }

                return null;
            }

        }

        // 取出 AI 的回話內容
        let data;
        try {
            // 🛡️ 增強型 JSON 清洗：只抓取最外層的 { ... }
            const start = rawText.indexOf('{');
            const end = rawText.lastIndexOf('}');

            if (start !== -1 && end !== -1 && end > start) {
                const jsonString = rawText.substring(start, end + 1);
                data = JSON.parse(jsonString);
            } else {
                // 找不到 JSON 結構，當作純文字
                throw new Error("No JSON structure found");
            }
        } catch (parseErr) {
            console.error('API Response JSON Parse Error: ' + parseErr.message);
            console.error('Raw response (first 300 chars): ' + rawText.substring(0, 300));
            // 嘗試救回：如果是簡單的 JSON 錯誤，或許可以用 regex 修正 (待實作)

            return {
                type: 'CHITCHAT',
                reply_text: rawText // 至少回傳原始文字，不要讓 User 已讀不回
            };
        }

        let text = data.candidates[0].content.parts[0].text;

        // 🛡️ 修正：移除可能的 Markdown 程式碼區塊標記
        text = text.replace(/```json/g, "").replace(/```/g, "").trim();

        // 🛡️ 進階修正：有時候 AI 會在 JSON 前後加廢話，我們只取最外層的 { ... }
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            text = jsonMatch[0];
        } else {
            console.warn("⚠️ No JSON object found in response");
        }

        let result;
        try {
            result = JSON.parse(text);
        } catch (e) {
            console.warn("JSON Parse Failed (Main): " + e.message);
            // 萬一 AI 回來的不是 JSON，就當作一般對話處理
            result = {
                type: "CHITCHAT",
                reply_text: text
            };
        }

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
                    console.log(`✅ RAG 命中！引用來源: ${sources.join(', ')}`);
                    // 用戶要求不顯示來源 ID
                    // result.reply_text += `\n\n📚 參考來源：\n` + sources.map((s, i) => `${i + 1}. ${s}`).join('\n');
                } else if (ENABLE_RAG && FILE_STORE_NAME && result.type === "QUERY") {
                    // 雖然啟用了 RAG，但沒有引用任何文件
                    // 可能是真的找不到，或是 threshold 太高
                    result.reply_text += `\n\n(⚠️ RAG: No documents found)`;
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
 * 傳送 LINE Loading 動畫 (讓用戶知道機器人正在思考)
 * 
 * @param {string} chatId - LINE User ID
 * @param {number} seconds - 動畫持續時間 (5~60秒)
 */
function sendLoadingAnimation(chatId, seconds = 20) {
    if (!CHANNEL_ACCESS_TOKEN) return;

    try {
        UrlFetchApp.fetch('https://api.line.me/v2/bot/chat/loading/start', {
            method: 'post',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN
            },
            payload: JSON.stringify({
                chatId: chatId,
                loadingSeconds: seconds
            }),
            muteHttpExceptions: true
        });
    } catch (e) {
        console.error("sendLoadingAnimation Error: " + e.message);
        // Loading 動畫失敗不應影響主流程，所以 catch 後不拋出
    }
}

/**
 * 工具函式：回覆 LINE 訊息
 * 這是最後一步，把準備好的文字或卡片丟回給 LINE 伺服器
 */
function replyLine(replyToken, messages, quickReply = null) {
    if (!CHANNEL_ACCESS_TOKEN) {
        console.error("❌ 錯誤：CHANNEL_ACCESS_TOKEN 未設定，無法回覆訊息。");
        return;
    }

    // 加上快速回覆按鈕
    if (quickReply && messages.length > 0) {
        messages[messages.length - 1].quickReply = quickReply;
    }

    const payload = { replyToken: replyToken, messages: messages };

    try {
        // 呼叫 LINE Messaging API
        UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
            method: 'post',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
            payload: JSON.stringify(payload),
            muteHttpExceptions: true
        });
    } catch (e) {
        console.error("replyLine Error: " + e.message);
    }
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

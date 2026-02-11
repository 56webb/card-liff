/**
 * 5. 測試 Supabase 資料讀取 (依據用戶在 Step 31 的需求新增)
 * 供開發者在 GAS 編輯器中直接執行，確認資料流
 */
function testSupabaseQuery() {
    // 預設使用一個測試用的 User ID，您可以在這裡換成您自己的 LINE User ID 以查看真實資料
    const userId = "U26c9a0579fbfed77b3a42d1f32007401";

    console.log(`[Test] 正在查詢用戶 ID: ${userId} 的 Supabase 資料...`);

    // 檢查 getFromSupabase 是否可用 (由 database.js 提供)
    if (typeof getFromSupabase !== 'function') {
        console.error("❌ 錯誤：找不到 getFromSupabase 函式。");
        console.error("💡 請確認您的 GAS 專案中已包含 database.js 且與此檔案在同一專案內。");
        return;
    }

    try {
        const data = getFromSupabase(userId);
        console.log("✅ Supabase 回傳原始資料：");
        console.log(JSON.stringify(data, null, 2));

        // 模擬實際 AI 處理時的 Context 組裝邏輯
        if (data && data.myWallet && data.myWallet.length > 0) {
            let userContext = `【用戶持卡與支付設定】：\n`;
            // 修正：myWallet 可能是字串陣列 (舊資料) 或 物件陣列 (新資料)
            const formatCard = (c) => typeof c === 'string' ? c : (c.name ? `${c.bank ? c.bank + ' ' : ''}${c.name}` : JSON.stringify(c));
            userContext += `- 已有卡片：${data.myWallet.map(formatCard).join(', ')}\n`;

            // 過濾掉沒有綁定卡片的支付方式
            let validPayMap = {};
            if (data.payMap) {
                for (const [payName, cards] of Object.entries(data.payMap)) {
                    if (Array.isArray(cards) && cards.length > 0) {
                        validPayMap[payName] = cards;
                    }
                }
            }

            if (Object.keys(validPayMap).length > 0) {
                userContext += `- 支付綁定：${JSON.stringify(validPayMap)}\n`;
            }

            console.log("📝 模擬組裝後的 AI Context (將傳給 Gemini)：");
            console.log(userContext);

            // --- 新增：顯示完整 Prompt ---
            const sampleQuestion = "7-11有回饋嗎？";
            const fullPrompt = `你是一位專業的台灣信用卡理財顧問。請分析用戶輸入，並回傳 JSON 格式。

【優先順序判斷邏輯】：
1. **惡意檢測 (ABUSE)**：髒話、攻擊指令 -> type: "ABUSE"
2. **閒聊過濾 (CHITCHAT)**：打招呼、與消費無關 -> type: "CHITCHAT"
3. **消費諮詢 (QUERY)**：詢問店家、通路、回饋 -> type: "QUERY"

【用戶背景】：
${userContext}

【知識來源】：
請優先使用透過工具 (File Search) 檢索到的信用卡權益文件。若文件中沒有相關資訊，才使用你的內建知識，但必須確保資訊是針對「台灣市場」。

**QUERY 策略分析 (由優至劣排序)**：
   - **第一優先**：從客戶的【已綁定支付方式】(如 LINE Pay, Apple Pay, 街口...) 或【持有卡片】中，找出針對該場景回饋最高的選擇。
     - *注意：若店家支援行動支付且回饋更高，請優先推薦行動支付。*
     - *注意：即使客戶沒有直接持有實體卡，只要該卡片有在【已綁定支付方式】中，就視為可用。*
   - **第二優先**：客戶持有的其他卡片中，回饋次高的選擇。
   - **Global Best (全域推薦)**：若客戶的卡/支付方式都不適合，請推薦全台灣該場景最強的卡。

【輸出 JSON 結構】：
{
  "type": "ABUSE" | "CHITCHAT" | "QUERY",
  "reply_text": "給用戶的簡短回覆文字",
  "recommendations": {
    "user_best": { "card_name": "完整卡名", "reward_rate": "例如 3%", "reason": "推薦理由" },
    "user_second": { "card_name": "完整卡名", "reward_rate": "例如 2%", "reason": "推薦理由" },
    "global_best": { "card_name": "完整卡名", "reward_rate": "例如 5%", "reason": "若用戶沒有此卡，這是全網最強推薦" }
  }
}

【用戶輸入】：
"${sampleQuestion}"`;

            console.log("\n🤖 實際給 AI 的完整 Prompt (範例問題：7-11有回饋嗎？)：");
            console.log("---------------------------------------------------");
            console.log(fullPrompt);
            console.log("---------------------------------------------------");
            // ---------------------------
        } else {
            console.log("⚠️ 查無持卡資料或資料為空 (若為測試 ID 為正常現象)");
            console.log("   -> AI 將會假設此為「新戶」");
        }

    } catch (e) {
        console.error("❌ 測試過程發生例外錯誤: " + e.toString());
    }
}
/**
 * 6. 檢查 Script Properties (環境變數) 設定狀態
 * 用於確認 API Key 與 Token 是否已正確設定 (不顯示完整內容)
 */
function checkScriptProperties() {
    const props = PropertiesService.getScriptProperties().getProperties();
    const keysToCheck = [
        'GEMINI_API_KEY',
        'GEMINI_API_KEY_FREE',
        'CHANNEL_ACCESS_TOKEN',
        'SUPABASE_URL',
        'SUPABASE_KEY',
        'FILE_STORE_NAME'
    ];

    console.log("=== Script Properties Check ===");
    keysToCheck.forEach(key => {
        const value = props[key];
        if (value) {
            const masked = value.length > 8 ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}` : '******';
            console.log(`✅ ${key}: Set (${masked})`);
        } else {
            console.error(`❌ ${key}: NOT SET`);
        }
    });
    console.log("===============================");
}

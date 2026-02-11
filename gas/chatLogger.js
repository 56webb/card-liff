/**
 * 對話紀錄模組 (Chat Logger)
 * 
 * 將用戶與機器人的對話儲存至 Supabase chat_logs 表
 * 用途：分析用戶行為、改善 AI 回應品質、偵錯問題
 * 
 * @author CardWay Team
 * @version 1.0.0
 */

// ==================== LINE Profile API ====================

/**
 * 取得 LINE 用戶的顯示名稱
 * 呼叫 LINE Messaging API 的 Profile 端點
 * 
 * @param {string} userId - LINE User ID (U開頭)
 * @returns {string} 用戶名稱，若失敗則回傳 "Unknown"
 * 
 * 注意：此 API 有頻率限制，若大量呼叫可能被暫時封鎖
 */
function getLineDisplayName(userId) {
    if (!userId) return 'Unknown';

    const token = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN');
    if (!token) {
        console.warn('⚠️ CHANNEL_ACCESS_TOKEN 未設定，無法取得用戶名稱');
        return 'Unknown';
    }

    try {
        const res = UrlFetchApp.fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
            method: 'get',
            headers: { 'Authorization': 'Bearer ' + token },
            muteHttpExceptions: true
        });

        if (res.getResponseCode() === 200) {
            const profile = JSON.parse(res.getContentText());
            return profile.displayName || 'Unknown';
        } else {
            // 403 = 用戶封鎖機器人或未加好友
            // 404 = 用戶不存在
            console.warn(`getLineDisplayName: HTTP ${res.getResponseCode()} for ${userId.substring(0, 10)}...`);
        }
    } catch (e) {
        console.error('getLineDisplayName Error: ' + e.message);
    }

    return 'Unknown';
}

// ==================== Supabase 日誌儲存 ====================

/**
 * 儲存對話紀錄至 Supabase
 * 
 * @param {Object} logData - 日誌資料物件
 * @param {string} logData.userId - LINE User ID
 * @param {string} logData.displayName - LINE 顯示名稱
 * @param {string} logData.userMessage - 用戶輸入的訊息
 * @param {string} logData.botResponse - 機器人的回覆
 * @param {string} logData.responseType - 回覆類型 (CHITCHAT/QUERY/ABUSE/SPAM/ERROR)
 * @param {string} logData.filterResult - 過濾結果 (SAFE/ABUSE/SPAM)
 * @param {string} logData.aiModel - AI 模型名稱
 * @param {string} logData.apiSource - API 來源 (FREE/PAID)
 * @param {number} logData.responseTimeMs - 回應時間(毫秒)
 * @param {Object} logData.userContext - 用戶持卡設定 (可選)
 * @param {Object} logData.recommendations - AI 推薦結果 (可選)
 */
function logChatToSupabase(logData) {
    const props = PropertiesService.getScriptProperties();
    const SUPABASE_URL = props.getProperty('SUPABASE_URL');
    const SUPABASE_KEY = props.getProperty('SUPABASE_KEY');

    // 如果沒設定 Supabase，靜默跳過 (不影響主流程)
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.warn('⚠️ Supabase 未設定，跳過對話紀錄');
        return false;
    }

    try {
        // 組裝要儲存的資料
        const payload = {
            line_user_id: logData.userId || 'unknown',
            line_display_name: logData.displayName || 'Unknown',
            user_message: logData.userMessage || '',
            bot_response: logData.botResponse || null,
            response_type: logData.responseType || 'UNKNOWN',
            filter_result: logData.filterResult || 'SAFE',
            ai_model: logData.aiModel || null,
            api_source: logData.apiSource || null,
            response_time_ms: logData.responseTimeMs || null,
            user_context: logData.userContext || null,
            recommendations: logData.recommendations || null
        };

        // 發送 POST 請求到 Supabase
        const res = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/chat_logs`, {
            method: 'post',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': 'Bearer ' + SUPABASE_KEY,
                'Prefer': 'return=minimal' // 不回傳新增的資料，節省流量
            },
            payload: JSON.stringify(payload),
            muteHttpExceptions: true
        });

        if (res.getResponseCode() === 201) {
            console.log(`✅ 對話紀錄已儲存: ${logData.displayName} - ${logData.userMessage.substring(0, 20)}...`);
            return true;
        } else {
            console.error(`❌ Chat Log Insert Failed (${res.getResponseCode()}): ${res.getContentText()}`);
            return false;
        }
    } catch (e) {
        console.error('logChatToSupabase Error: ' + e.message);
        return false;
    }
}

// ==================== 測試函式 ====================

/**
 * 測試對話紀錄功能
 * 在 GAS 編輯器中手動執行此函式
 */
function testChatLogger() {
    // 測試用假資料
    const testLog = {
        userId: 'U_TEST_12345',
        displayName: '測試用戶',
        userMessage: '超商刷什麼卡比較好？',
        botResponse: '1. 國泰 CUBE：3% (切換集精選)\n2. 玉山 U Bear：1.5%',
        responseType: 'QUERY',
        filterResult: 'SAFE',
        aiModel: 'gemini-2.5-flash',
        apiSource: 'FREE',
        responseTimeMs: 1234,
        userContext: { myWallet: [{ bank: '013 國泰世華', name: 'CUBE卡' }] },
        recommendations: { user_best: { card_name: 'CUBE卡', reward_rate: '3%' } }
    };

    console.log('📝 測試對話紀錄...');
    const result = logChatToSupabase(testLog);
    console.log(result ? '✅ 測試成功！請至 Supabase 檢查 chat_logs 表' : '❌ 測試失敗');
}

/**
 * 測試取得 LINE 用戶名稱
 * 需要提供真實的 userId 才能測試
 */
function testGetDisplayName() {
    const testUserId = 'U_YOUR_REAL_USER_ID'; // 替換成真實的 LINE User ID
    const name = getLineDisplayName(testUserId);
    console.log(`用戶名稱: ${name}`);
}

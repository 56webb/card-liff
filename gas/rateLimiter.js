/**
 * Rate Limiter 模組
 * 
 * 限制用戶每 2 小時的使用次數，防止濫用
 * 使用 GAS CacheService 實現，快速且不佔用 Supabase 配額
 * 
 * @author CardWay Team
 * @version 1.0.0
 */

// ==================== 設定區 ====================

const RATE_CONFIG = {
    // 一般用戶設定
    NORMAL: {
        limit: 5,                    // 每週期上限次數
        windowMs: 2 * 60 * 60 * 1000 // 2 小時 (毫秒)
    },
    // VIP 用戶設定
    VIP: {
        limit: 100,                  // VIP 上限很高
        windowMs: 2 * 60 * 60 * 1000
    }
};

// VIP 名單（可以之後改成從 Supabase 讀取）
// 格式：LINE User ID
const VIP_LIST = [
    'U26c9a0579fbfed77b3a42d1f32007401', // 指定 VIP 用戶
];

// ==================== 核心函式 ====================

/**
 * 檢查用戶是否為 VIP
 * 
 * @param {string} userId - LINE User ID
 * @returns {boolean} 是否為 VIP
 */
function isVipUser(userId) {
    // 方法 1: 硬編碼名單（簡單但不靈活）
    if (VIP_LIST.includes(userId)) {
        return true;
    }

    // 方法 2: 從 Script Properties 讀取 VIP 名單
    const vipListProp = PropertiesService.getScriptProperties().getProperty('VIP_USER_LIST');
    if (vipListProp) {
        const vips = vipListProp.split(',').map(id => id.trim());
        if (vips.includes(userId)) {
            return true;
        }
    }

    // 方法 3: 未來可以從 Supabase user_wallets 表讀取 is_vip 欄位
    // const settings = getFromSupabase(userId);
    // if (settings && settings.is_vip) return true;

    return false;
}

/**
 * 檢查用戶是否超過使用限制
 * 
 * @param {string} userId - LINE User ID
 * @returns {Object} 結果物件
 *   - allowed: boolean - 是否允許繼續
 *   - remaining: number - 剩餘次數
 *   - resetInMinutes: number - 幾分鐘後重置
 *   - isVip: boolean - 是否為 VIP
 *   - limit: number - 上限次數
 */
function checkRateLimit(userId) {
    const cache = CacheService.getScriptCache();
    const key = `rate_limit_${userId}`;
    const now = Date.now();

    // 判斷用戶等級
    const isVip = isVipUser(userId);
    const config = isVip ? RATE_CONFIG.VIP : RATE_CONFIG.NORMAL;

    // 讀取快取
    const cached = cache.get(key);

    if (cached) {
        const [countStr, timestampStr] = cached.split('|');
        const count = parseInt(countStr, 10);
        const timestamp = parseInt(timestampStr, 10);

        // 計算剩餘時間
        const elapsed = now - timestamp;
        const resetInMs = config.windowMs - elapsed;

        // 檢查是否在同一個週期
        if (elapsed < config.windowMs) {
            // 還在週期內
            if (count >= config.limit) {
                // 超過限制！
                return {
                    allowed: false,
                    remaining: 0,
                    resetInMinutes: Math.ceil(resetInMs / 60000),
                    isVip: isVip,
                    limit: config.limit,
                    currentCount: count
                };
            }

            // 未超過，增加計數
            cache.put(key, `${count + 1}|${timestamp}`, 7200); // 快取 2 小時
            return {
                allowed: true,
                remaining: config.limit - count - 1,
                resetInMinutes: Math.ceil(resetInMs / 60000),
                isVip: isVip,
                limit: config.limit,
                currentCount: count + 1
            };
        }
    }

    // 新的週期開始
    cache.put(key, `1|${now}`, 7200);
    return {
        allowed: true,
        remaining: config.limit - 1,
        resetInMinutes: Math.ceil(config.windowMs / 60000),
        isVip: isVip,
        limit: config.limit,
        currentCount: 1
    };
}

/**
 * 產生超過限制時的回覆訊息
 * 
 * @param {Object} rateLimitResult - checkRateLimit 的結果
 * @returns {string} 給用戶看的訊息
 */
function getRateLimitMessage(rateLimitResult) {
    const { resetInMinutes, limit } = rateLimitResult;

    // 計算小時和分鐘
    const hours = Math.floor(resetInMinutes / 60);
    const minutes = resetInMinutes % 60;
    const timeStr = hours > 0 ? `${hours} 小時 ${minutes} 分鐘` : `${minutes} 分鐘`;

    return `⏰ 抱歉，您的免費額度已用完！

📊 目前方案：每 2 小時 ${limit} 次
⏳ 重置倒數：約 ${timeStr}

💎 升級 VIP 會員可享：
• 無限次數查詢
• 優先回覆速度
• 專屬客服支援

👉 點下方按鈕了解 VIP 方案！`;
}

/**
 * 取得用戶目前的使用狀況（不增加計數）
 * 用於顯示剩餘次數等資訊
 * 
 * @param {string} userId - LINE User ID
 * @returns {Object} 使用狀況
 */
function getRateLimitStatus(userId) {
    const cache = CacheService.getScriptCache();
    const key = `rate_limit_${userId}`;
    const now = Date.now();

    const isVip = isVipUser(userId);
    const config = isVip ? RATE_CONFIG.VIP : RATE_CONFIG.NORMAL;

    const cached = cache.get(key);

    if (cached) {
        const [countStr, timestampStr] = cached.split('|');
        const count = parseInt(countStr, 10);
        const timestamp = parseInt(timestampStr, 10);
        const elapsed = now - timestamp;

        if (elapsed < config.windowMs) {
            return {
                used: count,
                remaining: Math.max(0, config.limit - count),
                limit: config.limit,
                resetInMinutes: Math.ceil((config.windowMs - elapsed) / 60000),
                isVip: isVip
            };
        }
    }

    // 沒有紀錄或已過期
    return {
        used: 0,
        remaining: config.limit,
        limit: config.limit,
        resetInMinutes: Math.ceil(config.windowMs / 60000),
        isVip: isVip
    };
}

// ==================== 測試函式 ====================

/**
 * 測試 Rate Limiter
 * 在 GAS 編輯器中手動執行
 */
function testRateLimiter() {
    const testUserId = 'U_TEST_USER_123';

    console.log('=== Rate Limiter 測試 ===');

    // 模擬連續請求
    for (let i = 1; i <= 7; i++) {
        const result = checkRateLimit(testUserId);
        console.log(`請求 #${i}: allowed=${result.allowed}, remaining=${result.remaining}, count=${result.currentCount}`);

        if (!result.allowed) {
            console.log(`被限制！訊息：\n${getRateLimitMessage(result)}`);
            break;
        }
    }

    // 顯示狀態
    const status = getRateLimitStatus(testUserId);
    console.log(`\n目前狀態: used=${status.used}/${status.limit}, resetIn=${status.resetInMinutes}min`);
}

/**
 * 清除測試用戶的限制（除錯用）
 */
function clearTestUserLimit() {
    const cache = CacheService.getScriptCache();
    cache.remove('rate_limit_U_TEST_USER_123');
    console.log('已清除測試用戶的限制');
}

/**
 * 手動將用戶加入 VIP
 * 
 * @param {string} userId - 要加入 VIP 的 LINE User ID
 */
function addVipUser(userId) {
    const props = PropertiesService.getScriptProperties();
    const currentList = props.getProperty('VIP_USER_LIST') || '';
    const vips = currentList ? currentList.split(',') : [];

    if (!vips.includes(userId)) {
        vips.push(userId);
        props.setProperty('VIP_USER_LIST', vips.join(','));
        console.log(`✅ 已將 ${userId} 加入 VIP 名單`);
    } else {
        console.log(`⚠️ ${userId} 已經是 VIP`);
    }
}

/**
 * 查看目前的 VIP 名單
 */
function listVipUsers() {
    const currentList = PropertiesService.getScriptProperties().getProperty('VIP_USER_LIST') || '';
    console.log('目前 VIP 名單:', currentList || '(空)');
}

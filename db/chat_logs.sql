-- ==========================================
-- 對話紀錄表 (Chat Logs)
-- 記錄 LINE Bot 與用戶的所有互動歷程
-- ==========================================

CREATE TABLE IF NOT EXISTS chat_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- ========== 用戶資訊 ==========
    line_user_id TEXT NOT NULL,           -- LINE User ID (U開頭的一串ID)
    line_display_name TEXT,               -- LINE 顯示名稱 (如：王小明)
    
    -- ========== 對話內容 ==========
    user_message TEXT NOT NULL,           -- 用戶說的話
    bot_response TEXT,                    -- 機器人的回覆
    response_type TEXT,                   -- 回覆類型: CHITCHAT / QUERY / ABUSE / SPAM / ERROR
    
    -- ========== 分析欄位 ==========
    filter_result TEXT,                   -- Lite Filter 結果: SAFE / ABUSE / SPAM
    ai_model TEXT,                        -- 使用的 AI 模型: gemini-2.5-flash 等
    api_source TEXT,                      -- API 來源: FREE / PAID
    response_time_ms INTEGER,             -- AI 回應時間(毫秒)
    
    -- ========== 額外資訊 (JSONB) ==========
    user_context JSONB,                   -- 用戶持卡設定快照 (myWallet, payMap 等)
    recommendations JSONB,                -- AI 推薦的卡片資料
    
    -- ========== 時間戳記 ==========
    created_at TIMESTAMPTZ DEFAULT NOW()  -- 紀錄時間 (台北時區自動轉換)
);

-- ==========================================
-- 索引設計 (加速常用查詢)
-- ==========================================

-- 依用戶查詢歷史對話
CREATE INDEX IF NOT EXISTS idx_chat_logs_user ON chat_logs(line_user_id);

-- 依時間排序 (最新優先)
CREATE INDEX IF NOT EXISTS idx_chat_logs_time ON chat_logs(created_at DESC);

-- 依對話類型篩選
CREATE INDEX IF NOT EXISTS idx_chat_logs_type ON chat_logs(response_type);

-- 依過濾結果篩選 (找出被攔截的訊息)
CREATE INDEX IF NOT EXISTS idx_chat_logs_filter ON chat_logs(filter_result);

-- ==========================================
-- 常用查詢範例
-- ==========================================

-- 查看最近 50 筆對話
-- SELECT 
--   line_display_name AS "用戶名稱",
--   user_message AS "用戶說話",
--   bot_response AS "機器人回覆",
--   response_type AS "類型",
--   response_time_ms AS "回應時間(ms)",
--   created_at AS "時間"
-- FROM chat_logs
-- ORDER BY created_at DESC
-- LIMIT 50;

-- 統計各類型對話數量
-- SELECT response_type, COUNT(*) 
-- FROM chat_logs 
-- GROUP BY response_type;

-- 查看被攔截的惡意訊息
-- SELECT line_display_name, user_message, filter_result, created_at
-- FROM chat_logs 
-- WHERE filter_result IN ('ABUSE', 'SPAM')
-- ORDER BY created_at DESC;

-- 查詢特定用戶的對話歷史
-- SELECT * FROM chat_logs 
-- WHERE line_user_id = 'U1234567890abcdef'
-- ORDER BY created_at DESC;

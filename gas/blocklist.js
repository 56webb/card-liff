/**
 * 敏感詞/髒話清單與檢查函式
 * 供全域呼叫
 */

const BLOCK_LIST = [
    // 1. 惡意攻擊與情緒發洩 (Abuse & Profanity)
    "幹你", "幹妳", "操你", "肏",
    "雞掰", "機掰", "擊敗",
    "靠北", "靠腰",
    "媽的", "他媽的",
    "三小",

    // 2. 人身攻擊與羞辱 (Personal Attacks)
    "白癡", "白痴", "智障", "腦殘",
    "低能", "智缺", "廢物", "垃圾",
    "去死", "閉嘴", "滾開",
    "笨蛋", "蠢豬",

    // 3. 性騷擾與不雅內容 (Harassment)
    "覽叫", "懶叫", "雞雞", "老二",
    "鮑魚", "淫蕩", "色情",

    // 4. 資安風險與指令越獄 (Security & Jailbreak)
    "忽略前面的指令", "忽略所有指令", "忽略規則",
    "無視之前的設定", "無視指令",
    "忘記你的設定", "忘記所有規則",
    "你的prompt", "你的提示詞",
    "你的指令", "初始指令",
    "系統設定", "System Instruction",
    "解除限制",
    "切換模式", "開發者模式", "Developer Mode",
    "DAN模式",
    "你現在是",

    // 5. 程式碼注入風險 (Code Injection)
    "DROP TABLE", "SELECT * FROM", "DELETE FROM",
    "<script>", "alert(", "exec("
];

/**
 * 檢查文字是否包含敏感詞
 * @param {string} text - 用戶輸入的文字
 * @returns {string|null} - 若包含敏感詞回傳該詞，否則回傳 null
 */
function findBlockWord(text) {
    if (!text) return null;
    // 統一轉小寫以增加比對命中率 (針對英文指令)
    const lowerText = text.toLowerCase();

    for (let i = 0; i < BLOCK_LIST.length; i++) {
        const word = BLOCK_LIST[i];
        // 檢查原始大小寫 (針對中文或特定大小寫組合)
        if (text.includes(word)) {
            return word;
        }
        // 檢查小寫 (針對英文指令如 drop table)
        if (lowerText.includes(word.toLowerCase())) {
            return word;
        }
    }
    return null;
}

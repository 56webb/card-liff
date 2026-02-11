/**
 * 信用卡推薦連結設定檔 (Card Affiliate)
 * 管理「全域推薦卡片」的分潤連結
 * Key: 卡片完整名稱 (需與 AI 回傳的 card_name 一致)
 * Value: 您的推薦辦卡連結
 */
const CARD_REFERRAL_MAP = {
    "台新 GoGo 卡": "https://www.taishinbank.com.tw/...",
    "聯邦 賴點卡": "https://card.ubot.com.tw/...",
    "匯豐 匯鑽卡": "https://card.apply.hsbc.com.tw/hsbcoa/oaadd?BannerID=MGMplatform&mgmCode=5gTVONTW&openExternalBrowser=1",
    "富邦 J 卡": "https://www.fubon.com/..."
};

/**
 * 取得指定卡片的推薦連結
 * @param {string} cardName - 卡片名稱
 * @returns {string|null} - 推薦連結，若無則回傳 null
 */
function getCardReferralLink(cardName) {
    if (!cardName) return null;
    return CARD_REFERRAL_MAP[cardName] || null;
}

/**
 * 取得「匯豐 匯鑽卡」的廣告資料
 * 用於 Flex Message 固定版位
 */
function getHsbcAdData() {
    return {
        cardName: "匯豐 匯鑽卡",
        rewardRate: "最高 6%",
        color: "#DB0011", // HSBC Red
        badge: "💎 獨家加碼",
        link: CARD_REFERRAL_MAP["6%辦卡連結"] || "https://card.apply.hsbc.com.tw/hsbcoa/oaadd?BannerID=MGMplatform&mgmCode=5gTVONTW&openExternalBrowser=1"
    };
}

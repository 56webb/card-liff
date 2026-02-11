/**
 * 蝦皮廣告設定檔 (Shopee Affiliate)
 * 管理首張廣告卡片的內容與連結
 */
const SHOPEE_CONFIG = {
    // 廣告圖片 (建議比例 20:13)
    imageUrl: "https://cf.shopee.tw/file/8b9657fb15b6727778b408137354964e",

    // 卡片標題
    title: "蝦皮購物 Shopee",

    // 卡片描述 (最多三行)
    description: "天天免運費，好康優惠不用等！新人再送 $100 優惠券",

    // 分潤/推廣連結
    link: "https://s.shopee.tw/2g5FhBmwIt",

    // 按鈕文字
    btnLabel: "立即領取優惠"
};

/**
 * 取得蝦皮廣告配置
 * @returns {object}
 */
function getShopeeConfig() {
    return SHOPEE_CONFIG;
}

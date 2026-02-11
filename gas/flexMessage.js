/**
 * flexMessage.js
 * 負責產生 LINE Flex Message 推薦模組
 * 包含：廣告 + AI 推薦的卡片 (動態生成)
 */



/**
 * 產生推薦結果的 Flex Carousel
 * @param {object} aiData - AI 回傳的 JSON 資料
 * 結構範例:
 * {
 *   "user_best": { "card_name": "富邦 J 卡", "reward_rate": "3%", "reason": "..." },
 *   "user_second": { "card_name": "國泰 CUBE 卡", "reward_rate": "2%", "reason": "..." },
 *   "global_best": { "card_name": "台新 太陽卡", "reward_rate": "3.8%", "reason": "..." }
 * }
 */
function getRecommendationFlex(aiData) {
    if (!aiData) return null;

    // 建立通用卡片產生器 (V3：名稱 + 回饋率 + 金額 + 權益 + 官網鈕)
    const createCardBubble = (badge, cardName, rewardRate, color, rewardAmount = null, rightsSwitch = null, url = null) => {

        // Body 內容堆疊
        const bodyContents = [
            // 1. 卡片名稱 (置頂)
            {
                type: "text",
                text: String(cardName || "未知卡片"),
                weight: "bold",
                size: "md",
                color: "#1f1f1f", // 深色字顯得專業
                wrap: true,
                align: "center",
                margin: "none"
            },
            // 分隔線 / 空白
            { type: "separator", margin: "md", color: "#f0f0f0" },

            // 2. 回饋率 (大數字)
            {
                type: "text",
                text: String(rewardRate || "-"), // 強制轉字串
                weight: "bold",
                size: "4xl",
                color: color,
                align: "center",
                margin: "md"
            },
            {
                type: "text",
                text: "回饋率",
                size: "xxs",
                color: "#aaaaaa",
                align: "center",
                margin: "xs"
            }
        ];

        // 3. 若有回饋金額 (賺 $30)，顯示金幣標籤
        if (rewardAmount) {
            bodyContents.push({
                type: "box",
                layout: "vertical",
                contents: [
                    {
                        type: "text",
                        text: `預估回饋 $${rewardAmount}`,
                        size: "sm",
                        weight: "bold",
                        color: "#856404",
                        align: "center"
                    }
                ],
                backgroundColor: "#fff3cd",
                cornerRadius: "8px",
                paddingAll: "6px",
                margin: "md"
            });
        }

        // 4. 若需切換權益 (⚠️ 需切換：集精選)
        if (rightsSwitch) {
            bodyContents.push({
                type: "box",
                layout: "horizontal",
                contents: [
                    { type: "text", text: "⚠️", size: "xs", flex: 0 },
                    { type: "text", text: `記得切換：${rightsSwitch}`, size: "xs", color: "#721c24", weight: "bold", wrap: true, margin: "sm" }
                ],
                backgroundColor: "#f8d7da",
                cornerRadius: "8px",
                paddingAll: "6px",
                margin: "sm",
                alignItems: "center",
                justifyContent: "center"
            });
        }

        return {
            type: "bubble",
            size: "kilo", // 稍微加大一點讓資訊清楚
            header: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: badge, weight: "bold", color: "#ffffff", size: "xs", align: "center" }
                ],
                backgroundColor: color,
                paddingAll: "6px"
            },
            body: {
                type: "box",
                layout: "vertical",
                contents: bodyContents,
                paddingAll: "16px"
            },
            footer: {
                type: "box",
                layout: "vertical",
                contents: [
                    {
                        type: "button",
                        action: {
                            type: "uri",
                            label: "查看規則（回饋以官方為主）",
                            uri: url || `https://www.google.com/search?q=${encodeURIComponent(cardName + " 官網 權益")}`
                        },
                        style: "primary", // 實心按鈕
                        color: color,    // 跟隨卡片主色
                        height: "sm"
                    }
                ],
                paddingAll: "10px"
            }
        };
    };

    const bubbles = [];

    // 1. [最左] 我的廣告 (固定：蝦皮)
    const shopeeAd = typeof getShopeeConfig === 'function' ? getShopeeConfig() : null;
    if (shopeeAd) {
        bubbles.push({
            type: "bubble",
            size: "kilo",
            hero: {
                type: "image",
                url: shopeeAd.imageUrl,
                size: "full",
                aspectRatio: "20:13",
                aspectMode: "cover",
                action: { type: "uri", uri: shopeeAd.link },
                backgroundColor: "#FFFFFF"
            },
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: shopeeAd.title, weight: "bold", size: "sm", color: "#EE4D2D" },
                    { type: "text", text: shopeeAd.description, wrap: true, size: "xxs", color: "#666666", margin: "sm", maxLines: 3 }
                ]
            },
            footer: {
                type: "box",
                layout: "vertical",
                contents: [
                    {
                        type: "button",
                        action: { type: "uri", label: shopeeAd.btnLabel, uri: shopeeAd.link },
                        style: "primary",
                        color: "#EE4D2D",
                        height: "sm"
                    }
                ]
            }
        });
    }

    // 2. [左二] 用戶第二名
    if (aiData.user_second) {
        bubbles.push(createCardBubble(
            "🥈 用戶第二名",
            aiData.user_second.card_name,
            aiData.user_second.reward_rate,
            "#1DB446", // Green
            aiData.user_second.reward_amount,
            aiData.user_second.rights_switch,
            aiData.user_second.official_link // 傳入官網連結
        ));
    }

    // 3. [左三] 固定廣告：匯豐 匯鑽卡 (取代原本的全域第一名位置，或安插在此)
    // 用戶要求：左三固定為 cardad 的匯鑽卡
    const hsbcAd = typeof getHsbcAdData === 'function' ? getHsbcAdData() : null;
    if (hsbcAd) {
        bubbles.push(createCardBubble(
            hsbcAd.badge,
            hsbcAd.cardName,
            hsbcAd.rewardRate,
            hsbcAd.color,
            null, // rewardAmount
            "回饋達檻 + 帳戶滿額", // rightsSwitch (簡易說明)
            hsbcAd.link
        ));
    } else if (aiData.global_best) {
        // 如果沒有 HSBC 廣告資料 (理論上會有)，才放 Global Best
        bubbles.push(createCardBubble(
            "🏆 全域第一名",
            aiData.global_best.card_name,
            aiData.global_best.reward_rate,
            "#E63946",
            aiData.global_best.reward_amount,
            aiData.global_best.rights_switch,
            aiData.global_best.official_link
        ));
    }

    // 4. [左四] 用戶第一名
    if (aiData.user_best) {
        bubbles.push(createCardBubble(
            "🥇 用戶第一名",
            aiData.user_best.card_name,
            aiData.user_best.reward_rate,
            "#457B9D", // Blue
            aiData.user_best.reward_amount,
            aiData.user_best.rights_switch,
            aiData.user_best.official_link // 傳入官網連結
        ));
    }

    return {
        type: "flex",
        altText: `推薦：${aiData.user_best ? aiData.user_best.card_name : '最佳信用卡'}`,
        contents: {
            type: "carousel",
            contents: bubbles
        }
    };
}

/**
 * 除錯/舊版相容介面
 */
function getShopeeFlex(text) {
    // 簡單的文字轉卡片，避免舊代碼報錯
    return getRecommendationFlex({
        user_best: { card_name: "AI 建議", reward_rate: "-", reason: text },
        user_second: null,
        global_best: null
    });
}

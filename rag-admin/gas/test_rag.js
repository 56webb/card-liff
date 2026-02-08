
/**
 * 官方標準 RAG 檢索測試 (參照 Google File Search Quickstart 文件)
 * 使用 gemini-2.5-flash 模型 + file_search 工具
 */
function testRAGRetrieval() {
    const props = PropertiesService.getScriptProperties();
    const apiKey = props.getProperty('GEMINI_API_KEY');
    const storeName = props.getProperty('FILE_STORE_NAME');

    if (!apiKey || !storeName) {
        Logger.log("❌ 錯誤：未設定 API Key 或 Store Name");
        return;
    }

    const testQuery = "這份文件主要在講什麼？";
    Logger.log(`\n❓ 正在透過 File Search 測試問題: "${testQuery}"`);
    Logger.log(`📦 使用 Store: ${storeName}`);

    // 使用 gemini-2.5-flash 模型
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    // 依照官方文件建構 Payload
    const payload = {
        "contents": [{
            "role": "user",
            "parts": [{ "text": testQuery }]
        }],
        "tools": [{
            "file_search": {
                "file_search_store_names": [storeName]
            }
        }]
    };

    try {
        Logger.log(`📡 送出請求...`);
        const res = UrlFetchApp.fetch(url, {
            method: "post",
            contentType: "application/json",
            payload: JSON.stringify(payload),
            muteHttpExceptions: true
        });

        const responseCode = res.getResponseCode();
        const responseText = res.getContentText();

        Logger.log(`回應代碼: ${responseCode}`);

        if (responseCode === 200) {
            const result = JSON.parse(responseText);

            // 解析回答
            if (result.candidates && result.candidates[0] && result.candidates[0].content) {
                const answer = result.candidates[0].content.parts[0].text;
                Logger.log(`\n💡 RAG 回答:\n${answer}`);

                // 檢查是否有來源引用 (Grounding Metadata)
                const metadata = result.candidates[0].groundingMetadata;
                if (metadata && metadata.groundingChunks) {
                    Logger.log(`\n📄 檢索到 ${metadata.groundingChunks.length} 個參考片段。`);
                    metadata.groundingChunks.forEach((chunk, i) => {
                        if (chunk.retrievedContext) {
                            Logger.log(`   [${i + 1}] ${chunk.retrievedContext.title || '無標題'}`);
                        }
                    });
                }
            } else {
                Logger.log("⚠️ API 回應成功但結構不如預期，完整回應如下：");
                Logger.log(responseText.substring(0, 1000));
            }
        } else {
            Logger.log(`❌ 查詢失敗 (${responseCode}):`);
            Logger.log(responseText.substring(0, 1500));
        }
    } catch (e) {
        Logger.log(`❌ 發生錯誤: ${e.toString()}`);
    }
}

/**
 * 列出目前 Store 內所有文件
 */
function listStoreDocuments() {
    const props = PropertiesService.getScriptProperties();
    const apiKey = props.getProperty('GEMINI_API_KEY');
    const storeName = props.getProperty('FILE_STORE_NAME');

    if (!storeName) {
        Logger.log("❌ 錯誤：未設定 FILE_STORE_NAME");
        return;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/${storeName}/documents?key=${apiKey}`;

    try {
        const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
        const data = JSON.parse(res.getContentText());

        if (data.documents && data.documents.length > 0) {
            Logger.log(`📚 Store [${storeName}] 中有 ${data.documents.length} 份文件：`);
            data.documents.forEach((doc, i) => {
                Logger.log(`   [${i + 1}] ${doc.displayName || doc.name}`);
            });
        } else {
            Logger.log(`⚠️ Store [${storeName}] 是空的，尚無文件。`);
        }
    } catch (e) {
        Logger.log(`❌ 發生錯誤: ${e.toString()}`);
    }
}

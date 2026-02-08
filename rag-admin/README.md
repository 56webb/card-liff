# CardWay RAG Admin Panel

這是一個獨立的 Web 控制面板，用於管理 Gemini RAG 知識庫 (File Search Store)。

## 🚀 快速開始

1. **啟動開發伺服器**：
   在終端機執行 `npm run dev` (如果尚未執行)。
   
2. **存取網頁**：
   通常在 `http://localhost:5173`。

3. **設定連線**：
   * 網頁啟動時會要求輸入 **Gemini API Key**。
   * 會要求輸入 **File Store Name** (格式如：`fileSearchStores/gas-xxx`)。
   * 這些資訊會儲存在您的瀏覽器 localStorage 中。

## ✨ 主要功能

*   **Cyberpunk UI**：具備動態霓虹效果與終端機風格 Log。
*   **查看清單**：即時列出知識庫中的所有 Documents 及其顯示名稱。
*   **檔案管理**：點擊 `DELETE` 即可強制刪除特定文件。
*   **系統日誌**：所有 API 互動都會記錄在下方的虛擬終端機中。

## 🛠️ 技術棧
*   Vite (Frontend Tooling)
*   Vanilla JS / CSS
*   Google Generative AI REST API (v1beta)

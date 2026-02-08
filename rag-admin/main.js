import './style.css'

// --- 設定區 ---
let GEMINI_API_KEY = localStorage.getItem('GEMINI_API_KEY') || '';
let FILE_STORE_NAME = localStorage.getItem('FILE_STORE_NAME') || '';
let GAS_WEBAPP_URL = localStorage.getItem('GAS_WEBAPP_URL') || '';

// 本地暫存
let filenameMap = {};
let cachedDocs = []; // 儲存處理後的完整文件資料
let sortState = {
    column: 'createTime', // 'name' | 'createTime'
    order: 'desc'         // 'asc' | 'desc'
};

// --- UI 元件 ---
const logBox = document.getElementById('terminal-log');
const docList = document.getElementById('document-list');
const docCountEl = document.getElementById('doc-count');
const apiStatusEl = document.getElementById('api-status');
const storeIdEl = document.getElementById('store-id');

// Settings Elements
const modal = document.getElementById('settings-modal');
const inputApiKey = document.getElementById('input-api-key');
const inputStoreName = document.getElementById('input-store-name');
const inputGasUrl = document.getElementById('input-gas-url');
const btnSettings = document.getElementById('btn-settings');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');

// Edit Name Modal Elements
const editModal = document.getElementById('edit-name-modal');
const inputNewName = document.getElementById('input-new-name');
const inputEditDocName = document.getElementById('edit-doc-name');
const btnSaveName = document.getElementById('btn-save-name');
const btnCloseEdit = document.getElementById('btn-close-edit');

// --- 輔助函式：新增 Log ---
function addLog(msg, type = 'info', isHtml = false) {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    if (isHtml) {
        line.innerHTML = `[${time}] ${msg}`;
    } else {
        line.innerText = `[${time}] ${msg}`;
    }
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
}

// --- 初始化檢查 ---
async function init() {
    addLog('系統檢查: 正在驗證 API 配置...');

    inputApiKey.value = GEMINI_API_KEY;
    inputStoreName.value = FILE_STORE_NAME;
    inputGasUrl.value = GAS_WEBAPP_URL;

    // 綁定表頭排序事件
    const thName = document.getElementById('th-name');
    const thDate = document.getElementById('th-date');
    if (thName) thName.onclick = () => toggleSort('name');
    if (thDate) thDate.onclick = () => toggleSort('createTime');

    if (!GEMINI_API_KEY || !FILE_STORE_NAME) {
        addLog('需要初始設定。正在開啟設定視窗...', 'warning');
        openSettings();
    } else {
        updateUIStatus();
        await fetchFilenameMap();
        await fetchDocuments();
        renderHeaderIcons();
    }
}

function updateUIStatus() {
    if (GEMINI_API_KEY && FILE_STORE_NAME) {
        apiStatusEl.innerText = '連線正常';
        apiStatusEl.className = 'value online';
        storeIdEl.innerText = FILE_STORE_NAME.split('/').pop();
    } else {
        apiStatusEl.innerText = '未設定';
        apiStatusEl.className = 'value offline';
        storeIdEl.innerText = '尚未設定儲存庫';
    }
}

function openSettings() {
    modal.classList.remove('hidden');
}

function closeSettings() {
    modal.classList.add('hidden');
}

// --- 事件綁定 ---
if (btnSettings) btnSettings.onclick = openSettings;
if (btnCloseSettings) btnCloseSettings.onclick = closeSettings;

if (btnSaveSettings) btnSaveSettings.onclick = async () => {
    const newKey = inputApiKey.value.trim();
    const newStore = inputStoreName.value.trim();
    const newGasUrl = inputGasUrl.value.trim();

    GEMINI_API_KEY = newKey;
    FILE_STORE_NAME = newStore;
    GAS_WEBAPP_URL = newGasUrl;

    localStorage.setItem('GEMINI_API_KEY', newKey);
    localStorage.setItem('FILE_STORE_NAME', newStore);
    localStorage.setItem('GAS_WEBAPP_URL', newGasUrl);

    addLog('設定已更新。', 'success');
    closeSettings();
    updateUIStatus();
    await fetchFilenameMap();
    await fetchDocuments();
};

// --- 從 GAS 抓取對照表 ---
async function fetchFilenameMap() {
    if (!GAS_WEBAPP_URL) return;
    try {
        const separator = GAS_WEBAPP_URL.includes('?') ? '&' : '?';
        const url = `${GAS_WEBAPP_URL}${separator}action=getMap&_t=${Date.now()}`;
        const res = await fetch(url, { cache: 'no-store' });
        const data = await res.json();
        if (data.status === 'ok' && data.nameMap) {
            filenameMap = data.nameMap;
            addLog(`對照表已同步 (共 ${Object.keys(filenameMap).length} 筆)`);
        }
    } catch (err) {
        console.warn('無法抓取對照表:', err);
    }
}

// --- REST API 互動 ---
async function fetchDocuments() {
    if (!GEMINI_API_KEY || !FILE_STORE_NAME) return;

    // 移除 _t 參數，且 REST API 的 pageSize 最大限制為 20 (與 GAS 不同)
    const url = `https://generativelanguage.googleapis.com/v1beta/${FILE_STORE_NAME}/documents?key=${GEMINI_API_KEY}&pageSize=20`;

    try {
        const res = await fetch(url, {
            method: 'GET',
            cache: 'no-store', // 強制瀏覽器不使用快取
            headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        });
        const data = await res.json();

        if (data.error) {
            addLog(`API 錯誤: ${data.error.message}`, 'error');
            return;
        }

        const rawDocs = data.documents || [];

        // 預處理資料：計算顯示名稱與時間物件
        const idMap = new Map();
        if (filenameMap) {
            Object.entries(filenameMap).forEach(([fullPath, chineseName]) => {
                const id = fullPath.split('/').pop();
                idMap.set(id, chineseName);
            });
        }

        cachedDocs = rawDocs.map(doc => {
            const shortId = doc.name.split('/').pop();
            // 查找順序: ID對照表 > FullPath對照表 > API名稱 > ShortId
            const chineseName = idMap.get(shortId) || filenameMap[doc.name];
            const finalName = chineseName || doc.displayName || shortId;

            // 處理時間
            const createTime = doc.createTime ? new Date(doc.createTime) : new Date(0);

            return {
                ...doc,
                shortId: shortId,
                finalName: finalName,
                createTimeObj: createTime,
                displayTime: createTime.toLocaleString('zh-TW', { hour12: false })
            };
        });

        applySort(); // 排序並渲染
        docCountEl.innerText = cachedDocs.length;

    } catch (err) {
        addLog(`列表抓取失敗: ${err.message}`, 'error');
    }
}

// --- 排序邏輯 ---
function toggleSort(column) {
    if (sortState.column === column) {
        // 同欄位切換順序
        sortState.order = sortState.order === 'asc' ? 'desc' : 'asc';
    } else {
        // 切換新欄位 (預設降冪)
        sortState.column = column;
        sortState.order = 'desc';
    }
    renderHeaderIcons();
    applySort();
}

function renderHeaderIcons() {
    const iconName = document.getElementById('icon-sort-name');
    const iconDate = document.getElementById('icon-sort-date');
    const thName = document.getElementById('th-name');
    const thDate = document.getElementById('th-date');

    if (!iconName || !iconDate) return;

    // 重置所有箭頭
    iconName.innerHTML = '';
    iconDate.innerHTML = '';

    // 設定當前箭頭
    const targetIcon = sortState.column === 'name' ? iconName : iconDate;
    const arrow = sortState.order === 'asc' ? '▲' : '▼';
    targetIcon.innerHTML = `&nbsp;${arrow}`;

    // 更新顏色狀態
    if (thName) thName.style.color = sortState.column === 'name' ? 'var(--neon-cyan)' : 'var(--text-base)';
    if (thDate) thDate.style.color = sortState.column === 'createTime' ? 'var(--neon-cyan)' : 'var(--text-base)';
}

function applySort() {
    if (cachedDocs.length === 0) {
        renderDocs([]);
        return;
    }

    cachedDocs.sort((a, b) => {
        let valA, valB;
        if (sortState.column === 'name') {
            valA = a.finalName || '';
            valB = b.finalName || '';
            return sortState.order === 'asc'
                ? valA.localeCompare(valB, 'zh-Hant')
                : valB.localeCompare(valA, 'zh-Hant');
        } else {
            valA = a.createTimeObj.getTime();
            valB = b.createTimeObj.getTime();
            return sortState.order === 'asc' ? valA - valB : valB - valA;
        }
    });

    renderDocs(cachedDocs);
}

// --- 渲染表格 ---
function renderDocs(docs) {
    if (docs.length === 0) {
        docList.innerHTML = '<tr><td colspan="5" class="empty-msg">儲存庫內無文件。</td></tr>';
        return;
    }

    docList.innerHTML = docs.map((doc, idx) => {
        return `
            <tr>
                <td>${idx + 1}</td>
                <td style="color: var(--neon-cyan); font-weight: 500;">${doc.finalName}</td>
                <td style="font-size: 0.85rem; color: var(--text-base);">${doc.displayTime}</td>
                <td style="font-size: 0.75rem; color: var(--text-dim)">${doc.shortId}</td>
                <td>
                    <button class="edit-btn" onclick="window.editDocName('${doc.name}', '${doc.finalName.replace(/'/g, "\\'")}')">✏️</button>
                    <button class="delete-btn" onclick="window.deleteDoc('${doc.name}')">🗑️</button>
                </td>
            </tr>
        `;
    }).join('');
}

// --- 刪除文件 ---
window.deleteDoc = async (docName) => {
    if (!confirm('確認要刪除此文件？')) return;

    const url = `https://generativelanguage.googleapis.com/v1beta/${docName}?key=${GEMINI_API_KEY}&force=true`;

    try {
        const res = await fetch(url, {
            method: 'DELETE',
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        });
        if (res.status === 200 || res.status === 204) {
            addLog('銷毀成功。', 'success');
            // 從 cachedDocs 移除
            cachedDocs = cachedDocs.filter(d => d.name !== docName);
            delete filenameMap[docName];
            // 重新渲染，不一定要重抓 API
            applySort();
            docCountEl.innerText = cachedDocs.length;
        } else {
            const err = await res.json();
            addLog(`刪除失敗: ${err.error.message}`, 'error');
        }
    } catch (err) {
        addLog(`刪除異常: ${err.message}`, 'error');
    }
};

// --- GAS API 連線 ---
async function callGasApi(action) {
    if (!GAS_WEBAPP_URL) {
        alert('請先設定 GAS WebApp URL');
        return;
    }

    const actionText = action === 'sync' ? '雲端同步' : '清空儲存庫';
    addLog(`發動 ${actionText}...`, 'warning');

    const separator = GAS_WEBAPP_URL.includes('?') ? '&' : '?';
    const finalUrl = `${GAS_WEBAPP_URL}${separator}action=${action}&_t=${Date.now()}`;

    try {
        const res = await fetch(finalUrl, {
            method: 'GET',
            mode: 'cors',
            cache: 'no-store'
        });

        const text = await res.text();
        const data = JSON.parse(text);

        if (data.status === 'ok') {
            addLog(`${actionText} 回報: ${data.message}`, 'success');
            if (data.nameMap) filenameMap = data.nameMap;

            // 若後端回傳新的 Store Name，更新本地設定
            if (data.storeName && data.storeName !== FILE_STORE_NAME) {
                FILE_STORE_NAME = data.storeName;
                localStorage.setItem('FILE_STORE_NAME', FILE_STORE_NAME);
                if (inputStoreName) inputStoreName.value = FILE_STORE_NAME;
                addLog(`已同步 Store ID: ${FILE_STORE_NAME}`, 'warning');
                updateUIStatus();
            }

            if (action === 'clear') {
                addLog('等待 API 釋放資源...', 'info');
                setTimeout(async () => {
                    await fetchFilenameMap();
                    await fetchDocuments();
                    addLog('列表刷新完成。', 'success');
                }, 2000);
            } else {
                await fetchFilenameMap();
                await fetchDocuments();
            }
        } else {
            addLog(`任務失敗: ${data.message}`, 'error');
        }
    } catch (err) {
        addLog(`連線失敗: ${err.message}`, 'error');
    }
}

document.getElementById('btn-sync').onclick = () => callGasApi('sync');
document.getElementById('btn-clear').onclick = () => {
    if (confirm('確定要執行強化清空嗎？')) {
        callGasApi('clear');
    }
};

// --- 編輯名稱功能 ---
window.editDocName = (docName, currentName) => {
    inputEditDocName.value = docName;
    inputNewName.value = currentName;
    editModal.classList.remove('hidden');
    inputNewName.focus();
};

if (btnCloseEdit) btnCloseEdit.onclick = () => {
    editModal.classList.add('hidden');
};

if (btnSaveName) btnSaveName.onclick = async () => {
    const docName = inputEditDocName.value;
    const newName = inputNewName.value.trim();

    if (!newName) {
        alert('名稱不能為空');
        return;
    }

    if (!GAS_WEBAPP_URL) {
        alert('請先設定 GAS WebApp URL');
        return;
    }

    addLog(`正在更新名稱: ${newName}...`, 'warning');

    const separator = GAS_WEBAPP_URL.includes('?') ? '&' : '?';
    const url = `${GAS_WEBAPP_URL}${separator}action=updateName&docName=${encodeURIComponent(docName)}&newName=${encodeURIComponent(newName)}&_t=${Date.now()}`;

    try {
        const res = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store' });
        const data = await res.json();

        if (data.status === 'ok') {
            addLog(`✅ 名稱更新成功: ${newName}`, 'success');
            filenameMap = data.nameMap;
            // 更新 cachedDocs 中對應的 finalName
            const doc = cachedDocs.find(d => d.name === docName);
            if (doc) doc.finalName = newName;
            applySort();
            editModal.classList.add('hidden');
        } else {
            addLog(`❌ 更新失敗: ${data.message}`, 'error');
        }
    } catch (err) {
        addLog(`❌ 連線失敗: ${err.message}`, 'error');
    }
};

// =====================
// RAG 問答功能
// =====================
const HISTORY_KEY = 'RAG_QA_HISTORY';
const HISTORY_EXPIRY_DAYS = 7;

const inputQuestion = document.getElementById('input-question');
const btnAsk = document.getElementById('btn-ask');
const qaAnswerBox = document.getElementById('qa-answer-box');
const qaSources = document.getElementById('qa-sources');
const qaHistory = document.getElementById('qa-history');
const btnClearHistory = document.getElementById('btn-clear-history');
const selectModel = document.getElementById('select-model');

// 載入對話歷史
function loadHistory() {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    try {
        const history = JSON.parse(raw);
        // 過濾掉超過一週的項目
        const now = Date.now();
        const validHistory = history.filter(item => {
            return (now - item.timestamp) < HISTORY_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
        });
        // 如果有過期項目被移除，更新 localStorage
        if (validHistory.length !== history.length) {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(validHistory));
        }
        return validHistory;
    } catch (e) {
        return [];
    }
}

// 儲存對話歷史
function saveHistory(history) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

// 渲染對話歷史
function renderHistory() {
    const history = loadHistory();
    if (history.length === 0) {
        qaHistory.innerHTML = '<div style="color: var(--text-dim); font-size: 0.85rem;">尚無對話記錄</div>';
        return;
    }
    qaHistory.innerHTML = history.map(item => {
        const time = new Date(item.timestamp).toLocaleString('zh-TW', { hour12: false });
        const shortAnswer = item.answer.length > 200 ? item.answer.substring(0, 200) + '...' : item.answer;
        return `
            <div class="qa-history-item">
                <div class="qa-history-q">Q: ${item.question}</div>
                <div class="qa-history-a">${shortAnswer}</div>
                <div class="qa-history-time">${time}</div>
            </div>
        `;
    }).reverse().join('');
}

// 發送問題
async function askQuestion() {
    const question = inputQuestion.value.trim();
    if (!question) {
        alert('請輸入問題');
        return;
    }
    if (!GAS_WEBAPP_URL) {
        alert('請先設定 GAS WebApp URL');
        return;
    }

    qaAnswerBox.innerHTML = '<div class="qa-loading">🔍 正在查詢知識庫...</div>';
    qaSources.innerHTML = '';

    const model = selectModel ? selectModel.value : 'gemini-2.5-flash';
    addLog(`📤 發送問題 (模型: ${model}): ${question}`, 'warning');

    const separator = GAS_WEBAPP_URL.includes('?') ? '&' : '?';
    const url = `${GAS_WEBAPP_URL}${separator}action=askQuestion&question=${encodeURIComponent(question)}&model=${encodeURIComponent(model)}&_t=${Date.now()}`;

    try {
        const res = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store' });
        const data = await res.json();

        if (data.status === 'ok') {
            addLog('✅ 收到回答', 'success');

            // ---除錯資訊開始---
            if (data.sources && data.sources.length > 0) {
                const firstUri = data.sources[0].uri;
                addLog(`🔍 Debug Source: ...${firstUri.slice(-30)}`, 'info');

                const mapKeys = Object.keys(filenameMap || {});
                if (mapKeys.length > 0) {
                    addLog(`🔍 Debug MapKey: ...${mapKeys[0].slice(-30)}`, 'info');
                } else {
                    addLog(`⚠️ Debug: 前端對照表為空`, 'warning');
                }
            } else {
                addLog('ℹ️ 此回答未引用任何文件來源', 'info');
                // 即使沒有來源，也印出 Map Key 確認對照表是否載入成功
                const mapKeys = Object.keys(filenameMap || {});
                if (mapKeys.length > 0) {
                    addLog(`🔍 Debug MapKey (已載入): ...${mapKeys[0].slice(-30)}`, 'info');
                }
            }
            // ---除錯資訊結束---

            // 更新本地對照表
            if (data.nameMap) {
                filenameMap = { ...filenameMap, ...data.nameMap };
                // 這裡可以選擇是否觸發畫面對照表的更新，目前先不動
                addLog('🔄 已同步最新文件對照表', 'warning');
            }

            qaAnswerBox.innerHTML = data.answer || '(無回答內容)';

            // 處理引用來源標題
            let processedSources = [];
            if (data.sources && data.sources.length > 0) {
                processedSources = data.sources.map(s => {
                    let finalTitle = s.title;
                    const uri = s.uri;

                    // 嘗試匹配中文名稱
                    // 對照表格式: "fileSearchStores/.../documents/xxx": "中文檔名.pdf"
                    // URI 格式可能包含 documents/xxx
                    for (const [docPath, displayName] of Object.entries(filenameMap)) {
                        const docId = docPath.split('/').pop();
                        if (uri.includes(docId)) {
                            finalTitle = displayName;
                            break;
                        }
                    }
                    return { ...s, title: finalTitle };
                });

                qaSources.innerHTML = '<strong>📚 引用來源:</strong><br>' +
                    processedSources.map(s => `<div class="qa-source-item">• ${s.title}</div>`).join('');
            } else {
                qaSources.innerHTML = '';
            }

            // 儲存到歷史
            const history = loadHistory();
            history.push({
                question: question,
                answer: data.answer,
                sources: processedSources, // 儲存處理過(含中文名)的來源
                timestamp: Date.now()
            });
            saveHistory(history);
            renderHistory();

            // 清空輸入框
            inputQuestion.value = '';
        } else {
            addLog(`❌ 問答失敗: ${data.message}`, 'error');
            qaAnswerBox.innerHTML = `<div style="color: #ff3e3e;">錯誤: ${data.message}</div>`;
        }
    } catch (err) {
        addLog(`❌ 連線失敗: ${err.message}`, 'error');
        qaAnswerBox.innerHTML = `<div style="color: #ff3e3e;">連線失敗: ${err.message}</div>`;
    }
}

// 綁定事件
if (btnAsk) {
    btnAsk.onclick = askQuestion;
}

if (btnClearHistory) {
    btnClearHistory.onclick = () => {
        if (confirm('確定要清除所有對話歷史嗎？')) {
            localStorage.removeItem(HISTORY_KEY);
            renderHistory();
            addLog('🗑️ 對話歷史已清除', 'success');
        }
    };
}

// 初始化時渲染歷史
renderHistory();

init();

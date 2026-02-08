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
                    <button class="delete-btn" onclick="window.deleteDoc('${doc.name}')">刪除</button>
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

init();

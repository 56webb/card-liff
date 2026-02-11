import './style.css'

// =============================================
// 信用卡爬蟲核心邏輯 (v2026.02.11 Fix 4 - Drive Upload + Prompt Presets)
// =============================================

// --- 狀態管理 ---
let cards = [];          // 所有卡片資料
let results = {};        // cardId -> { status, markdown, error }
let isRunning = false;
let isPaused = false;
let abortController = null;

// --- 設定 (localStorage 持久化) ---
const CONFIG_KEYS = {
    PPLX_KEY: 'CRAWLER_PPLX_KEY',
    GAS_URL: 'CRAWLER_GAS_URL',
    MODEL: 'CRAWLER_MODEL',
    TIME_PERIOD: 'CRAWLER_TIME_PERIOD',
    PROMPT_TEMPLATE: 'CRAWLER_PROMPT_TEMPLATE',
    PROMPT_PRESETS: 'CRAWLER_PROMPT_PRESETS', // 新增：Prompt 範本儲存
};

// --- Default Templates ---
const TEMPLATE_STANDARD = `請擔任專業的「金融產品條款分析師」，針對【{{bank}} {{name}}】進行 {{timePeriod}} 的最新權益深度搜索。

請務必進行深度聯網搜尋，優先查找該銀行的官方網頁、權益手冊 PDF。
【重要】請模仿 Perplexity 網頁版的深度搜尋模式：
1. 先搜尋該卡片的官方網頁。
2. 確認是否有「2026」或「115年」的權益更新公告。
3. 若無明確 2026 公告，請查看最新的權益手冊有效期限。
4. 若確實無法確認，請標註「⚠️ 待確認」。
確保資訊完整且正確。

🆔 卡片編號：{{id}}
🏷️ 市場定位：{{positioning}}

# 請以下列 Markdown 格式輸出完整分析報告：

## 基本資訊
| 項目 | 內容 |
|------|------|
| 發卡銀行 | （填入） |
| 卡片全名 | （填入） |
| 卡片等級 | （填入） |
| 年費 | 金額、首年是否免費 |
| 官方連結 | URL |

## 回饋機制總覽
| 消費場景 | 回饋類型 | 回饋率 | 每月上限 | 備註 |
|----------|----------|--------|----------|------|
| 國內一般消費 | | | | |
| 海外一般消費 | | | | |
| 指定通路加碼 | | | | |

## 回饋的魔鬼細節 (排除項目、上限計算、需登錄活動等)

## 優缺點總結

## 資料來源
`;

const TEMPLATE_DEV_JSON = `## 模式二：開發者模式 (JSON Format)

請針對【{{bank}} {{name}}】({{timePeriod}}) 進行深度調研，並將所有權益資料結構化為 JSON 格式。

輸出格式要求：
請務必將所有輸出內容全部包在一個 Markdown Code Block (json) 裡面。

JSON 結構需包含：
1. "基本資料": { 銀行名稱, 卡片名稱, 適用期間, 年費, 核心特色 }
2. "回饋機制": { 最高回饋, 方案: [ {名稱, 比例, 通路} ] }
3. "指定通路清單": { 行動支付: [], 百貨: [], 旅遊海外: [], 數位: [] ... }
4. "排除項目": [ ... ]
5. "點數系統": { 名稱, 價值, 有效期 }
6. "特殊優惠": [ ... ]

🆔 卡片編號：{{id}}
`;

const TEMPLATE_AUDIT = `## 模式三：陷阱排查模式 (Audit Mode)

請針對【{{bank}} {{name}}】({{timePeriod}}) 進行嚴格的條款審查，重點列出「地雷區」。

# {{bank}} - {{name}} 2026 陷阱排查報告

### 地雷區一：方案切換規則
- **官方規則說明**：
- **常見誤解**：
- **實際案例**：
- **破解策略**：

### 地雷區二：絕對不回饋的排除項目
- **官方規則說明**：
- **常見誤解**：
- **實際案例**：
- **破解策略**：

### 地雷區三：第三方支付認列問題
- **官方規則說明**：
- **常見誤解**：
- **實際案例**：
- **破解策略**：

### 地雷區四：百貨店中櫃問題
### 地雷區五：分期付款回饋規則
### 地雷區六：點數有效期限與兌換限制

**資料來源**：請詳細列出參考的官方文件連結。
`;

const DEFAULT_PRESETS = {
    '預設標準版': TEMPLATE_STANDARD,
    '開發者模式 (JSON)': TEMPLATE_DEV_JSON,
    '陷阱排查模式': TEMPLATE_AUDIT
};

const DEFAULT_PROMPT_TEMPLATE = TEMPLATE_STANDARD;

function loadConfig() {
    return {
        pplxKey: localStorage.getItem(CONFIG_KEYS.PPLX_KEY) || '',
        gasUrl: localStorage.getItem(CONFIG_KEYS.GAS_URL) || '',
        model: localStorage.getItem(CONFIG_KEYS.MODEL) || 'sonar-pro',
        timePeriod: localStorage.getItem(CONFIG_KEYS.TIME_PERIOD) || '2026 年上半年（2026/01/01 - 2026/06/30）',
        promptTemplate: localStorage.getItem(CONFIG_KEYS.PROMPT_TEMPLATE) || DEFAULT_PROMPT_TEMPLATE,
        presets: JSON.parse(localStorage.getItem(CONFIG_KEYS.PROMPT_PRESETS)) || DEFAULT_PRESETS
    };
}

function saveConfig(cfg) {
    localStorage.setItem(CONFIG_KEYS.PPLX_KEY, cfg.pplxKey);
    localStorage.setItem(CONFIG_KEYS.GAS_URL, cfg.gasUrl);
    localStorage.setItem(CONFIG_KEYS.MODEL, cfg.model);
    localStorage.setItem(CONFIG_KEYS.TIME_PERIOD, cfg.timePeriod);
    localStorage.setItem(CONFIG_KEYS.PROMPT_TEMPLATE, cfg.promptTemplate);
    if (cfg.presets) {
        localStorage.setItem(CONFIG_KEYS.PROMPT_PRESETS, JSON.stringify(cfg.presets));
    }
}

// --- UI 元件 ---
const logBox = document.getElementById('terminal-log');
const cardListEl = document.getElementById('card-list');

function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.innerText = `[${time}] ${msg}`;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
}

function updateGuideStep(step) {
    for (let i = 1; i <= 3; i++) {
        const el = document.getElementById(`guide-step-${i}`);
        if (el) {
            el.classList.toggle('active', i === step);
            el.classList.toggle('done', i < step);
        }
    }
}

// --- 初始化 ---
function init() {
    const cfg = loadConfig();

    // 回填設定
    const inputPplxKey = document.getElementById('input-pplx-key');
    const inputGasUrl = document.getElementById('input-gas-url');
    const selectModel = document.getElementById('select-pplx-model');
    const inputTimePeriod = document.getElementById('input-time-period');
    const inputPromptTemplate = document.getElementById('input-prompt-template');

    if (inputPplxKey) inputPplxKey.value = cfg.pplxKey;
    if (inputGasUrl) inputGasUrl.value = cfg.gasUrl;
    if (selectModel) selectModel.value = cfg.model;
    if (inputTimePeriod) inputTimePeriod.value = cfg.timePeriod;
    if (inputPromptTemplate) inputPromptTemplate.value = cfg.promptTemplate;

    // 初始化 Presets Dropdown
    renderPresets(cfg.presets);

    // 如果已有設定，自動載入
    if (cfg.pplxKey && cfg.gasUrl) {
        addLog('✅ 偵測到已儲存的設定，API Key 與 GAS URL 已就緒。');
        updateGuideStep(2);
    }

    bindEvents();
}

function renderPresets(presets) {
    const select = document.getElementById('select-prompt-preset');
    if (!select) return;

    // 清空除了第一項以外的選項
    select.innerHTML = '<option value="">-- 切換 Prompt 範本 --</option>';

    Object.keys(presets).forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    });
}

// --- 事件綁定 ---
function bindEvents() {
    // 儲存設定
    document.getElementById('btn-save-config')?.addEventListener('click', () => {
        const cfg = loadConfig(); // 讀取現有，避免覆蓋 presets
        cfg.pplxKey = document.getElementById('input-pplx-key').value.trim();
        cfg.gasUrl = document.getElementById('input-gas-url').value.trim();
        cfg.model = document.getElementById('select-pplx-model').value;
        cfg.timePeriod = document.getElementById('input-time-period').value.trim();
        cfg.promptTemplate = document.getElementById('input-prompt-template').value;

        if (!cfg.pplxKey) { alert('請輸入 Perplexity API Key'); return; }
        if (!cfg.gasUrl) { alert('請輸入 GAS WebApp URL'); return; }

        saveConfig(cfg);
        addLog('💾 設定已儲存到瀏覽器。', 'success');
    });

    // Preset 相關事件
    document.getElementById('select-prompt-preset')?.addEventListener('change', (e) => {
        const name = e.target.value;
        if (!name) return;

        const cfg = loadConfig();
        if (cfg.presets[name]) {
            document.getElementById('input-prompt-template').value = cfg.presets[name];
            // 自動儲存當前選擇
            cfg.promptTemplate = cfg.presets[name];
            saveConfig(cfg);
            addLog(`📝 已載入範本: ${name}`, 'info');
        }
    });

    document.getElementById('btn-save-preset')?.addEventListener('click', () => {
        const currentContent = document.getElementById('input-prompt-template').value;
        if (!currentContent) return;

        const name = prompt('請輸入新範本名稱：', '我的自訂範本');
        if (name) {
            const cfg = loadConfig();
            cfg.presets[name] = currentContent;
            cfg.promptTemplate = currentContent;
            saveConfig(cfg);
            renderPresets(cfg.presets);
            // 選中新項目
            document.getElementById('select-prompt-preset').value = name;
            addLog(`💾 已儲存新範本: ${name}`, 'success');
        }
    });

    document.getElementById('btn-delete-preset')?.addEventListener('click', () => {
        const select = document.getElementById('select-prompt-preset');
        const name = select.value;
        if (!name) { alert('請先選擇一個範本！'); return; }

        if (confirm(`確定要刪除範本「${name}」嗎？`)) {
            const cfg = loadConfig();
            delete cfg.presets[name];
            saveConfig(cfg);
            renderPresets(cfg.presets);
            select.value = "";
            addLog(`🗑️ 已刪除範本: ${name}`, 'warning');
        }
    });


    // 載入卡片
    document.getElementById('btn-load-cards')?.addEventListener('click', loadCardsFromSheet);

    // 全選 / 取消
    document.getElementById('btn-select-all')?.addEventListener('click', () => selectAll(true));
    document.getElementById('btn-deselect-all')?.addEventListener('click', () => selectAll(false));
    document.getElementById('th-check-all')?.addEventListener('change', (e) => selectAll(e.target.checked));

    // 搜尋過濾
    document.getElementById('input-filter')?.addEventListener('input', (e) => {
        filterCards(e.target.value);
    });

    // 開始爬取
    document.getElementById('btn-start')?.addEventListener('click', startCrawl);
    document.getElementById('btn-pause')?.addEventListener('click', togglePause);
    document.getElementById('btn-retry-failed')?.addEventListener('click', retryFailed);

    // 下載
    document.getElementById('btn-download-zip')?.addEventListener('click', () => downloadZip('all'));
    document.getElementById('btn-download-success')?.addEventListener('click', () => downloadZip('success'));
    document.getElementById('btn-upload-drive')?.addEventListener('click', uploadToDrive);

    // 預覽
    document.getElementById('select-preview')?.addEventListener('change', (e) => {
        previewCard(e.target.value);
    });

    // 複製
    document.getElementById('btn-copy-preview')?.addEventListener('click', () => {
        const content = document.getElementById('preview-content')?.textContent;
        if (content) {
            navigator.clipboard.writeText(content);
            addLog('📋 已複製到剪貼簿！', 'success');
        }
    });
}

// --- 從 Sheet 載入卡片 ---
async function loadCardsFromSheet() {
    const gasUrl = document.getElementById('input-gas-url').value.trim();
    if (!gasUrl) { alert('請先輸入 GAS WebApp URL'); return; }

    addLog('📥 正在從 Google Sheet 載入卡片清單...', 'warning');

    try {
        const separator = gasUrl.includes('?') ? '&' : '?';
        const targetUrl = `${gasUrl}${separator}action=getCardList&_t=${Date.now()}`;

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=utf-8',
            },
            body: JSON.stringify({ action: 'getCardList' })
        });

        const data = await response.json();

        if (data.status === 'ok' && data.cards) {
            cards = data.cards;
            results = {};
            renderCardTable();
            addLog(`✅ 成功載入 ${cards.length} 張卡片！`, 'success');
            updateGuideStep(2);
        } else {
            const debugMsg = JSON.stringify(data);
            addLog(`❌ 載入失敗: ${data.message || '未知錯誤'} (Response: ${debugMsg})`, 'error');
        }
    } catch (err) {
        // Failover to GET
        console.error(err);
        addLog(`⚠️ POST 失敗 (${err.message})，嘗試僅使用 GET...`, 'warning');
        try {
            const separator = gasUrl.includes('?') ? '&' : '?';
            const url = `${gasUrl}${separator}action=getCardList&_t=${Date.now()}`;
            const res = await fetch(url);
            const data = await res.json();
            if (data.status === 'ok' && data.cards) {
                cards = data.cards;
                results = {};
                renderCardTable();
                addLog(`✅ (GET) 成功載入 ${cards.length} 張卡片！`, 'success');
                updateGuideStep(2);
                return;
            }
            throw new Error(data.message || 'GET 也失敗');
        } catch (e) {
            addLog(`❌ 連線失敗: ${e.message}`, 'error');
        }
    }
}

// --- 渲染卡片表格 ---
function renderCardTable(filterText = '') {
    const filter = filterText.toLowerCase();

    const filteredCards = cards.filter(card => {
        if (!filter) return true;
        return (card.id + card.bank + card.name + card.positioning).toLowerCase().includes(filter);
    });

    if (filteredCards.length === 0) {
        cardListEl.innerHTML = `<tr><td colspan="8" class="empty-msg">無符合條件的卡片</td></tr>`;
        return;
    }

    cardListEl.innerHTML = filteredCards.map((card, idx) => {
        const r = results[card.id];
        const statusHtml = getStatusHtml(r);
        const checked = r?.selected !== false ? 'checked' : '';
        const globalIdx = cards.indexOf(card);

        return `
      <tr data-id="${card.id}" class="${r?.status === 'success' ? 'row-success' : r?.status === 'error' ? 'row-error' : ''}">
        <td><input type="checkbox" class="card-check" data-idx="${globalIdx}" ${checked}></td>
        <td>${idx + 1}</td>
        <td style="color: var(--neon-cyan); font-family: var(--font-mono); font-size: 0.8rem;">${card.id}</td>
        <td>${card.bank}</td>
        <td style="font-weight: 600;">${card.name}</td>
        <td style="font-size: 0.85rem; color: var(--text-dim);">${card.positioning}</td>
        <td>${statusHtml}</td>
        <td>
          ${r?.status === 'success' ? `<button class="edit-btn" onclick="window.previewById('${card.id}')">👁️</button>` : ''}
        </td>
      </tr>
    `;
    }).join('');

    document.querySelectorAll('.card-check').forEach(cb => {
        cb.addEventListener('change', updateSelectedCount);
    });

    updateSelectedCount();
}

function getStatusHtml(r) {
    if (!r || !r.status) return '<span style="color: var(--text-dim);">⏳ 等待</span>';
    if (r.status === 'running') return '<span style="color: var(--neon-cyan);">🔄 爬取中</span>';
    if (r.status === 'success') return '<span style="color: #00ff88;">✅ 完成</span>';
    if (r.status === 'error') return `<span style="color: #ff3e3e;" title="${r.error || ''}">❌ 失敗</span>`;
    return '<span style="color: var(--text-dim);">⏳</span>';
}

function selectAll(checked) {
    document.querySelectorAll('.card-check').forEach(cb => { cb.checked = checked; });
    document.getElementById('th-check-all').checked = checked;
    updateSelectedCount();
}

function filterCards(text) {
    renderCardTable(text);
}

function updateSelectedCount() {
    const total = document.querySelectorAll('.card-check:checked').length;
    const countEl = document.getElementById('selected-count');
    if (countEl) countEl.textContent = `已選 ${total} 張`;
}

function getSelectedCards() {
    const checked = document.querySelectorAll('.card-check:checked');
    return Array.from(checked).map(cb => {
        const idx = parseInt(cb.dataset.idx);
        return cards[idx];
    }).filter(Boolean);
}

// --- Perplexity API 呼叫 ---
function buildPrompt(card) {
    const cfg = loadConfig();
    const year = new Date().getFullYear();

    let template = cfg.promptTemplate;

    // Replace variables (Standard)
    template = template.replaceAll('{{bank}}', card.bank || '')
        .replaceAll('{{name}}', card.name || '')
        .replaceAll('{{id}}', card.id || '')
        .replaceAll('{{positioning}}', card.positioning || '')
        .replaceAll('{{timePeriod}}', cfg.timePeriod || '')
        .replaceAll('{{year}}', year);

    // Replace variables (Chinese Bracket Alias - user friendly)
    template = template.replaceAll('【銀行名稱】', card.bank || '')
        .replaceAll('【卡片名稱】', card.name || '')
        .replaceAll('【卡片編號】', card.id || '')
        .replaceAll('【市場定位】', card.positioning || '')
        .replaceAll('【時間週期】', cfg.timePeriod || '')
        .replaceAll('【年份】', year);

    return template;
}

async function callPerplexity(card) {
    const cfg = loadConfig();
    const prompt = buildPrompt(card);

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${cfg.pplxKey} `,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: cfg.model,
            messages: [
                {
                    role: 'system',
                    content: '你是一位台灣信用卡權益分析專家。請以 Markdown 格式提供精確、結構化的信用卡權益分析。所有內容使用繁體中文。'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: 4000,
            temperature: 0.1,
            return_citations: true,
        }),
        signal: abortController?.signal,
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API ${response.status}: ${errText.substring(0, 200)} `);
    }

    const data = await response.json();
    let markdown = data.choices?.[0]?.message?.content || '';

    const header = `# ${card.bank} - ${card.name} \n\n > 🆔 編號：${card.id} \n > 🏷️ 核心定位：${card.positioning} \n > 📅 資料更新日期：${new Date().toISOString().split('T')[0]} \n\n`;

    if (!markdown.startsWith('# ')) {
        markdown = header + markdown;
    } else {
        if (!markdown.includes('編號')) {
            markdown = markdown.replace(/^# .+\n/, `$ &\n > 🆔 編號：${card.id} \n > 🏷️ 核心定位：${card.positioning} \n > 📅 資料更新日期：${new Date().toISOString().split('T')[0]} \n`);
        }
    }

    return markdown;
}

// --- 批次爬取邏輯 ---
async function startCrawl() {
    const selectedCards = getSelectedCards();
    if (selectedCards.length === 0) {
        alert('請至少選擇一張卡片！');
        return;
    }

    const cfg = loadConfig();
    if (!cfg.pplxKey) {
        alert('請先設定 Perplexity API Key！');
        return;
    }

    isRunning = true;
    isPaused = false;
    abortController = new AbortController();

    document.getElementById('btn-start').disabled = true;
    document.getElementById('btn-pause').disabled = false;
    document.getElementById('progress-wrapper').style.display = 'block';
    document.getElementById('btn-retry-failed').style.display = 'none';

    const total = selectedCards.length;
    let completed = 0;
    let successCount = 0;
    let failCount = 0;
    const startTime = Date.now();

    addLog(`🚀 開始爬取 ${total} 張卡片(模型: ${cfg.model})`, 'warning');

    for (let i = 0; i < selectedCards.length; i++) {
        while (isPaused) {
            await new Promise(r => setTimeout(r, 500));
        }

        if (!isRunning) {
            addLog('⏹️ 爬取已停止。', 'warning');
            break;
        }

        const card = selectedCards[i];

        if (results[card.id]?.status === 'success') {
            completed++;
            updateProgress(completed, total, successCount, failCount, startTime);
            continue;
        }

        results[card.id] = { status: 'running', selected: true };
        renderCardTable(document.getElementById('input-filter')?.value || '');

        addLog(`🔄[${completed + 1}/${total}]正在爬取: ${card.bank} ${card.name} `);

        try {
            const markdown = await callPerplexity(card);
            results[card.id] = { status: 'success', markdown, selected: true };
            successCount++;
            addLog(`✅[${completed + 1}/${total}] 完成: ${card.bank} ${card.name} `, 'success');
        } catch (err) {
            if (err.name === 'AbortError') {
                addLog('⏹️ 使用者中止爬取。', 'warning');
                results[card.id] = { status: undefined, selected: true };
                break;
            }

            results[card.id] = { status: 'error', error: err.message, selected: true };
            failCount++;
            addLog(`❌[${completed + 1}/${total}] 失敗: ${card.bank} ${card.name} — ${err.message} `, 'error');
        }

        completed++;
        updateProgress(completed, total, successCount, failCount, startTime);
        renderCardTable(document.getElementById('input-filter')?.value || '');

        if (i < selectedCards.length - 1 && isRunning) {
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    isRunning = false;
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-pause').disabled = true;

    if (failCount > 0) {
        document.getElementById('btn-retry-failed').style.display = 'inline-block';
    }

    if (successCount > 0) {
        showResultsSection(successCount, failCount);
        updateGuideStep(3);
    }

    addLog(`📊 爬取完成！成功 ${successCount} 張，失敗 ${failCount} 張。`, successCount > 0 ? 'success' : 'error');
}

function togglePause() {
    isPaused = !isPaused;
    const btn = document.getElementById('btn-pause');
    if (btn) {
        btn.textContent = isPaused ? '▶️ 繼續' : '⏸️ 暫停';
    }
    addLog(isPaused ? '⏸️ 已暫停，點擊「繼續」恢復。' : '▶️ 繼續爬取...', 'warning');
}

async function retryFailed() {
    const failedCards = cards.filter(c => results[c.id]?.status === 'error');
    if (failedCards.length === 0) {
        addLog('沒有失敗的卡片需要重試。');
        return;
    }

    failedCards.forEach(c => {
        results[c.id] = { status: undefined, selected: true };
    });

    renderCardTable();
    addLog(`🔄 準備重試 ${failedCards.length} 張失敗的卡片...`, 'warning');

    document.querySelectorAll('.card-check').forEach(cb => {
        const idx = parseInt(cb.dataset.idx);
        const card = cards[idx];
        cb.checked = failedCards.some(f => f.id === card?.id);
    });

    await startCrawl();
}

function updateProgress(completed, total, success, fail, startTime) {
    const percent = Math.round((completed / total) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const avgTime = elapsed / completed;
    const remaining = Math.round(avgTime * (total - completed));
    const etaMin = Math.floor(remaining / 60);
    const etaSec = remaining % 60;

    document.getElementById('progress-fill').style.width = `${percent}% `;
    document.getElementById('progress-text').textContent = `${completed} / ${total}`;
    document.getElementById('progress-percent').textContent = `${percent}%`;
    document.getElementById('progress-eta').textContent = completed < total
        ? `預估剩餘：${etaMin > 0 ? etaMin + '分' : ''}${etaSec}秒`
        : '✅ 已完成';
    document.getElementById('stat-success').textContent = `✅ ${success}`;
    document.getElementById('stat-fail').textContent = `❌ ${fail}`;
    document.getElementById('stat-skip').textContent = `⏭️ ${completed - success - fail}`;
}

function showResultsSection(success, fail) {
    const section = document.getElementById('section-results');
    if (section) section.style.display = 'block';

    document.getElementById('result-summary').textContent =
        `成功 ${success} 張 / 失敗 ${fail} 張`;

    const select = document.getElementById('select-preview');
    if (select) {
        select.innerHTML = '<option value="">-- 選擇卡片預覽 --</option>';
        cards.forEach(card => {
            if (results[card.id]?.status === 'success') {
                const opt = document.createElement('option');
                opt.value = card.id;
                opt.textContent = `${card.bank} ${card.name}`;
                select.appendChild(opt);
            }
        });
    }
}

function previewCard(cardId) {
    const previewEl = document.getElementById('preview-content');
    if (!previewEl) return;

    if (!cardId) {
        previewEl.textContent = '選擇一張卡片以預覽 Markdown 內容';
        return;
    }

    const r = results[cardId];
    if (r?.markdown) {
        previewEl.textContent = r.markdown;
    } else {
        previewEl.textContent = '此卡片尚無資料';
    }
}

window.previewById = (cardId) => {
    const select = document.getElementById('select-preview');
    if (select) select.value = cardId;
    previewCard(cardId);
    document.getElementById('section-results')?.scrollIntoView({ behavior: 'smooth' });
};

async function downloadZip(mode = 'all') {
    const zip = new JSZip();
    let count = 0;

    cards.forEach(card => {
        const r = results[card.id];
        if (!r?.markdown) return;
        if (mode === 'success' && r.status !== 'success') return;

        const cfg = loadConfig();
        const dates = cfg.timePeriod.match(/(\d{4})[\/-](\d{2})[\/-](\d{2})/g);
        let dateSuffix = '';
        if (dates && dates.length >= 2) {
            const start = dates[0].replace(/[\/-]/g, '');
            const end = dates[1].replace(/[\/-]/g, '');
            dateSuffix = `-${start}-${end}`;
        } else {
            const y = new Date().getFullYear();
            dateSuffix = `-${y}0101-${y}1231`;
        }

        const cleanId = card.id.replace(/[\/\\:*?"<>|]/g, '-');
        const safeName = `${cleanId}${dateSuffix}`;
        zip.file(`${safeName}.md`, r.markdown);
        count++;
    });

    if (count === 0) {
        alert('沒有可下載的資料！');
        return;
    }

    addLog(`📦 正在打包 ${count} 個檔案...`, 'warning');

    try {
        const blob = await zip.generateAsync({ type: 'blob' });
        const dateStr = new Date().toISOString().split('T')[0];
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `信用卡RAG_${dateStr}_${count}張.zip`;
        a.click();
        URL.revokeObjectURL(url);
        addLog(`✅ 已下載 ${count} 個 Markdown 檔案！`, 'success');
    } catch (err) {
        addLog(`❌ ZIP 打包失敗: ${err.message}`, 'error');
    }
}

async function uploadToDrive() {
    const successCards = cards.filter(c => results[c.id]?.status === 'success');
    if (successCards.length === 0) {
        alert('沒有成功的卡片資料可上傳！');
        return;
    }

    const gasUrl = document.getElementById('input-gas-url').value.trim();
    if (!gasUrl) { alert('請先設定 GAS WebApp URL！'); return; }

    if (!confirm(`確定要將 ${successCards.length} 份 Markdown 文件上傳到指定的 Google Drive 資料夾嗎？`)) return;

    addLog(`☁️ 準備上傳 ${successCards.length} 份文件到 Google Drive...`, 'warning');

    const btn = document.getElementById('btn-upload-drive');
    if (btn) btn.disabled = true;

    let uploadCount = 0;
    const cfg = loadConfig();

    for (let i = 0; i < successCards.length; i++) {
        const card = successCards[i];
        const r = results[card.id];

        const dates = cfg.timePeriod.match(/(\d{4})[\/-](\d{2})[\/-](\d{2})/g);
        let dateSuffix = '';
        if (dates && dates.length >= 2) {
            const start = dates[0].replace(/[\/-]/g, '');
            const end = dates[1].replace(/[\/-]/g, '');
            dateSuffix = `-${start}-${end}`;
        } else {
            const y = new Date().getFullYear();
            dateSuffix = `-${y}0101-${y}1231`;
        }
        const cleanId = card.id.replace(/[\/\\:*?"<>|]/g, '-');
        const fileName = `${cleanId}${dateSuffix}.md`;

        addLog(`⬆️ [${i + 1}/${successCards.length}] 上傳中: ${fileName}...`);

        try {
            const response = await fetch(gasUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({
                    action: 'saveToDrive',
                    fileName: fileName,
                    fileContent: r.markdown
                })
            });
            const data = await response.json();

            if (data.status === 'error') {
                addLog(`❌ 上傳失敗: ${data.message}`, 'error');
            } else {
                addLog(`✅ 上傳成功: ${fileName}`, 'success');
                uploadCount++;
            }
        } catch (err) {
            addLog(`❌ 網路連線錯誤: ${err.message}`, 'error');
        }

        await new Promise(r => setTimeout(r, 800));
    }

    addLog(`🎉 上傳作業結束！成功 ${uploadCount} / ${successCards.length} 份`, 'success');
    if (btn) btn.disabled = false;
}

init();

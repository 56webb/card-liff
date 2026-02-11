import './style.css'

// =============================================
// 信用卡爬蟲核心邏輯 (v2026.02.11 Fix 2)
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
};

function loadConfig() {
    return {
        pplxKey: localStorage.getItem(CONFIG_KEYS.PPLX_KEY) || '',
        gasUrl: localStorage.getItem(CONFIG_KEYS.GAS_URL) || '',
        model: localStorage.getItem(CONFIG_KEYS.MODEL) || 'sonar',
        timePeriod: localStorage.getItem(CONFIG_KEYS.TIME_PERIOD) || '2026 年上半年（2026/01/01 - 2026/06/30）',
    };
}

function saveConfig(cfg) {
    localStorage.setItem(CONFIG_KEYS.PPLX_KEY, cfg.pplxKey);
    localStorage.setItem(CONFIG_KEYS.GAS_URL, cfg.gasUrl);
    localStorage.setItem(CONFIG_KEYS.MODEL, cfg.model);
    localStorage.setItem(CONFIG_KEYS.TIME_PERIOD, cfg.timePeriod);
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

    if (inputPplxKey) inputPplxKey.value = cfg.pplxKey;
    if (inputGasUrl) inputGasUrl.value = cfg.gasUrl;
    if (selectModel) selectModel.value = cfg.model;
    if (inputTimePeriod) inputTimePeriod.value = cfg.timePeriod;

    // 如果已有設定，自動載入
    if (cfg.pplxKey && cfg.gasUrl) {
        addLog('✅ 偵測到已儲存的設定，API Key 與 GAS URL 已就緒。');
        updateGuideStep(2);
    }

    bindEvents();
}

// --- 事件綁定 ---
function bindEvents() {
    // 儲存設定
    document.getElementById('btn-save-config')?.addEventListener('click', () => {
        const cfg = {
            pplxKey: document.getElementById('input-pplx-key').value.trim(),
            gasUrl: document.getElementById('input-gas-url').value.trim(),
            model: document.getElementById('select-pplx-model').value,
            timePeriod: document.getElementById('input-time-period').value.trim(),
        };

        if (!cfg.pplxKey) { alert('請輸入 Perplexity API Key'); return; }
        if (!cfg.gasUrl) { alert('請輸入 GAS WebApp URL'); return; }

        saveConfig(cfg);
        addLog('💾 設定已儲存到瀏覽器。', 'success');
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
        // [Hybrid Fix] 同時將參數放在 URL 與 Body
        // URL 參數保證 e.parameter 能讀取到 (最穩)
        // Body 供後端 parse (備用)
        const separator = gasUrl.includes('?') ? '&' : '?';
        const targetUrl = `${gasUrl}${separator}action=getCardList&_t=${Date.now()}`;

        // addLog(`📡 連線中...`, 'info'); // Option: Log URL for debug

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                // 使用 text/plain 避免 OPTIONS Preflight
                'Content-Type': 'text/plain;charset=utf-8',
            },
            // 保留 Body 以備後端 POST 邏輯使用
            body: JSON.stringify({ action: 'getCardList' })
        });

        const data = await response.json();
        console.log('GAS Response:', data); // Debug Log

        if (data.status === 'ok' && data.cards) {
            cards = data.cards;
            results = {};
            renderCardTable();
            addLog(`✅ 成功載入 ${cards.length} 張卡片！`, 'success');
            updateGuideStep(2);
        } else {
            // 詳細顯示回傳內容以便除錯
            const debugMsg = JSON.stringify(data);
            addLog(`❌ 載入失敗: ${data.message || '未知錯誤'} (Response: ${debugMsg})`, 'error');
        }
    } catch (err) {
        // Failover to GET
        console.error(err);
        addLog(`⚠️ POST 失敗 (${err.message})，嘗試僅使用 GET...`, 'warning');
        try {
            // 純 GET 請求
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

    // 勾選事件
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

    return `請擔任專業的「金融產品條款分析師」，針對【${card.bank} ${card.name}】進行 ${cfg.timePeriod} 的最新權益深度搜索。

請忽略廣告行銷用語，直接查找官網公告、權益手冊或 T&C 條款。

🆔 卡片編號：${card.id}
🏷️ 市場定位：${card.positioning}

# 請以下列 Markdown 格式輸出完整分析報告：

## 基本資訊
| 項目 | 內容 |
|------|------|
| 發卡銀行 | （填入） |
| 卡片全名 | （填入） |
| 卡片等級 | 普卡/金卡/白金/御璽/鼎極/無限 |
| 卡組織 | Visa/MasterCard/JCB/AMEX |
| 年費 | 金額、首年是否免費 |
| 免年費條件 | 刷卡門檻/自動扣繳/數位帳戶等 |
| 官方連結 | URL |

## 回饋機制總覽
| 消費場景 | 回饋類型 | 回饋率 | 每月上限 | 換算可刷額度 | 需登錄 | 備註 |
|----------|----------|--------|----------|-------------|--------|------|
| 國內一般消費 | | | | | | |
| 海外一般消費 | | | | | | |
| 日本消費 | | | | | | |
| 韓國消費 | | | | | | |
| 網購 (momo/蝦皮/PChome) | | | | | | |
| 行動支付（請列出所有支援的：Apple Pay / Google Pay / LINE Pay / Samsung Pay / 街口 / 台灣 Pay / 悠遊付 / Pi 錢包等，每種分開列一行） | | | | | | |
| 加油 | | | | | | |
| 超市/量販 | | | | | | |
| 百貨公司 | | | | | | |
| 餐飲 | | | | | | |
| 交通 (台鐵/高鐵/捷運) | | | | | | |
| 電子票證自動加值 | | | | | | |
| 外送平台 | | | | | | |
| 串流訂閱 | | | | | | |
| 保費 | | | | | | |
| 繳稅 | | | | | | |
| 其他特殊回饋（若有上述未列出的獨特優惠，請補充在此） | | | | | | |

（僅填入該卡實際有優惠的場景，無優惠的場景請刪除該列）

## 指定通路加碼明細
（列出該卡特有的聯名/合作通路，例如：Costco、新光三越、momo、蝦皮等）
- 通路名稱：回饋 % / 上限 / 條件

## 回饋的魔鬼細節
- **回饋類型**：現金回饋 / 紅利點數 / 哩程（兌換比率）
- **回饋上限計算週期**：每月 / 每期帳單 / 每季 / 每年
- **排除項目**：（哪些消費不列入回饋？例如：繳費、代扣、保費、悠遊加值等）
- **需登錄活動**：是 / 否（登錄方式與截止日）
- **基本門檻**：是否需達單月最低消費才啟動回饋
- **新戶 vs 舊戶**：首刷禮差異、限定優惠

## 海外消費細節
- 海外交易手續費：（%）
- 是否有手續費補貼/減免
- DCC（動態貨幣轉換）注意事項

## 附加權益
- **保險**：旅平險 / 旅不便險 / 購物保障 / 不便險理賠額度
- **機場**：免費接送次數 / 貴賓室 / 機場停車
- **分期**：0 利率分期（期數/門檻/適用通路）
- **其他**：電影優惠 / 停車優惠 / 聯名特約

## 優缺點總結
### 👍 優點（3-5 點）
### 👎 缺點（2-3 點）

## 最適合的使用族群
（用 1-2 句話描述這張卡最適合什麼樣的人）

## 資料來源
（附上查詢到的官方連結）

---
⚠️ 注意事項：
1. 只提供確認過的資訊，無法確認的標記「⚠️ 待確認」
2. 回饋上限金額與換算可刷額度請用**粗體**
3. 若 ${year} 最新公告與舊資料衝突，以最新為準並註明
4. 不要編造不存在的優惠或條件`;
}

async function callPerplexity(card) {
    const cfg = loadConfig();
    const prompt = buildPrompt(card);

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${cfg.pplxKey}`,
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
            search_recency_filter: 'month',
        }),
        signal: abortController?.signal,
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    let markdown = data.choices?.[0]?.message?.content || '';

    // 加上標題與元資料
    const header = `# ${card.bank} - ${card.name}\n\n> 🆔 編號：${card.id}  \n> 🏷️ 核心定位：${card.positioning}  \n> 📅 資料更新日期：${new Date().toISOString().split('T')[0]}\n\n`;

    // 如果 AI 回覆已經包含標題，就不重複加
    if (!markdown.startsWith('# ')) {
        markdown = header + markdown;
    } else {
        // 確保元資料存在
        if (!markdown.includes('編號')) {
            markdown = markdown.replace(/^# .+\n/, `$&\n> 🆔 編號：${card.id}  \n> 🏷️ 核心定位：${card.positioning}  \n> 📅 資料更新日期：${new Date().toISOString().split('T')[0]}\n`);
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

    // UI 更新
    document.getElementById('btn-start').disabled = true;
    document.getElementById('btn-pause').disabled = false;
    document.getElementById('progress-wrapper').style.display = 'block';
    document.getElementById('btn-retry-failed').style.display = 'none';

    const total = selectedCards.length;
    let completed = 0;
    let successCount = 0;
    let failCount = 0;
    const startTime = Date.now();

    addLog(`🚀 開始爬取 ${total} 張卡片 (模型: ${cfg.model})`, 'warning');

    for (let i = 0; i < selectedCards.length; i++) {
        // 檢查暫停
        while (isPaused) {
            await new Promise(r => setTimeout(r, 500));
        }

        if (!isRunning) {
            addLog('⏹️ 爬取已停止。', 'warning');
            break;
        }

        const card = selectedCards[i];

        // 跳過已完成的
        if (results[card.id]?.status === 'success') {
            completed++;
            updateProgress(completed, total, successCount, failCount, startTime);
            continue;
        }

        // 標記為執行中
        results[card.id] = { status: 'running', selected: true };
        renderCardTable(document.getElementById('input-filter')?.value || '');

        addLog(`🔄 [${completed + 1}/${total}] 正在爬取: ${card.bank} ${card.name}`);

        try {
            const markdown = await callPerplexity(card);
            results[card.id] = { status: 'success', markdown, selected: true };
            successCount++;
            addLog(`✅ [${completed + 1}/${total}] 完成: ${card.bank} ${card.name}`, 'success');
        } catch (err) {
            if (err.name === 'AbortError') {
                addLog('⏹️ 使用者中止爬取。', 'warning');
                results[card.id] = { status: undefined, selected: true };
                break;
            }

            results[card.id] = { status: 'error', error: err.message, selected: true };
            failCount++;
            addLog(`❌ [${completed + 1}/${total}] 失敗: ${card.bank} ${card.name} — ${err.message}`, 'error');
        }

        completed++;
        updateProgress(completed, total, successCount, failCount, startTime);
        renderCardTable(document.getElementById('input-filter')?.value || '');

        // 延遲 1.5 秒避免 API 限速
        if (i < selectedCards.length - 1 && isRunning) {
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    // 完成
    isRunning = false;
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-pause').disabled = true;

    if (failCount > 0) {
        document.getElementById('btn-retry-failed').style.display = 'inline-block';
    }

    // 顯示結果區
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

    // 清除失敗狀態
    failedCards.forEach(c => {
        results[c.id] = { status: undefined, selected: true };
    });

    // 勾選失敗的卡片
    renderCardTable();

    addLog(`🔄 準備重試 ${failedCards.length} 張失敗的卡片...`, 'warning');

    // 手動標記為選中並啟動
    document.querySelectorAll('.card-check').forEach(cb => {
        const idx = parseInt(cb.dataset.idx);
        const card = cards[idx];
        cb.checked = failedCards.some(f => f.id === card?.id);
    });

    await startCrawl();
}

// --- 進度更新 ---
function updateProgress(completed, total, success, fail, startTime) {
    const percent = Math.round((completed / total) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const avgTime = elapsed / completed;
    const remaining = Math.round(avgTime * (total - completed));
    const etaMin = Math.floor(remaining / 60);
    const etaSec = remaining % 60;

    document.getElementById('progress-fill').style.width = `${percent}%`;
    document.getElementById('progress-text').textContent = `${completed} / ${total}`;
    document.getElementById('progress-percent').textContent = `${percent}%`;
    document.getElementById('progress-eta').textContent = completed < total
        ? `預估剩餘：${etaMin > 0 ? etaMin + '分' : ''}${etaSec}秒`
        : '✅ 已完成';
    document.getElementById('stat-success').textContent = `✅ ${success}`;
    document.getElementById('stat-fail').textContent = `❌ ${fail}`;
    document.getElementById('stat-skip').textContent = `⏭️ ${completed - success - fail}`;
}

// --- 結果區 ---
function showResultsSection(success, fail) {
    const section = document.getElementById('section-results');
    if (section) section.style.display = 'block';

    document.getElementById('result-summary').textContent =
        `成功 ${success} 張 / 失敗 ${fail} 張`;

    // 填充預覽下拉
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

// 給 HTML onclick 用
window.previewById = (cardId) => {
    const select = document.getElementById('select-preview');
    if (select) select.value = cardId;
    previewCard(cardId);

    // 捲動到預覽區
    document.getElementById('section-results')?.scrollIntoView({ behavior: 'smooth' });
};

// --- ZIP 下載 ---
async function downloadZip(mode = 'all') {
    const zip = new JSZip();
    let count = 0;

    cards.forEach(card => {
        const r = results[card.id];
        if (!r?.markdown) return;
        if (mode === 'success' && r.status !== 'success') return;

        // 檔名格式：整合編號_銀行_卡名.md
        const safeName = `${card.id}_${card.bank}_${card.name}`.replace(/[\/\\:*?"<>|]/g, '_');
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

// --- 啟動 ---
init();

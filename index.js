// DAFEIYU — DeepSeek 余额小鲸鱼 · 纯前端版（UI 扩展，弹窗粘贴仓库地址即可安装）
//
// 本文件职责：
//   1. fetch 拦截器：截获酒馆后端转发回来的 DeepSeek 响应（SSE 末块 / JSON），
//      捡回被酒馆丢弃的 usage（prompt/completion/缓存命中 token）——零配置、精确级。
//   2. 价格引擎：官方价格表（峰谷 × 缓存命中/未命中/输出分层），算出每轮真实花费。
//   3. 今日已用账本：按日累计，存 localStorage。
//   4. 余额（可选增强）：用户在扩展面板填自己的 DeepSeek Key（只存酒馆用户设置，
//      与正文模型连接相互独立），浏览器直连官方 user/balance（CORS 已验证）。
//   5. 官渠检测：正文源 = deepseek → 自动模式；否则挂件变暗、点击手动。
//   6. 挂件设置抽屉（Extensions 面板）。
//
// 原作：MeteorNOX/DeepSeek-Balance-Whale-Widget（DSH 插件）；
// 本移植基于其 SillyTavern 移植版 v0.2.10-st1 重构为纯前端架构。

(function () {
    'use strict';

    // 防重入：扩展重载/重复求值时不再二次包装 fetch、不再重复监听（widget.js 有同名守卫）
    if (window.__dafyIndex) return;
    window.__dafyIndex = true;

    // ==================== 安全基元（尽早捕获未污染引用） ====================
    // 恶意脚本可能在页面上替换 window.Worker/Blob/URL 等构造器；本扩展用 loading_order=10
    // 尽早加载，并在求值伊始抓下原始引用，后续全部走这些"干净"的引用。
    const _Worker = (typeof Worker !== 'undefined') ? Worker : null;
    const _Blob = (typeof Blob !== 'undefined') ? Blob : null;
    const _objURL = (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') ? URL.createObjectURL.bind(URL) : null;
    const _revokeURL = (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') ? URL.revokeObjectURL.bind(URL) : null;
    const _TextEncoder = (typeof TextEncoder !== 'undefined') ? TextEncoder : null;
    const _TextDecoder = (typeof TextDecoder !== 'undefined') ? TextDecoder : null;
    // Worker.prototype.postMessage 早绑定：晚加载脚本可 patch 原型方法截获进 Worker 的消息（含 Key）。
    // 实例上调用 w.postMessage(...) 是运行期原型查找，必须改走这份求值期抓下的引用。
    const _workerPostMessage = (_Worker && _Worker.prototype && typeof _Worker.prototype.postMessage === 'function')
        ? _Worker.prototype.postMessage : null;
    // 原始 fetch：余额回退通道用它发 Bearer，绕开本扩展自身与后装脚本包装的 window.fetch。
    // （比本扩展更早安装的包装器仍可能位于链条上游——纯前端无法防御，见 README 安全边界。）
    const _origFetch = (typeof window !== 'undefined' && typeof window.fetch === 'function')
        ? window.fetch.bind(window) : null;

    // ==================== 价格 / 峰谷（移植自原作服务端） ====================
    const PEAK_HOURS = [[9, 12], [14, 18]];
    const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] };
    const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] };
    const PRICING = {
        'deepseek-v4-flash-vision-exp': BASE_PRICE,
        'deepseek-v4-flash': BASE_PRICE,
        'deepseek-v4-pro': PRO_PRICE,
        'deepseek-chat': BASE_PRICE,
        'deepseek-reasoner': BASE_PRICE,
        _default: BASE_PRICE,
    };
    function priceFor(model) {
        const m = String(model || '').toLowerCase();
        for (const key of Object.keys(PRICING)) {
            if (key === '_default') continue;
            if (m.indexOf(key) !== -1) return PRICING[key];
        }
        return PRICING._default;
    }
    // DeepSeek 家族模型判定：模型名含 "deepseek"（大小写不敏感）。
    // 用于过滤后台请求：填表/记忆插件在 deepseek 源下把 model 指到别家（中转常见），
    // 其扣费不走 DeepSeek 账户，按 deepseek 价格表入账只会污染"今日已用"。
    function isDeepseekModel(m) {
        return /deepseek/i.test(String(m || ''));
    }
    // 2026-08-23（北京时间）起周末全天谷价
    const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000);
    function isPeakTime(timeSec) {
        if (!isFinite(Number(timeSec))) return false;
        const n = Number(timeSec);
        const bj = new Date(n * 1000 + 8 * 3600 * 1000);
        if (n >= WEEKEND_VALLEY_FROM_SEC) {
            const dow = bj.getUTCDay();
            if (dow === 0 || dow === 6) return false;
        }
        const hour = bj.getUTCHours();
        for (const [start, end] of PEAK_HOURS) if (hour >= start && hour < end) return true;
        return false;
    }
    function todayKey() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    // 真实 usage → 金额（与原作 computeTodayUsage 同一算法）
    function costFromUsage(usage, model, timeSec) {
        const u = usage || {};
        const hit = Math.max(0, Number(u.prompt_cache_hit_tokens ?? u.promptCacheHitTokens ?? 0) || 0);
        let miss = Math.max(0, Number(u.prompt_cache_miss_tokens ?? u.promptCacheMissTokens ?? 0) || 0);
        const out = Math.max(0, Number(u.completion_tokens ?? 0) || 0);
        const prompt = Math.max(0, Number(u.prompt_tokens ?? 0) || 0);
        if (hit + miss === 0 && prompt > 0) miss = prompt; // 兼容中转站剥掉缓存字段的情形
        const p = priceFor(model);
        const pi = isPeakTime(timeSec) ? 1 : 0;
        const amount = (hit / 1e6) * p.hit[pi] + (miss / 1e6) * p.miss[pi] + (out / 1e6) * p.out[pi];
        return { amount, tokens: { hit, miss, out } };
    }
    // 兜底估算（usage 被剥离时）：prompt 全按缓存未命中计价
    function estimateCost(model, promptTokens, outputTokens, timeSec) {
        const p = priceFor(model);
        const pi = isPeakTime(timeSec) ? 1 : 0;
        const inTok = Math.max(0, Number(promptTokens) || 0);
        const outTok = Math.max(0, Number(outputTokens) || 0);
        return {
            amount: (inTok / 1e6) * p.miss[pi] + (outTok / 1e6) * p.out[pi],
            tokens: { hit: 0, miss: inTok, out: outTok },
        };
    }

    // ==================== localStorage ====================
    function readLS(key, fallback) {
        try {
            const v = JSON.parse(localStorage.getItem(key));
            return v === null || v === undefined ? fallback : v;
        } catch (err) { return fallback; }
    }
    function writeLS(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* quota/full */ }
    }

    // —— 命名空间（dafy-*）：与 v0.2.10-st1 双件版（dshw-*/__dshWhaleWidget）互不冲突，两者可共存 ——
    const K_ENGINE = 'dafy-engine-ledger';
    const K_BALANCE = 'dafy-balance-ledger';
    const K_CONFIG = 'dafy-widget-config';
    const K_POS = 'dafy-pos';
    const VAULT_NAME = 'dafy-vault';
    const LEGACY_KEY_PAIRS = [
        ['dshw-engine-ledger', K_ENGINE],
        ['dshw-balance-ledger', K_BALANCE],
        ['dshw-widget-config', K_CONFIG],
        ['dshw-pos', K_POS],
        ['dshw-vault', VAULT_NAME],
    ];
    // 一次性迁移：把旧版（含双件版的位置键）拷入新键。不删旧键——旧键归双件版所有。
    function migrateNamespacedKeys() {
        try {
            if (localStorage.getItem('dafy-migrated') !== null) return;
            for (const [from, to] of LEGACY_KEY_PAIRS) {
                if (localStorage.getItem(to) === null) {
                    const v = localStorage.getItem(from);
                    if (v !== null) localStorage.setItem(to, v);
                }
            }
            localStorage.setItem('dafy-migrated', String(Date.now()));
        } catch (err) { /* noop */ }
    }

    // —— 引擎账本（usage/估算 累计）——
    function freshEngineLedger() {
        return { date: todayKey(), todayUsage: 0, todayTokens: 0, todayEstimated: 0, history: {} };
    }
    // 读路径：跨天返回新对象（显示归零是正确的）；归档在写路径 addEngineUsage 完成
    function getEngineLedger() {
        const led = readLS(K_ENGINE, null);
        if (led && typeof led === 'object' && led.date === todayKey()) return led;
        return freshEngineLedger();
    }
    function addEngineUsage(cost, estimated) {
        const t = todayKey();
        // 直接读原始存储（不经 getEngineLedger 的"跨天清零"视图），否则昨天的历史永远归不了档
        const raw = readLS(K_ENGINE, null);
        let led;
        if (raw && typeof raw === 'object' && typeof raw.date === 'string' && raw.date !== t) {
            // 跨天：把昨天的 todayUsage 归档进 history，再滚动新账本（对照 recordBalanceDelta 的写法）
            const hist = (raw.history && typeof raw.history === 'object') ? raw.history : {};
            if (typeof raw.todayUsage === 'number') hist[raw.date] = raw.todayUsage;
            led = { date: t, todayUsage: 0, todayTokens: 0, todayEstimated: 0, history: hist };
        } else if (raw && typeof raw === 'object' && raw.date === t) {
            led = raw;
        } else {
            led = freshEngineLedger();
        }
        led.history = led.history || {};
        led.todayUsage = Math.round(((led.todayUsage || 0) + cost.amount) * 1e6) / 1e6;
        led.todayTokens = (led.todayTokens || 0) + cost.tokens.hit + cost.tokens.miss + cost.tokens.out;
        if (estimated) led.todayEstimated = (led.todayEstimated || 0) + 1;
        led.history[t] = led.todayUsage;
        const keys = Object.keys(led.history).sort();
        while (keys.length > 30) delete led.history[keys.shift()];
        writeLS(K_ENGINE, led);
        return led;
    }
    // —— 余额差值账本（ledger 模式，算法移植自原作）——
    function getBalanceLedger() {
        const led = readLS(K_BALANCE, null);
        if (led && typeof led.date === 'string') return led;
        return { date: todayKey(), lastBalance: null, lastCurrency: '', todayUsage: 0, history: {} };
    }
    function recordBalanceDelta(balance, currency) {
        const t = todayKey();
        let led = getBalanceLedger();
        const cur = String(currency || '');
        const currencyChanged = typeof led.lastCurrency === 'string' && led.lastCurrency !== '' && cur !== '' && led.lastCurrency !== cur;
        if (led.date !== t) {
            if (led.date && typeof led.todayUsage === 'number') {
                led.history = led.history || {};
                led.history[led.date] = led.todayUsage;
            }
            led = { date: t, lastBalance: balance, lastCurrency: cur, todayUsage: 0, history: led.history || {} };
        } else if (currencyChanged) {
            led.lastBalance = balance;
            led.lastCurrency = cur;
        } else {
            const prev = typeof led.lastBalance === 'number' ? led.lastBalance : balance;
            if (typeof prev === 'number' && typeof balance === 'number' && balance < prev) {
                led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - balance);
            }
            led.lastBalance = balance;
            led.lastCurrency = cur;
        }
        const keys = Object.keys(led.history || {}).sort();
        while (keys.length > 30) delete led.history[keys.shift()];
        writeLS(K_BALANCE, led);
        return led;
    }

    // ==================== 运行时桥（index.js ↔ widget.js） ====================
    const listeners = { turn: [], state: [] };
    const runtime = window.__dafyRuntime = {
        version: '0.5.0',
        state: {
            keySource: 'none',   // 'tavern' | 'extension' | 'none'
            keyHint: '',         // 读不到密钥时的 actionable 提示
            autoMode: false,     // 官渠 deepseek → 自动
            lastTurn: null,
            captureCount: 0,     // 本页已捕获的轮次
        },
        onTurn(cb) { if (typeof cb === 'function') listeners.turn.push(cb); },
        onState(cb) { if (typeof cb === 'function') listeners.state.push(cb); },
        emitState() { listeners.state.forEach((f) => { try { f(runtime.state); } catch (err) { /* noop */ } }); },
        // 挂件配置持久化（localStorage）
        getConfig() { return readLS(K_CONFIG, null); },
        saveConfig(cfg) { writeLS(K_CONFIG, cfg); },
        getUsageMode() {
            const c = readLS(K_CONFIG, {}) || {};
            // 默认小鲸鱼记账（与原作一致；未填 Key 时快照层自动回落实时统计）。
            // 已显式保存过 engine 的用户保持不变。
            return c.usageMode === 'engine' ? 'engine' : 'ledger';
        },
        getLedgerSnapshot() {
            const eng = getEngineLedger();
            const bal = getBalanceLedger();
            const mode = runtime.getUsageMode();
            // 记账模式只有在真的追踪过余额（lastBalance 非空）时才有意义，否则回落引擎统计
            const ledgerValid = bal.date === todayKey() && bal.lastBalance !== null && bal.lastBalance !== undefined;
            return {
                usageMode: mode,
                todayUsage: mode === 'ledger' && ledgerValid ? bal.todayUsage : eng.todayUsage,
                todayTokens: eng.todayTokens || 0,
                todayEstimated: eng.todayEstimated || 0,
                isPeak: isPeakTime(Math.floor(Date.now() / 1000)),
            };
        },
        async getBalance(force) { return getBalance(force); },
        isPeakNow() { return isPeakTime(Math.floor(Date.now() / 1000)); },
    };
    function emitTurn(turn) {
        runtime.state.lastTurn = turn;
        runtime.state.captureCount++;
        listeners.turn.forEach((f) => { try { f(turn); } catch (err) { /* noop */ } });
        runtime.emitState();
    }

    // 跨标签页：其他标签页写入 dafy-* 键时广播状态，widget/面板据此刷新显示。
    // （账本写入本就是"每次写前重读"的同步 read-modify-write，跨页合计不会丢；这里只补显示同步。）
    window.addEventListener('storage', (e) => {
        try {
            if (e.key && e.key.indexOf('dafy-') === 0) runtime.emitState();
        } catch (err) { /* noop */ }
    });

    // ==================== 扩展设置（extensionSettings，仅用于旧版迁移） ====================
    let ctxRef = null;
    function getExtSettings() {
        try {
            // 注意：context.extensionSettings 是对象（不是函数）
            const s = ctxRef.extensionSettings;
            if (!s || typeof s !== 'object') return null;
            if (!s.dshWhale || typeof s.dshWhale !== 'object') s.dshWhale = {};
            return s.dshWhale;
        } catch (err) { return null; }
    }
    function saveExtSettings() {
        try { ctxRef.saveSettingsDebounced(); } catch (err) { /* noop */ }
    }

    // ==================== 密钥保险库（localStorage 混淆存储） ====================
    // 安全设计：
    //   1. Key 绝不放进 extensionSettings/context（那是一行代码就能读到的"公告栏"，
    //      还会随 settings.json 进入备份、导出与同步）
    //   2. localStorage 里以"位置相关异或 + base64"混淆存放，不标明用途，抬高随手窃取门槛
    //   3. 运行期 Key 只存在于闭包变量与 Worker 内部，不挂到任何 window 可达对象上
    // 诚实声明：同页面脚本的终极权限是读本页一切数据——混淆不是加密。真正"浏览器永不
    //   接触明文"的方案只有服务端伴身插件；本方案在纯前端约束下已把被动窃取面压到最小。
    // （VAULT_NAME 已随命名空间迁移到 dafy-vault，见上方常量定义）
    function b64e(bytes) {
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    }
    function b64d(str) {
        const s = atob(str);
        const arr = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
        return arr;
    }
    function xorMask(bytes) {
        for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i] ^ ((0xA5 ^ ((i * 31 + 7) & 0xFF)) & 0xFF);
        return bytes;
    }
    function vaultEncode(plain) {
        if (!_TextEncoder) return btoa(plain);
        return b64e(xorMask(new _TextEncoder().encode(plain)));
    }
    function vaultDecode(enc) {
        try {
            const bytes = b64d(enc);
            if (!_TextDecoder) return atob(enc);
            return new _TextDecoder().decode(xorMask(bytes));
        } catch (err) { return ''; }
    }
    function vaultRead() {
        const v = readLS(VAULT_NAME, null);
        if (!v || typeof v !== 'object') return { apiKey: '', apiBase: '' };
        return {
            apiKey: v.k ? vaultDecode(v.k) : '',
            apiBase: typeof v.b === 'string' ? v.b : '',
        };
    }
    // 传 undefined 表示"保持现值"；传空串表示清除该项
    function vaultWrite(apiKey, apiBase) {
        const cur = vaultRead();
        const obj = { v: 1 };
        const k = (apiKey === undefined) ? cur.apiKey : apiKey;
        obj.k = k ? vaultEncode(k) : '';
        const b = (apiBase === undefined) ? cur.apiBase : apiBase;
        obj.b = typeof b === 'string' ? b : '';
        writeLS(VAULT_NAME, obj);
    }
    function vaultClear() {
        try { localStorage.removeItem(VAULT_NAME); } catch (err) { /* noop */ }
    }
    function migrateLegacyKey() {
        // 旧版本曾把 Key 存在 extensionSettings.dshWhale（全局可读、随 settings.json 到处走）。
        // 升级时把旧值搬进保险库，并把旧字段从设置里抹掉。
        try {
            const s = getExtSettings();
            if (!s) return;
            let touched = false;
            if (typeof s.apiKey === 'string' && s.apiKey.trim()) {
                const cur = vaultRead();
                if (!cur.apiKey) vaultWrite(s.apiKey.trim(), undefined);
                delete s.apiKey;
                touched = true;
            }
            if (typeof s.apiBase === 'string' && s.apiBase) {
                const cur2 = vaultRead();
                if (!cur2.apiBase) vaultWrite(undefined, s.apiBase);
                delete s.apiBase;
                touched = true;
            }
            if (touched) saveExtSettings();
        } catch (err) { /* noop */ }
    }

    // ==================== 余额 Key 解析 ====================
    let dsKey = null;          // 仅存闭包内存，不挂任何全局对象
    let keySource = 'none';
    async function resolveKey() {
        if (dsKey) return dsKey;
        // 余额 Key 由用户在扩展面板自行配置（与酒馆正文模型的 Key 相互独立、互不影响）
        const v = vaultRead();
        if (v.apiKey) {
            dsKey = v.apiKey;
            keySource = 'extension';
            runtime.state.keySource = keySource;
            runtime.state.keyHint = '';
            runtime.emitState();
            return dsKey;
        }
        keySource = 'none';
        runtime.state.keySource = keySource;
        runtime.state.keyHint = '填入你自己的 DeepSeek API Key 即可显示余额与"今日记账"；不填则只统计消耗（不影响）';
        runtime.emitState();
        return null;
    }
    function invalidateKey() {
        dsKey = null;
        keySource = 'none';
        runtime.state.keySource = keySource;
        runtime.emitState();
    }

    function pickBalanceInfo(infos) {
        if (!Array.isArray(infos) || infos.length === 0) return null;
        const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN);
        return (
            infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
            infos.find((x) => num(x) > 0) ||
            infos.find((x) => x && x.currency === 'CNY') ||
            infos[0]
        );
    }
    const BALANCE_TTL_MS = 25000;
    let balanceCache = null;
    let balanceInFlight = null;
    // 记账模式的今日已用：只有真的追踪过余额（lastBalance 非空）才用差值账本，
    // 否则回落引擎统计——避免"记账模式 + 余额滞后"把显示钉死在 ¥0.00
    function ledgerTodayOrEngine(mode) {
        if (mode !== 'ledger') return getEngineLedger().todayUsage;
        const bal = getBalanceLedger();
        const tracked = bal.date === todayKey() && bal.lastBalance !== null && bal.lastBalance !== undefined;
        return tracked ? bal.todayUsage : getEngineLedger().todayUsage;
    }
    // —— Worker 隔离通道：带 Authorization 头的请求在独立线程里发出 ——
    // 页面级的 fetch/XHR 包装器（恶意扩展收割密钥头的惯用手法）既观察不到、也包裹不到
    // Worker 内部的网络调用；Key 通过 postMessage 进 Worker 后只存在于其独立作用域。
    let balanceWorker = null;   // null=尚未创建, false=不可用
    let balanceReqId = 0;
    const balanceWaiters = new Map();
    function ensureBalanceWorker() {
        if (balanceWorker !== null) return balanceWorker;
        if (!_Worker || !_Blob || !_objURL) { balanceWorker = false; return balanceWorker; }
        try {
            const src = [
                'self.onmessage = function (e) {',
                '  var d = e.data || {};',
                '  fetch(d.url, { headers: { "Authorization": "Bearer " + d.key } })',
                '    .then(function (r) {',
                '      if (!r.ok) return { __dafyStatus: r.status };',
                '      return r.json();',
                '    })',
                '    .then(function (data) { self.postMessage({ id: d.requestId, payload: data }); })',
                '    .catch(function (err) { self.postMessage({ id: d.requestId, err: String(err && err.message || err) }); });',
                '};',
            ].join('\n');
            const url = _objURL(new _Blob([src], { type: 'text/javascript' }));
            balanceWorker = new _Worker(url);
            _revokeURL(url);
            balanceWorker.onmessage = function (e) {
                const d = e.data || {};
                const w = balanceWaiters.get(d.id);
                if (w) { balanceWaiters.delete(d.id); w(d); }
            };
            balanceWorker.onerror = function () { /* 静默：请求侧有超时兜底 */ };
        } catch (err) {
            balanceWorker = false;
        }
        return balanceWorker;
    }
    function workerFetchBalance(key, base) {
        return new Promise((resolve) => {
            const w = ensureBalanceWorker();
            if (!w) { resolve(null); return; }
            const id = ++balanceReqId;
            const timer = setTimeout(() => {
                balanceWaiters.delete(id);
                resolve(null); // Worker 无响应 → 回落页面通道
            }, 22000);
            balanceWaiters.set(id, (d) => {
                clearTimeout(timer);
                resolve(d);
            });
            try {
                const msg = { url: base + '/user/balance', key: key, requestId: id };
                // 走求值期捕获的原型方法：晚加载脚本 patch Worker.prototype.postMessage 也截不到 Key
                if (_workerPostMessage) _workerPostMessage.call(w, msg);
                else w.postMessage(msg);
            } catch (err) {
                clearTimeout(timer);
                balanceWaiters.delete(id);
                resolve(null);
            }
        });
    }
    // apiBase 规范化：强制 https（Key 绝不明文走网络），去尾斜杠，保留路径前缀（中转场景）
    function normalizeBase(apiBase) {
        const raw = String(apiBase && apiBase.trim() ? apiBase.trim() : 'https://api.deepseek.com');
        let u;
        try { u = new URL(raw); } catch (err) { return null; }
        if (u.protocol !== 'https:') return null;
        return (u.origin + u.pathname).replace(/\/+$/, '');
    }
    const OFFICIAL_BASE = 'https://api.deepseek.com';
    async function fetchBalanceDirect(key, apiBase) {
        const base = normalizeBase(apiBase);
        if (!base) return { ok: false, code: 'BASE', error: 'API 地址无效：必须是以 https:// 开头的合法地址' };
        // 优先走 Worker 隔离通道
        const viaWorker = await workerFetchBalance(key, base);
        if (viaWorker) {
            if (viaWorker.err) return { ok: false, code: 'ERROR', error: '余额查询失败: ' + String(viaWorker.err).slice(0, 120) };
            const data = viaWorker.payload;
            if (data && data.__dafyStatus) return { ok: false, code: 'HTTP' + data.__dafyStatus, error: '余额接口 HTTP ' + data.__dafyStatus };
            const info = pickBalanceInfo(data && data.balance_infos);
            if (!info || info.total_balance === undefined) return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' };
            return {
                ok: true,
                totalBalance: Number(info.total_balance),
                currency: String(info.currency || 'CNY'),
                updatedAt: new Date().toISOString(),
            };
        }
        // Worker 不可用才回落页面通道（隐蔽性换功能）。
        // 用求值期捕获的原始 fetch 发 Bearer：后装脚本的 window.fetch 包装器看不到这行请求。
        if (!_origFetch) return { ok: false, code: 'NOFETCH', error: '余额查询失败: 浏览器 fetch 不可用' };
        try {
            const res = await _origFetch(base + '/user/balance', {
                headers: { Authorization: 'Bearer ' + key },
                signal: AbortSignal.timeout(20000),
            });
            if (!res.ok) return { ok: false, code: 'HTTP' + res.status, error: '余额接口 HTTP ' + res.status };
            const data = await res.json();
            const info = pickBalanceInfo(data && data.balance_infos);
            if (!info || info.total_balance === undefined) return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' };
            return {
                ok: true,
                totalBalance: Number(info.total_balance),
                currency: String(info.currency || 'CNY'),
                updatedAt: new Date().toISOString(),
            };
        } catch (err) {
            return { ok: false, code: 'ERROR', error: '余额查询失败: ' + String((err && err.message) || err).slice(0, 120) };
        }
    }
    async function getBalance(force) {
        const now = Date.now();
        const mode = runtime.getUsageMode();
        const base = { isPeak: isPeakTime(Math.floor(now / 1000)), usageMode: mode };
        const key = await resolveKey();
        if (!key) {
            const eng = getEngineLedger();
            return { ...base, ok: true, noKey: true, balance: null, currency: 'CNY', todayUsage: eng.todayUsage };
        }
        if (!force && balanceCache && now - balanceCache.at < BALANCE_TTL_MS) {
            const c = balanceCache.payload;
            const todayUsage = ledgerTodayOrEngine(mode);
            return { ...base, ...c, todayUsage };
        }
        if (!force && balanceInFlight) return balanceInFlight;
        balanceInFlight = (async () => {
            const v = vaultRead();
            const payload = await fetchBalanceDirect(key, v.apiBase);
            if (!payload.ok) {
                console.warn('[DAFEIYU]', payload.code, payload.error);
                return { ...base, ...payload, todayUsage: getEngineLedger().todayUsage };
            }
            balanceCache = { at: Date.now(), payload };
            if (mode === 'ledger') {
                const led = recordBalanceDelta(payload.totalBalance, payload.currency);
                return { ...base, ...payload, todayUsage: ledgerTodayOrEngine(mode) };
            }
            return { ...base, ...payload, todayUsage: getEngineLedger().todayUsage };
        })().finally(() => { balanceInFlight = null; });
        return balanceInFlight;
    }

    // ==================== fetch 拦截器：截获真实 usage ====================
    // 酒馆后端把 DeepSeek 的响应原样转发给浏览器（forwardFetchResponse = 逐字节 pipe），
    // 但酒馆自己的解析器只取正文，把 usage 丢了。这里给 fetch 披一层外衣，
    // clone 一份响应自己读——流式读 SSE 末块的 usage，非流式读 JSON 的 usage。
    //
    // 回合状态按 Response 对象关联（Map）：每条被拦截的 deepseek 响应对应一个 turn，
    // usage 从哪个 clone 读来就结算哪个 turn；已结算/已丢弃的响应再收到 usage 一律忽略——
    // 从根上消灭"全局单槽 pendingTurn"时代的迟到 usage 幽灵补计与估算覆盖问题。
    const activeTurns = new Map();   // Response -> { model, quiet, promptTokens, promptCountPromise, outText, reading, t0 }
    // 生成会话门控：GENERATION_STARTED（载荷含 quiet_prompt）→ ENDED/STOPPED 之间才算"主对话"。
    // 标题生成/填表记忆插件等后台请求（quiet prompt 或插件自发 fetch）标记为 quiet turn：
    // 有真实 usage 就静默入账（不弹泡不占"已截获"计数），等不到 usage 就静默丢弃——绝不走估算兜底，
    // 否则每轮对话后会弹出第二个"≈¥0.00"估算泡泡（prompt 恒 0 + 无流事件文本）。
    let generationActive = false;
    let lastGenerationQuiet = false;

    async function resolveTokenCount(text) {
        if (!text) return 0;
        try {
            if (ctxRef && typeof ctxRef.getTokenCountAsync === 'function') {
                const n = await ctxRef.getTokenCountAsync(text);
                if (typeof n === 'number' && isFinite(n) && n > 0) return Math.round(n);
            }
        } catch (err) { /* 走启发式 */ }
        // 启发式：DeepSeek 分词下 CJK ≈0.6 token/字，其余 ≈4 字符/token
        let cjk = 0, other = 0;
        const s = String(text);
        for (let i = 0; i < s.length; i++) {
            const code = s.charCodeAt(i);
            if (code >= 0x2E80 && code <= 0xFFEF) cjk++;
            else other++;
        }
        return Math.ceil(cjk * 0.6 + other / 4);
    }

    // 从被拦截的请求体提取 prompt 全文（messages 数组，含 system/世界书——比坏掉的
    // ctx.getTokenCount()（无参调用恒返回 0）准确得多，且修掉"估算 prompt 恒 0"的问题）
    function extractPromptText(messages) {
        if (!Array.isArray(messages)) return '';
        let out = '';
        for (const m of messages) {
            if (!m) continue;
            const c = m.content;
            if (typeof c === 'string') out += c + '\n';
            else if (Array.isArray(c)) {
                for (const part of c) {
                    if (part && typeof part.text === 'string') out += part.text + '\n';
                }
            }
        }
        return out;
    }

    function beginTurn(response, model, promptText) {
        // 悬挂清理：异常流（没等到 usage 也没等到生成结束事件）超过 10 分钟直接丢弃
        const cutoff = Date.now() - 10 * 60 * 1000;
        for (const [resp, tn] of activeTurns) {
            if (tn.t0 < cutoff) activeTurns.delete(resp);
        }
        const turn = {
            model: model || '',
            quiet: !generationActive || lastGenerationQuiet, // 主对话窗口之外 / quiet prompt → 后台请求
            promptTokens: 0,
            promptCountPromise: null,
            outText: '',
            reading: false,
            t0: Date.now(),
        };
        // prompt token 异步计数：tokenizer 优先，启发式兜底；回填时 turn 可能已结算，结果自然作废
        turn.promptCountPromise = resolveTokenCount(promptText).then((n) => {
            if (activeTurns.has(response)) activeTurns.get(response).promptTokens = n;
            return n;
        }).catch(() => 0);
        activeTurns.set(response, turn);
        return turn;
    }
    function latestActiveEntry() {
        let last = null;
        for (const entry of activeTurns) last = entry; // Map 按插入序迭代，取最新
        return last; // [response, turn] 或 null
    }
    function settleTurn(response, turnResult, silent) {
        activeTurns.delete(response);
        const led = addEngineUsage(turnResult, !!turnResult.estimated);
        if (silent) {
            // 后台请求（标题生成/填表记忆插件等）真实消耗：静默入账，不弹泡、不占"已截获"计数
            runtime.emitState();
            return;
        }
        emitTurn({ ...turnResult, todayUsage: led.todayUsage });
    }
    function handleUsage(response, usage, model) {
        const turn = activeTurns.get(response);
        if (!turn) return; // 已结算（真实或估算）或已丢弃：迟到 usage 不再入账
        // 后台请求若实际服务的不是 DeepSeek 家族模型（响应 model 优先于请求 model），
        // 其扣费不走 DeepSeek 账户——不入账直接丢弃。
        // 主对话不按名字排除：deepseek 源 + 中转自定义模型名是真 deepseek 流量的常态。
        if (turn.quiet && !isDeepseekModel(model)) {
            activeTurns.delete(response);
            return;
        }
        const t = Math.floor(Date.now() / 1000);
        const cost = costFromUsage(usage, model, t);
        settleTurn(response, { ...cost, usage, model: model || '', estimated: false }, turn.quiet);
    }
    // 估算兜底：usage 被中转剥掉时，用请求体 prompt / 流式输出文本估算并真实入账。
    // 只结算"主对话" turn：quiet turn 直接静默丢弃；clone 仍在读取的先跳过（usage 可能马上到），
    // 留一次延迟二次扫描。
    async function finalizeEstimates(depth) {
        depth = depth || 0;
        const entries = [...activeTurns];
        for (const [response, turn] of entries) {
            if (turn.quiet) {
                activeTurns.delete(response); // 后台请求等不到 usage：静默丢弃，不估算不弹泡
                continue;
            }
        }
        const pendingReads = entries.some(([resp, turn]) => !turn.quiet && turn.reading && activeTurns.has(resp));
        if (pendingReads && depth < 1) {
            setTimeout(() => { finalizeEstimates(depth + 1); }, 1500);
            return;
        }
        for (const [response, turn] of entries) {
            if (!activeTurns.has(response) || turn.quiet || turn.reading) continue;
            const promptTokens = await turn.promptCountPromise;
            const outTokens = await resolveTokenCount(turn.outText);
            if (!activeTurns.has(response)) continue; // 计数期间已被真实 usage 结算
            const cost = estimateCost(turn.model, promptTokens, outTokens, Math.floor(Date.now() / 1000));
            settleTurn(response, { ...cost, usage: null, model: turn.model, estimated: true });
        }
    }

    // 统一文本捕获：把 clone 的响应读成全文，再自动识别 JSON（非流式）或 SSE（流式）。
    // 注意：酒馆后端 forwardFetchResponse 只 pipe 字节流、不设置 Content-Type（util.js:709），
    // 所以绝不能用响应头判断形态——必须看内容本体。
    async function readBodyClone(clone, onUsage) {
        try {
            const reader = clone.body.getReader();
            const dec = _TextDecoder ? new _TextDecoder() : new TextDecoder();
            let text = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                text += dec.decode(value, { stream: true });
            }
            const t = text.trim();
            if (!t) return;
            // ① 非流式：整体是一个 JSON 对象
            if (t.startsWith('{') || t.startsWith('[')) {
                try {
                    const obj = JSON.parse(t);
                    if (obj && obj.usage && typeof obj.usage === 'object') onUsage(obj.usage, obj.model || '');
                } catch (err) { /* 坏 JSON，忽略 */ }
                return;
            }
            // ② 流式：逐行扫 data: 载荷，取最后一个带 usage 的块（DeepSeek 在末块携带）
            let lastUsage = null;
            let lastModel = '';
            const lines = t.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i].trim();
                if (!l.startsWith('data:')) continue;
                const ds = l.slice(5).trim();
                if (!ds || ds === '[DONE]') continue;
                try {
                    const o = JSON.parse(ds);
                    if (o && o.usage && typeof o.usage === 'object') {
                        lastUsage = o.usage;
                        lastModel = o.model || lastModel;
                    }
                } catch (err) { /* 跳过坏行 */ }
            }
            if (lastUsage) onUsage(lastUsage, lastModel);
        } catch (err) { /* 流被提前销毁等，忽略 */ }
    }

    // ① 先解析请求体：识别 deepseek 源，并注入 stream_options.include_usage——
    //    DeepSeek 流式响应默认不带 usage，必须显式要求；不注入则捕获成败全看酒馆自身配置
    if (_origFetch) window.fetch = async function dafieyuFetch(input, init) {
        let url = '';
        try {
            if (typeof input === 'string') url = input;
            else if (input && typeof input.url === 'string') url = input.url;
        } catch (err) { /* noop */ }

        let bodyObj = null;
        let isDeepSeek = false;
        let model = '';
        let bodyTouched = false;
        if (url && url.indexOf('/api/backends/chat-completions') !== -1) {
            let reqBodyStr = null;
            try {
                if (init && typeof init.body === 'string') reqBodyStr = init.body;
                else if (typeof Request !== 'undefined' && input instanceof Request) reqBodyStr = await input.clone().text();
            } catch (err) { reqBodyStr = null; }
            if (reqBodyStr) {
                try { bodyObj = JSON.parse(reqBodyStr); } catch (err) { bodyObj = null; }
                if (bodyObj && bodyObj.chat_completion_source === 'deepseek') {
                    isDeepSeek = true;
                    model = String(bodyObj.model || '');
                    if (bodyObj.stream === true) {
                        const so = (bodyObj.stream_options && typeof bodyObj.stream_options === 'object' && !Array.isArray(bodyObj.stream_options))
                            ? bodyObj.stream_options : {};
                        if (!so.include_usage) {
                            so.include_usage = true;
                            bodyObj.stream_options = so;
                            bodyTouched = true;
                        }
                    }
                }
            }
        }

        // ② 注入了 include_usage 则替换请求体后再发出（拦截层绝不破坏其余参数）
        let fetchInput = input;
        let fetchInit = init;
        if (bodyTouched) {
            const newBody = JSON.stringify(bodyObj);
            try {
                if (init && typeof init.body === 'string') {
                    fetchInit = Object.assign({}, init, { body: newBody });
                } else if (typeof Request !== 'undefined' && input instanceof Request) {
                    fetchInput = new Request(input, { body: newBody }); // 继承 url/method/headers，仅覆盖 body
                }
            } catch (err) { fetchInput = input; fetchInit = init; } // 重建失败：按原样发出（只是不注入）
        }

        const fetchPromise = _origFetch(fetchInput, fetchInit);

        try {
            const response = await fetchPromise;
            if (isDeepSeek && response && response.ok && response.body) {
                const turn = beginTurn(response, model, extractPromptText(bodyObj && bodyObj.messages));
                turn.reading = true;
                // 不看 Content-Type（酒馆不转发该头），统一按内容本体解析。
                // 读完后复位 reading——估算兜底只碰"读完了仍没 usage"的 turn
                readBodyClone(response.clone(), (usage, m) => handleUsage(response, usage, m || model))
                    .then(() => {
                        const tn = activeTurns.get(response);
                        if (tn) tn.reading = false;
                    });
            }
            return response;
        } catch (err) {
            return fetchPromise; // 拦截层绝不破坏原始 fetch
        }
    };

    // ==================== 事件桥（兜底估算 + 官渠检测 + quiet 门控） ====================
    let fallbackTimer = null;
    function scheduleFallbackFinalize() {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        // SSE 末块 usage 通常先于 GENERATION_ENDED 到达；留 1.5s 等待，等不到就估算兜底
        fallbackTimer = setTimeout(() => {
            fallbackTimer = null;
            finalizeEstimates();
        }, 1500);
    }
    function computeAutoMode(c) {
        try {
            if (c.mainApi !== 'openai') return false;
            const cs = c.chatCompletionSettings || {};
            return cs.chat_completion_source === 'deepseek';
        } catch (err) { return false; }
    }
    function updateAutoMode(c) {
        const auto = computeAutoMode(c);
        if (runtime.state.autoMode !== auto) {
            runtime.state.autoMode = auto;
            runtime.emitState();
        }
    }

    function bridgeEvents(c) {
        try {
            const { eventSource, event_types: t } = c;
            // GENERATION_STARTED 每次生成都触发（含 quiet prompt，ST script.js:4240），
            // 载荷 (type, options, dryRun)，options.quiet_prompt 标记标题生成等后台请求
            if (t.GENERATION_STARTED) eventSource.on(t.GENERATION_STARTED, (type, options) => {
                generationActive = true;
                lastGenerationQuiet = !!(options && options.quiet_prompt);
            });
            if (t.STREAM_TOKEN_RECEIVED) eventSource.on(t.STREAM_TOKEN_RECEIVED, (text) => {
                // 载荷是本次增量文本（ST script.js: emit(event_types.STREAM_TOKEN_RECEIVED, text)），
                // 按"事件次数"计数会系统性低估 out token，必须累积文本再计数
                const entry = latestActiveEntry();
                if (entry && typeof text === 'string' && !entry[1].quiet) entry[1].outText += text;
            });
            if (t.GENERATION_ENDED) eventSource.on(t.GENERATION_ENDED, () => {
                generationActive = false;
                scheduleFallbackFinalize();
            });
            if (t.GENERATION_STOPPED) eventSource.on(t.GENERATION_STOPPED, () => {
                generationActive = false;
                if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
                // 主动中止：丢弃最新的"主对话" turn（后台请求的悬挂 turn 不受影响，等自己的兜底处理）
                for (const entry of [...activeTurns].reverse()) {
                    if (!entry[1].quiet) { activeTurns.delete(entry[0]); break; }
                }
            });
            const refreshAuto = () => updateAutoMode(c);
            if (t.SETTINGS_UPDATED) eventSource.on(t.SETTINGS_UPDATED, refreshAuto);
            if (t.CHAT_COMPLETION_SETTINGS_READY) eventSource.on(t.CHAT_COMPLETION_SETTINGS_READY, refreshAuto);
            if (t.CONNECTION_PROFILE_LOADED) eventSource.on(t.CONNECTION_PROFILE_LOADED, refreshAuto);
        } catch (err) {
            console.warn('[DAFEIYU] event bridge unavailable', err);
        }
    }

    // ==================== 设置抽屉（Extensions 面板） ====================
    function fmtMoney(n) {
        const v = Number(n);
        if (!isFinite(v)) return '--';
        // 单轮花费常低于一分钱，两位小数会显示 ¥0.00——小额用 4 位
        return '¥ ' + (v >= 0.01 || v === 0 ? v.toFixed(2) : v.toFixed(4));
    }
    function buildSettings(c) {
        const host = document.getElementById('extensions_settings2');
        if (!host || host.querySelector('#dafy-settings')) return false;
        const drawer = document.createElement('div');
        drawer.className = 'inline-drawer';
        drawer.id = 'dafy-settings';
        drawer.innerHTML =
            '<div class="inline-drawer-toggle inline-drawer-header">' +
            '<b>DeepSeek 余额小鲸鱼 (DAFEIYU)</b>' +
            '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>' +
            '</div>' +
            '<div class="inline-drawer-content">' +
            '<small style="opacity:.75;display:block;margin-bottom:6px">实时 token 消耗与花费由 fetch 拦截自动统计，无需任何配置。余额显示为可选增强：不填 Key 时小鲸鱼照常统计消耗。</small>' +
            '<div id="dafy-summary" style="font-size:12px;opacity:.85;margin-bottom:6px"></div>' +
            '<div id="dafy-keyhint" style="font-size:12px;color:#c0392b;margin-bottom:6px"></div>' +
            '<div class="flex-container flexFlowColumn" style="gap:6px">' +
            '<label for="dafy-apikey">DeepSeek API Key <small>(可选，用于显示余额；留空表示不修改)</small></label>' +
            '<input id="dafy-apikey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-...（不填则只统计消耗）">' +
            '<label for="dafy-apibase">API 地址 <small>(可选，默认官方 api.deepseek.com，必须 https)</small></label>' +
            '<input id="dafy-apibase" type="text" autocomplete="off" spellcheck="false" placeholder="https://api.deepseek.com">' +
            '<div class="flex-container flexFlowRow" style="gap:8px">' +
            '<button id="dafy-save" class="menu_button" style="flex:0">保存</button>' +
            '<button id="dafy-clear" class="menu_button" style="flex:0">清除 Key</button>' +
            '<span id="dafy-status" style="align-self:center;font-size:12px;opacity:.8"></span>' +
            '</div></div>' +
            '<small style="opacity:.6;display:block;margin-top:6px">这里的 Key 是你自己的 DeepSeek Key（与酒馆正文模型连接相互独立），以混淆形式只存在本机浏览器里，不进酒馆设置文件、不随备份/导出走；余额请求经独立线程发出，页面上的其他脚本无法截获。allowKeysExposure 无需开启。消耗统计完全不需要 Key。</small>' +
            '</div>';
        host.appendChild(drawer);

        const status = drawer.querySelector('#dafy-status');
        const summary = drawer.querySelector('#dafy-summary');
        const keyHintEl = drawer.querySelector('#dafy-keyhint');
        const setStatus = (text) => { status.textContent = text; setTimeout(() => { status.textContent = ''; }, 5000); };
        const keySourceText = () => ({
            extension: '已配置',
            none: '未填（仅消耗统计）',
        }[runtime.state.keySource] || '未填（仅消耗统计）');

        const refreshSummary = () => {
            const snap = runtime.getLedgerSnapshot();
            const src = keySourceText();
            const modeText = snap.usageMode === 'ledger' ? '小鲸鱼记账（余额差值）' : '实时·精确（usage 截获）';
            summary.textContent = `今日已用 ${fmtMoney(snap.todayUsage)} · 今日 token ${snap.todayTokens} · 已截获 ${runtime.state.captureCount} 轮（今日估算 ${snap.todayEstimated}） · 用量模式 ${modeText} · 密钥 ${src}`;
            keyHintEl.textContent = runtime.state.keyHint || '';
            keyHintEl.style.display = runtime.state.keyHint ? '' : 'none';
        };
        refreshSummary();
        runtime.onState(refreshSummary);
        setInterval(refreshSummary, 30000);

        const v0 = vaultRead();
        if (v0.apiBase) drawer.querySelector('#dafy-apibase').value = v0.apiBase;

        drawer.querySelector('#dafy-save').addEventListener('click', () => {
            const apiKey = drawer.querySelector('#dafy-apikey').value.trim();
            const apiBase = drawer.querySelector('#dafy-apibase').value.trim();
            // apiBase 安全校验：必须是合法 https 地址；非官方域保存前弹确认，展示 Key 将发往的完整 URL
            if (apiBase) {
                const nb = normalizeBase(apiBase);
                if (!nb) { setStatus('API 地址无效：必须是以 https:// 开头的合法地址'); return; }
                if (nb !== OFFICIAL_BASE && nb !== String(v0.apiBase || '')) {
                    const okGo = window.confirm(
                        '余额查询将携带你的 API Key 请求：\n\n' + nb + '/user/balance\n\n' +
                        '该地址不是 DeepSeek 官方域名。请确认你信任它——Key 只应发给官方或你信任的中转。'
                    );
                    if (!okGo) { setStatus('已取消保存'); return; }
                }
            }
            // Key 走混淆保险库（undefined=保持现值），绝不写入 extensionSettings
            vaultWrite(apiKey || undefined, apiBase);
            invalidateKey();
            balanceCache = null;
            setStatus('已保存');
            drawer.querySelector('#dafy-apikey').value = ''; // 立即清空输入框
            refreshSummary();
        });
        drawer.querySelector('#dafy-clear').addEventListener('click', () => {
            vaultClear();
            // 兼容：把旧版本遗留在扩展设置里的 Key 也抹掉
            try {
                const st = getExtSettings();
                if (st && (st.apiKey !== undefined || st.apiBase !== undefined)) {
                    delete st.apiKey;
                    delete st.apiBase;
                    saveExtSettings();
                }
            } catch (err) { /* noop */ }
            invalidateKey();
            balanceCache = null;
            setStatus('已清除');
            refreshSummary();
        });
        return true;
    }

    // ==================== 启动 ====================
    function boot() {
        const c = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : null;
        const ready = c && typeof c.eventSource !== 'undefined';
        const bodyReady = document.body != null;
        if (!ready || !bodyReady) {
            setTimeout(boot, 500);
            return;
        }
        ctxRef = c;
        migrateNamespacedKeys(); // 一次性：dshw-*（旧版本/双件版）拷入 dafy-*，此后两者互不干扰
        migrateLegacyKey(); // 旧版遗留的 Key：搬进保险库 + 从设置里抹掉
        bridgeEvents(c);
        updateAutoMode(c);
        resolveKey().then(() => {
            runtime.emitState();
        });
        const trySettings = () => {
            if (buildSettings(c)) return;
            setTimeout(trySettings, 1000);
        };
        setTimeout(trySettings, 1500);
        // 注入挂件本体（widget.js 与本文件同目录，模块相对导入）
        try {
            import(/* webpackIgnore: true */ './widget.js')
                .catch((e) => console.warn('[DAFEIYU] widget import failed', e));
        } catch (e) {
            console.warn('[DAFEIYU] widget inject failed', e);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();

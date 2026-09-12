// Shared browser-safe core logic for DAFEIYU.
// This module intentionally has no DOM or SillyTavern dependencies so it can be tested by Node.

export const PEAK_HOURS = [[9, 12], [14, 18]];
export const BASE_PRICE = { hit: [0.02, 0.04], miss: [1.0, 2.0], out: [4.0, 8.0] };
export const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] };
export const PRICING = {
    'deepseek-flash': BASE_PRICE,
    'deepseek-v4-flash-vision-exp': BASE_PRICE,
    'deepseek-v4-flash': BASE_PRICE,
    'deepseek-chat': BASE_PRICE,
    'deepseek-reasoner': BASE_PRICE,
    'deepseek-v4-pro': PRO_PRICE,
    _default: BASE_PRICE,
};

function finiteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function priceFor(model) {
    const m = String(model || '').toLowerCase();
    for (const key of Object.keys(PRICING)) {
        if (key === '_default') continue;
        if (m.includes(key)) return PRICING[key];
    }
    return PRICING._default;
}

export function isDeepseekModel(model) {
    return /deepseek/i.test(String(model || ''));
}

// 2026-08-23 (Beijing time) onward, weekends are valley-priced all day.
export const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000);
export function isPeakTime(timeSec) {
    const n = Number(timeSec);
    if (!Number.isFinite(n)) return false;
    // Read UTC fields after adding Beijing's +08:00 offset; this is independent of local timezone.
    const bj = new Date(n * 1000 + 8 * 3600 * 1000);
    if (n >= WEEKEND_VALLEY_FROM_SEC) {
        const dow = bj.getUTCDay();
        if (dow === 0 || dow === 6) return false;
    }
    const hour = bj.getUTCHours();
    return PEAK_HOURS.some(([start, end]) => hour >= start && hour < end);
}

export function todayKey(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
}

export function costFromUsage(usage, model, timeSec) {
    const u = usage || {};
    const hit = Math.max(0, finiteNumber(u.prompt_cache_hit_tokens ?? u.promptCacheHitTokens));
    let miss = Math.max(0, finiteNumber(u.prompt_cache_miss_tokens ?? u.promptCacheMissTokens));
    const out = Math.max(0, finiteNumber(u.completion_tokens));
    const prompt = Math.max(0, finiteNumber(u.prompt_tokens));
    if (hit + miss === 0 && prompt > 0) miss = prompt;
    const p = priceFor(model);
    const pi = isPeakTime(timeSec) ? 1 : 0;
    return {
        amount: (hit / 1e6) * p.hit[pi] + (miss / 1e6) * p.miss[pi] + (out / 1e6) * p.out[pi],
        tokens: { hit, miss, out },
    };
}

export function estimateCost(model, promptTokens, outputTokens, timeSec) {
    const p = priceFor(model);
    const pi = isPeakTime(timeSec) ? 1 : 0;
    const inTok = Math.max(0, finiteNumber(promptTokens));
    const outTok = Math.max(0, finiteNumber(outputTokens));
    return {
        amount: (inTok / 1e6) * p.miss[pi] + (outTok / 1e6) * p.out[pi],
        tokens: { hit: 0, miss: inTok, out: outTok },
    };
}

function appendMessageContent(output, content) {
    if (typeof content === 'string') {
        output.push(content);
        return;
    }
    if (Array.isArray(content)) {
        for (const part of content) {
            if (part && typeof part.text === 'string') output.push(part.text);
        }
    }
}

function extractChoiceText(choices, messageKey, deltaKey) {
    const output = [];
    if (!Array.isArray(choices)) return '';
    for (const choice of choices) {
        if (!choice || typeof choice !== 'object') continue;
        const source = choice[messageKey] || choice[deltaKey] || {};
        if (!source || typeof source !== 'object') continue;
        appendMessageContent(output, source.content);
        if (typeof source.reasoning_content === 'string') output.push(source.reasoning_content);
        if (typeof source.reasoning === 'string') output.push(source.reasoning);
        if (Array.isArray(source.tool_calls)) {
            for (const call of source.tool_calls) {
                if (call?.function?.arguments) output.push(call.function.arguments);
            }
        }
    }
    return output.join('');
}

export function parseModelResponse(responseText) {
    const text = String(responseText || '').trim();
    if (!text) return { usage: null, model: '', outputText: '', createdAtSec: null };

    if (text.startsWith('{') || text.startsWith('[')) {
        try {
            const obj = JSON.parse(text);
            const item = Array.isArray(obj) ? obj[obj.length - 1] : obj;
            if (!item || typeof item !== 'object') return { usage: null, model: '', outputText: '', createdAtSec: null };
            const createdAt = Number(item.created);
            return {
                usage: item.usage && typeof item.usage === 'object' ? item.usage : null,
                model: typeof item.model === 'string' ? item.model : '',
                outputText: extractChoiceText(item.choices, 'message', 'delta'),
                createdAtSec: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null,
            };
        } catch {
            return { usage: null, model: '', outputText: '', createdAtSec: null };
        }
    }

    let usage = null;
    let model = '';
    let createdAtSec = null;
    const output = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const obj = JSON.parse(payload);
            if (!obj || typeof obj !== 'object') continue;
            if (typeof obj.model === 'string' && obj.model) model = obj.model;
            const created = Number(obj.created);
            if (Number.isFinite(created) && created > 0) createdAtSec = created;
            if (obj.usage && typeof obj.usage === 'object') usage = obj.usage;
            output.push(extractChoiceText(obj.choices, 'message', 'delta'));
        } catch {
            // A relay may emit a malformed keep-alive line; ignore it and keep scanning.
        }
    }
    return { usage, model, outputText: output.join(''), createdAtSec };
}

export function countTokensHeuristic(text) {
    if (!text) return 0;
    let cjk = 0;
    let other = 0;
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code >= 0x2E80 && code <= 0xFFEF) cjk++;
        else other++;
    }
    return Math.ceil(cjk * 0.6 + other / 4);
}

export function extractPromptText(messages) {
    if (!Array.isArray(messages)) return '';
    const output = [];
    for (const message of messages) {
        if (!message) continue;
        appendMessageContent(output, message.content);
    }
    return output.join('\n');
}

function archiveHistory(history) {
    return history && typeof history === 'object' ? { ...history } : {};
}

function pruneHistory(history) {
    const keys = Object.keys(history).sort();
    while (keys.length > 30) delete history[keys.shift()];
    return history;
}

export function rollEngineLedger(raw, cost, estimated, dateKey) {
    const date = String(dateKey || todayKey());
    const source = raw && typeof raw === 'object' ? raw : {};
    let ledger;
    if (typeof source.date === 'string' && source.date !== date) {
        const history = archiveHistory(source.history);
        if (typeof source.todayUsage === 'number') history[source.date] = source.todayUsage;
        ledger = { date, todayUsage: 0, todayTokens: 0, todayEstimated: 0, history };
    } else if (source.date === date) {
        ledger = { ...source, history: archiveHistory(source.history) };
    } else {
        ledger = { date, todayUsage: 0, todayTokens: 0, todayEstimated: 0, history: {} };
    }

    const tokens = cost?.tokens || {};
    ledger.todayUsage = Math.round((finiteNumber(ledger.todayUsage) + finiteNumber(cost?.amount)) * 1e6) / 1e6;
    ledger.todayTokens = Math.round(finiteNumber(ledger.todayTokens)
        + Math.max(0, finiteNumber(tokens.hit))
        + Math.max(0, finiteNumber(tokens.miss))
        + Math.max(0, finiteNumber(tokens.out)));
    if (estimated) ledger.todayEstimated = finiteNumber(ledger.todayEstimated) + 1;
    ledger.history = ledger.history || {};
    ledger.history[date] = ledger.todayUsage;
    pruneHistory(ledger.history);
    return ledger;
}

export function rollBalanceLedger(raw, balance, currency, engineUsage, dateKey) {
    const date = String(dateKey || todayKey());
    const source = raw && typeof raw === 'object' ? raw : {};
    const nextBalance = finiteNumber(balance, NaN);
    const cur = String(currency || '');
    const currencyChanged = typeof source.lastCurrency === 'string'
        && source.lastCurrency !== ''
        && cur !== ''
        && source.lastCurrency !== cur;
    let ledger;

    if (typeof source.date === 'string' && source.date !== date) {
        const history = archiveHistory(source.history);
        if (typeof source.todayUsage === 'number') history[source.date] = source.todayUsage;
        const carry = Number.isFinite(engineUsage) ? Math.max(0, engineUsage) : 0;
        ledger = {
            date,
            lastBalance: Number.isFinite(nextBalance) ? nextBalance : null,
            lastCurrency: cur,
            carryUsage: carry,
            balanceUsage: 0,
            todayUsage: carry,
            history,
        };
    } else if (source.date === date) {
        ledger = {
            ...source,
            history: archiveHistory(source.history),
            lastBalance: Number.isFinite(nextBalance) ? nextBalance : (typeof source.lastBalance === 'number' ? source.lastBalance : null),
            lastCurrency: cur,
        };
        const carryUsage = typeof source.carryUsage === 'number' ? source.carryUsage : finiteNumber(source.todayUsage);
        const previousBalanceUsage = typeof source.balanceUsage === 'number'
            ? source.balanceUsage
            : Math.max(0, finiteNumber(source.todayUsage) - carryUsage);
        ledger.carryUsage = carryUsage;
        ledger.balanceUsage = currencyChanged ? 0 : previousBalanceUsage;
        if (!currencyChanged) {
            const previous = typeof source.lastBalance === 'number' ? source.lastBalance : nextBalance;
            if (Number.isFinite(previous) && Number.isFinite(nextBalance) && nextBalance < previous) {
                ledger.balanceUsage += previous - nextBalance;
            }
        }
        ledger.todayUsage = carryUsage + ledger.balanceUsage;
    } else {
        ledger = {
            date,
            lastBalance: Number.isFinite(nextBalance) ? nextBalance : null,
            lastCurrency: cur,
            carryUsage: 0,
            balanceUsage: 0,
            todayUsage: 0,
            history: {},
        };
    }

    ledger.history = ledger.history || {};
    pruneHistory(ledger.history);
    return ledger;
}

export function isTransientBalanceResult(result) {
    if (!result || result.ok || typeof result.code !== 'string') return false;
    if (result.code === 'ERROR') return true;
    const match = /^HTTP(\d+)$/.exec(result.code);
    return !!match && Number(match[1]) >= 500;
}

export function shouldRetryBalanceResult(result) {
    return isTransientBalanceResult(result);
}

export function usageTokenCount(tokens) {
    if (!tokens || typeof tokens !== 'object') return 0;
    return Math.max(0, finiteNumber(tokens.hit))
        + Math.max(0, finiteNumber(tokens.miss))
        + Math.max(0, finiteNumber(tokens.out));
}

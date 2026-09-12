import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('widget CSS and DOM use the DAFEIYU namespace', () => {
  const source = readFileSync(new URL('../widget.js', import.meta.url), 'utf8');
  assert.equal(source.includes('dshwv-'), false);
  assert.equal(source.includes('dshwv-menu'), false);
  assert.equal(source.includes('--dshw-'), false);
});

test('widget supports the documented right-click menu', () => {
  const source = readFileSync(new URL('../widget.js', import.meta.url), 'utf8');
  assert.match(source, /addEventListener\('contextmenu'/);
});

test('runtime parses response bodies so old Tavern event bridges are optional', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /parseModelResponse/);
  assert.doesNotMatch(source, /自动为流式请求注入/);
});

test('unused legacy image is not referenced', () => {
  const source = readFileSync(new URL('../widget.js', import.meta.url), 'utf8');
  assert.equal(source.includes('DSniang02.png'), false);
});

test('runtime degrades gracefully when generation events are unavailable', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /generationGatingReady/);
  assert.match(source, /generationGatingReady\s*\?\s*!generationActive \|\| lastGenerationQuiet\s*:\s*false/);
  assert.doesNotMatch(source, /AbortSignal\.timeout/);
});

test('response-body completion schedules estimates without generation events', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /tn\.reading = false;[\s\S]*?if \(!generationGatingReady\) scheduleFallbackFinalize\(\);/);
  assert.match(source, /if \(t\.CONNECTION_PROFILE_LOADED\).*?\n\s*generationGatingReady = true;\n\s*\} catch \(err\) \{\n\s*console\.warn\('\[DAFEIYU\] event bridge unavailable'/);
});

test('right-click menu does not double-toggle touch long-press', () => {
  const source = readFileSync(new URL('../widget.js', import.meta.url), 'utf8');
  assert.match(source, /onDocContextMenu\(e\) \{[\s\S]*?if \(e\.button !== 2 \|\| isPluginControlTarget\(e\) \|\| !isWhaleHit\(e\)\) return/);
});

test('engine mode copy does not overpromise exact usage', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const widget = readFileSync(new URL('../widget.js', import.meta.url), 'utf8');
  assert.equal(index.includes('实时·精确（usage 截获）'), false);
  assert.match(widget, /实时·精确 \/ 估算/);
});
test('balance fetch retries transient failures and serves stale cache', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /shouldRetryBalanceResult/);
  assert.match(source, /isTransientBalanceResult\(payload\)/);
  assert.match(source, /balanceCache\.payload,[\s\S]*?stale: true/);
});

test('manual refresh animates while background refresh stays quiet', () => {
  const source = readFileSync(new URL('../widget.js', import.meta.url), 'utf8');
  assert.match(source, /var clickDelay = 0/);
  assert.match(source, /else if \(manual\)/);
  assert.doesNotMatch(source, /if \(!manual\) \{\s*showBubble\(\)/);
  assert.match(source, /clickDelay = alreadyOpen \? 0 : 550/);
});

test('cost bubble displays the turn token total', () => {
  const source = readFileSync(new URL('../widget.js', import.meta.url), 'utf8');
  assert.match(source, /showCostBubble\(Number\(turn\.amount\), !!turn\.estimated, usageTokenCount\(turn\.tokens\)\)/);
  assert.match(source, /tok/);
});

test('usage pricing prefers the response creation timestamp', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /handleUsage\(response, parsed\.usage, parsed\.model \|\| model, parsed\.createdAtSec\)/);
  assert.match(source, /Number\.isFinite\(createdAtSec\) \? createdAtSec : Math\.floor\(Date\.now\(\) \/ 1000\)/);
});

test('widget reports configuration persistence failures', () => {
  const source = readFileSync(new URL('../widget.js', import.meta.url), 'utf8');
  assert.match(source, /markSaveResult/);
  assert.match(source, /dafyv-save-error/);
  assert.match(source, /保存失败/);
});


test('extension settings report vault persistence failures', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /const saved = vaultWrite\(apiKey \|\| undefined, apiBase\)/);
  assert.match(source, /saved \? '已保存' : '保存失败，请检查浏览器存储权限'/);
});

test('manifest and runtime versions identify this synchronized release', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.6.1');
  assert.match(index, /version: '0\.6\.1'/);
});

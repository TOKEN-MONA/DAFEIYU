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

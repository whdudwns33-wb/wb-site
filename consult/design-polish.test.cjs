const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('consult UI keeps accessible focus, touch targets, and reduced motion support', () => {
  assert.match(html, /--focus:\s+rgba\(124,58,237/);
  assert.match(html, /\.btn \{[\s\S]*?min-height: 44px/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /prefers-reduced-motion: reduce/);
});

test('active navigation stays visible in the horizontal tab strip', () => {
  const renderTabs = html.match(/function renderTabs\(\) \{[\s\S]*?\n}/)?.[0] || '';
  assert.match(renderTabs, /scrollIntoView\(\{ block: 'nearest', inline: 'center' \}\)/);
});

test('mobile modal respects the device safe area', () => {
  assert.match(html, /@media \(max-width: 600px\)/);
  assert.match(html, /env\(safe-area-inset-bottom\)/);
  assert.match(html, /border-radius: 20px 20px 0 0/);
});

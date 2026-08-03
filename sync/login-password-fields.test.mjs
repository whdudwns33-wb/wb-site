import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8')).v;

for (const app of ['consult', 'task']) {
  const html = fs.readFileSync(path.join(root, app, 'index.html'), 'utf8');

  test(`${app} manager password inputs accept complex passwords`, () => {
    const loginInput = html.match(/<input[^>]+id="pin"[^>]*>/)?.[0] ?? '';
    const newPasswordInput = html.match(/<input[^>]+id="newPin"[^>]*>/)?.[0] ?? '';

    for (const input of [loginInput, newPasswordInput]) {
      assert.match(input, /type="password"/);
      assert.match(input, /inputmode="text"/);
      assert.match(input, /autocapitalize="none"/);
      assert.match(input, /spellcheck="false"/);
    }
    assert.doesNotMatch(loginInput, /inputmode="numeric"/);
    assert.match(newPasswordInput, /autocomplete="new-password"/);
  });

  test(`${app} static version matches version.json`, () => {
    assert.match(html, new RegExp(`const APP_VER = ['"]${version}['"];`));
  });
}

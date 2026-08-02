import fs from 'node:fs';
import vm from 'node:vm';

const files = process.argv.slice(2);
if (!files.length) throw new Error('HTML file path is required');

for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!scripts.length) throw new Error(`${file}: inline script not found`);
  scripts.forEach((match, index) => {
    new vm.Script(match[1], { filename: `${file}#inline-${index + 1}` });
  });
  console.log(`${file}: ${scripts.length} inline script(s) valid`);
}

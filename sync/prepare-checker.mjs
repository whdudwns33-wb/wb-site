import { readFileSync } from 'node:fs';
import { checkerVerifier } from './task-checker.js';

try {
  if (process.argv.length !== 2) throw new Error('암호를 표준 입력으로 전달하세요.');
  const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  console.log(await checkerVerifier(password));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { hashPassword } from './task-director.js';
export async function managerSeed(accounts,password) {
  if (!Array.isArray(accounts) || !accounts.length || typeof password!=='string' || password.length<4 || password.length>128) throw new Error('관리자 목록과 초기 비밀번호(4~128자)가 필요합니다');
  const ids=new Set(), logins=new Set(), rows=[];
  for(const account of accounts) {
    const id=account.staffId, login=String(account.loginId || '').normalize('NFC').toLowerCase();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id || '') || !/^wb[가-힣a-z0-9._-]{1,62}$/u.test(login) || ids.has(id) || logins.has(login)) throw new Error('직원 ID·wb이름 형식·중복 계정을 확인해 주세요');
    ids.add(id);logins.add(login);
    const salt=crypto.randomUUID(),hash=await hashPassword(password,salt);
    rows.push(`INSERT INTO task_manager_accounts(staff_id,login_id,salt,password_hash) VALUES('${id}','${login}','${salt}','${hash}') ON CONFLICT(staff_id) DO NOTHING;`);
  }
  return rows.join('\n')+'\n';
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const accounts=JSON.parse(await readFile(process.argv[2],'utf8'));
  const sql=await managerSeed(accounts,process.env.TASK_INITIAL_PASSWORD);
  await mkdir(new URL('../.private/',import.meta.url),{recursive:true});
  await writeFile(new URL('../.private/task-manager-seed.sql',import.meta.url),sql,{mode:0o600});
  console.log('관리자 계정 설치 SQL 생성: '+accounts.length+'건 (기존 비밀번호 유지)');
}

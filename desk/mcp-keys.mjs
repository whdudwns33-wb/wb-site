import { hashKey, makeKey } from './read-mcp.mjs';

const KEY_PREFIX = 'pds_';
const KEY_HEADER = new RegExp('^Bearer (' + KEY_PREFIX + '[A-Za-z0-9_-]{43})(?![\\s\\S])', 'i');
const KEY_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export const apiKey = header => KEY_HEADER.exec(header || '')?.[1];

const reply = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function manageMcpKey(db, body) {
  const now = Date.now();
  if (body?.op === 'add-key') {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const days = body.days ?? 90;
    if (!name || [...name].length > 80 || /[\x00-\x1f\x7f]/.test(name) ||
        !Number.isInteger(days) || days < 1 || days > 365) {
      return reply({ code: 'INVALID' }, 400);
    }
    const key = makeKey(KEY_PREFIX);
    const id = crypto.randomUUID();
    const expiresAt = now + days * 86_400_000;
    // INSERT 안에서 개수를 확인해 동시에 발급해도 20개를 넘지 않는다.
    const issued = await db.prepare(`
      INSERT INTO api_tokens (id, token_hash, name, scope, created_at, expires_at)
      SELECT ?1, ?2, ?3, 'read', ?4, ?5
      WHERE EXISTS (SELECT 1 FROM desk_admin_mcp_ready WHERE id=1)
        AND (SELECT COUNT(*) FROM api_tokens WHERE revoked_at IS NULL AND expires_at > ?4) < 20
      RETURNING id
    `).bind(id, await hashKey(key), name, now, expiresAt).first();
    if (issued) return reply({ id, key, expiresAt });
    const ready = await db.prepare('SELECT id FROM desk_admin_mcp_ready WHERE id=1').first();
    return ready ? reply({ code: 'KEY_LIMIT' }, 409) : reply({ code: 'PASSWORD_CHANGE_REQUIRED' }, 403);
  }
  if (body?.op === 'revoke-key' && typeof body.id === 'string' && KEY_ID.test(body.id)) {
    await db.prepare('UPDATE api_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
      .bind(now, body.id).run();
    const row = await db.prepare('SELECT id FROM api_tokens WHERE id=?').bind(body.id).first();
    return row ? reply({ ok: true }) : reply({ code: 'NOT_FOUND' }, 404);
  }
  return reply({ code: 'INVALID' }, 400);
}

export async function authorizeMcpRead(db, header) {
  const key = apiKey(header);
  if (!key) return null;
  const hash = await hashKey(key);
  const now = Date.now();
  const valid = "token_hash=?1 AND scope='read' AND revoked_at IS NULL AND expires_at>?2";
  // 같은 키의 최근 60초 요청을 D1에서 검사한다. 다른 Worker isolate와도 한도를 공유한다.
  const allowed = await db.prepare(`
    UPDATE api_tokens
    SET last_used=max(COALESCE(last_used, 0), ?2), request_times=(
      SELECT json_insert(json_group_array(value), '$[#]', ?2)
      FROM json_each(request_times) WHERE value>?3
    )
    WHERE ${valid} AND (SELECT COUNT(*) FROM json_each(request_times) WHERE value>?3)<120
    RETURNING id
  `).bind(hash, now, now - 60_000).first();
  if (allowed) return { user: { role: 'admin', staffId: 'admin' }, scope: 'read' };
  const limited = await db.prepare('SELECT id FROM api_tokens WHERE ' + valid).bind(hash, now).first();
  return limited ? { limited: true } : null;
}

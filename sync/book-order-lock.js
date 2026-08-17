const LEASE_MS = 10 * 60 * 1000;

export async function acquireBookOrderDispatchLock(env, app, kind, now) {
  const owner = String(kind || 'send') + '_' + crypto.randomUUID();
  const leaseUntil = now + LEASE_MS;
  const result = await env.DB.prepare(
    'INSERT INTO book_order_dispatch_lock(app,owner,lease_until,updated_at) VALUES(?,?,?,?) ' +
    'ON CONFLICT(app) DO UPDATE SET owner=excluded.owner, lease_until=excluded.lease_until, ' +
      'updated_at=excluded.updated_at WHERE book_order_dispatch_lock.lease_until<=?'
  ).bind(app, owner, leaseUntil, now, now).run();
  return Number(result && result.meta && result.meta.changes || 0) === 1
    ? { owner, leaseUntil } : null;
}

async function releaseBookOrderDispatchLock(env, app, lock) {
  if (!lock) return;
  await env.DB.prepare('DELETE FROM book_order_dispatch_lock WHERE app=? AND owner=?')
    .bind(app, lock.owner).run();
}

export async function renewBookOrderDispatchLock(env, app, lock, now) {
  const leaseUntil = now + LEASE_MS;
  const result = await env.DB.prepare(
    'UPDATE book_order_dispatch_lock SET lease_until=?,updated_at=? ' +
    'WHERE app=? AND owner=? AND lease_until>?'
  ).bind(leaseUntil, now, app, lock.owner, now).run();
  if (Number(result && result.meta && result.meta.changes || 0) !== 1) return false;
  lock.leaseUntil = leaseUntil;
  return true;
}

export async function releaseBookOrderDispatchLockSafely(env, app, lock) {
  try { await releaseBookOrderDispatchLock(env, app, lock); }
  catch (error) { console.error('BOOK_ORDER_DISPATCH_LOCK_RELEASE_FAILED'); }
}

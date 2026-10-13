'use strict';
import { BlockList, isIP } from 'node:net';

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

function family(ip) {
  const version = typeof ip === 'string' && !ip.includes('%') ? isIP(ip) : 0;
  return version ? 'ipv' + version : '';
}

function duplicateHeader(req, name) {
  let count = 0;
  for (let i = 0; i < (req.rawHeaders || []).length; i += 2)
    if (String(req.rawHeaders[i]).toLowerCase() === name) count++;
  return count > 1;
}

/* BlockList의 native 주소 판정은 IPv4-mapped IPv6도 같은 IPv4 규칙으로 검사한다. */
export function createInhouseAccess(networksString = '') {
  if (typeof networksString !== 'string') throw new Error('원내 허용망은 IP/CIDR 문자열이어야 합니다.');
  const allowed = new BlockList();
  for (const entry of networksString.trim() ? networksString.split(',') : []) {
    const parts = entry.trim().split('/'), type = family(parts[0]);
    const prefix = parts.length === 2 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
    if (!type || parts.length > 2 || (parts.length === 2 && (prefix == null || prefix < 1 || prefix > (type === 'ipv4' ? 32 : 128))))
      throw new Error('원내 허용망은 정확한 IP 또는 CIDR이어야 하며 /0은 허용하지 않습니다.');
    if (parts.length === 1) allowed.addAddress(parts[0], type);
    else allowed.addSubnet(parts[0], prefix, type);
  }
  return (req) => {
    const peer = req && req.socket && req.socket.remoteAddress, type = family(peer);
    if (!type) return false;
    if (!loopback.check(peer, type)) return allowed.check(peer, type);
    const headers = req.headers || {};
    /* CF 헤더는 localhost의 cloudflared 연결에서만 신뢰한다. 직접 LAN 연결의 헤더는 무시한다. */
    if (Object.hasOwn(headers, 'cf-connecting-ip')) {
      const client = headers['cf-connecting-ip'], clientType = family(client);
      return !!clientType && !duplicateHeader(req, 'cf-connecting-ip')
        && !loopback.check(client, clientType) && allowed.check(client, clientType);
    }
    /* 공개 호스트에서 CF 헤더가 빠져도 터널의 loopback 연결을 원내 학생으로 오인하지 않는다. */
    const host = typeof headers.host === 'string' && headers.host.match(/^(?:\[([^\]]+)\]|([^:]+))(?::(\d{1,5}))?$/);
    if (!host || duplicateHeader(req, 'host') || (host[3] && Number(host[3]) > 65535)) return false;
    return host[1] ? family(host[1]) === 'ipv6' : host[2].toLowerCase() === 'localhost' || family(host[2]) === 'ipv4';
  };
}

"""원장 최초 비밀번호를 이 PC에서 입력. 비밀번호와 임시 설정 키는 파일/로그에 남기지 않는다."""
import json
import pathlib
import secrets
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

ORIGIN = 'https://blended.wbcowork.com'
LOCAL = 'http://127.0.0.1:8897'
CF = 'https://api.cloudflare.com/client/v4/accounts/378cf7d252bd8c717bda617614bbcf57/workers/scripts/wb-blended/secrets'


def request(url, data, headers, method='POST'):
    req = urllib.request.Request(url, json.dumps(data).encode(), {'Content-Type': 'application/json', 'User-Agent': 'WBBlendedSetup/0.1', **headers}, method=method)
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def main():
    runtime = request(ORIGIN + '/blended/api', {'app': 'blended', 'action': 'runtime'}, {'Origin': ORIGIN, 'X-Blended-Request': '1'})
    if runtime.get('ready'):
        print('원장 계정이 이미 설정되어 있습니다. 외부 로그인 화면을 이용하세요.')
        return
    auth_path = pathlib.Path.home() / '.wrangler' / 'config' / 'default.toml'
    cf_token = tomllib.loads(auth_path.read_text(encoding='utf-8'))['oauth_token']
    bootstrap = secrets.token_hex(32)
    csrf = secrets.token_hex(24)
    result = request(CF, {'name': 'BOOTSTRAP_TOKEN', 'text': bootstrap, 'type': 'secret_text'}, {'Authorization': 'Bearer ' + cf_token}, 'PUT')
    if not result.get('success'):
        raise RuntimeError('최초 설정 경로 준비 실패')
    completed = False

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def page(self, content, status=200):
            body = ('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                    '<meta name="robots" content="noindex"><title>블렌디드 원장 최초 설정</title>'
                    '<style>body{font:16px/1.7 "Malgun Gothic",sans-serif;background:#f4f7fa;color:#17364a;max-width:520px;margin:8vh auto;padding:24px}main{background:white;border:1px solid #ccd8df;padding:28px;border-radius:12px}label{display:block;margin:20px 0}input,button{font:inherit;padding:12px;width:100%;box-sizing:border-box}button{background:#136b68;color:white;border:0;border-radius:6px}a{color:#136b68}</style><main>' + content + '</main></html>').encode()
            self.send_response(status)
            for key, value in {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.headers.get('Host') != '127.0.0.1:8897' or self.path != '/':
                return self.page('허용되지 않은 요청입니다.', 403)
            if completed:
                return self.page(f'<h1>설정 완료</h1><p>원장 아이디: whdudwns33</p><a href="{ORIGIN}/blended/">블렌디드 로그인 열기</a>')
            self.page('<h1>원장 비밀번호 설정</h1><p>서비스: blended.wbcowork.com<br>아이디: <b>whdudwns33</b></p>'
                      '<p>이 화면은 현재 PC에서만 열립니다. 비밀번호는 서버에 해시로 저장됩니다.</p>'
                      f'<form method="post"><input type="hidden" name="csrf" value="{csrf}">'
                      '<label>새 비밀번호 (12자 이상)<input type="password" name="password" required minlength="12" maxlength="128" autocomplete="new-password"></label>'
                      '<label>비밀번호 확인<input type="password" name="confirm" required minlength="12" maxlength="128" autocomplete="new-password"></label>'
                      '<button>원장 계정 설정</button></form>')

        def do_POST(self):
            nonlocal completed, bootstrap
            if self.path != '/' or self.headers.get('Host') != '127.0.0.1:8897' or self.headers.get('Origin') != LOCAL:
                return self.page('허용되지 않은 요청입니다.', 403)
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 4096:
                return self.page('입력 크기를 확인해 주세요.', 400)
            fields = urllib.parse.parse_qs(self.rfile.read(size).decode())
            value = lambda key: fields.get(key, [''])[0]
            password = value('password')
            if completed or not secrets.compare_digest(value('csrf'), csrf):
                return self.page('이미 설정되었거나 요청이 만료되었습니다.', 409)
            if password != value('confirm') or not 12 <= len(password) <= 128:
                return self.page('<p>비밀번호가 일치하는지, 12자 이상인지 확인해 주세요.</p><a href="/">다시 입력</a>', 400)
            try:
                result = request(ORIGIN + '/blended/api', {'app': 'blended', 'action': 'setup', 'payload': {'token': bootstrap, 'password': password}}, {'Origin': ORIGIN, 'X-Blended-Request': '1'})
                if not result.get('created'):
                    raise RuntimeError('setup failed')
                completed = True
                bootstrap = ''
                self.page(f'<h1>설정 완료</h1><p>원장 아이디: <b>whdudwns33</b><br>이제 외부에서도 로그인할 수 있습니다.</p><a href="{ORIGIN}/blended/">블렌디드 로그인 열기</a>')
                print('원장 최초 설정 완료. 비밀번호를 출력하거나 기록하지 않았습니다.', flush=True)
            except Exception:
                self.page('<p>설정을 완료하지 못했습니다. 입력 내용을 기록하지 않았습니다.</p><a href="/">다시 입력</a>', 503)

    server = HTTPServer(('127.0.0.1', 8897), Handler)
    print('원장 최초 설정 화면: ' + LOCAL + '/', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()

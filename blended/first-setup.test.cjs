'use strict';
const {execFileSync}=require('node:child_process');
execFileSync('python',['-c',String.raw`
import importlib.util, io
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('setup','blended/first-setup.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
calls=[]
def remote(url,data,headers,method='POST'):
    calls.append(data)
    if data.get('action')=='runtime': return {'ready':False}
    if data.get('action')=='setup': return {'created':True}
    return {'success':True}
class Server:
    def __init__(self,address,Handler):
        assert address==('127.0.0.1',8897)
        self.Handler=Handler
    def serve_forever(self):
        h=object.__new__(self.Handler);h.headers={'Host':'127.0.0.1:8897'};h.path='/'
        response_headers={};h.send_response=lambda status:None;h.send_header=lambda k,v:response_headers.update({k:v});h.end_headers=lambda:None;h.wfile=io.BytesIO()
        h.page('<p>fixture</p>')
        assert response_headers['Referrer-Policy']=='same-origin', 'HTML form POST must retain its same-origin Origin header'
        pages=[];h.page=lambda content,status=200:pages.append((content,status))
        h.do_GET();content=pages[-1][0]
        import re
        csrf=re.search('name="csrf" value="([^"]+)"',content).group(1)
        def submit(fields,origin=m.LOCAL):
            raw=m.urllib.parse.urlencode(fields).encode()
            h.headers={'Host':'127.0.0.1:8897','Origin':origin,'Content-Length':str(len(raw))};h.rfile=io.BytesIO(raw)
            h.do_POST();return pages[-1][1]
        good={'csrf':csrf,'password':'Synthetic-password!','confirm':'Synthetic-password!'}
        assert submit(good,'https://untrusted.example')==403
        assert submit({**good,'csrf':'wrong'})==409
        assert submit({**good,'confirm':'different'})==400
        assert not any(c.get('action')=='setup' for c in calls)
        assert submit(good)==200
        assert submit(good)==409
        assert sum(c.get('action')=='setup' for c in calls)==1
        assert all('Synthetic-password!' not in page[0] for page in pages)
with patch.object(m,'request',remote),patch.object(m,'HTTPServer',Server),patch.object(m.pathlib.Path,'read_text',return_value='oauth_token="synthetic-token"'),patch('builtins.print'):
    m.main()
print('PASS setup helper: loopback, origin, CSRF, password match, single-use, no secret echo')
`],{stdio:'inherit'});

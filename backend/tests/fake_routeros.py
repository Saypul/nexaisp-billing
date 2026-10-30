"""In-process fake MikroTik that speaks the RouterOS API sentence protocol for tests."""
import socket
import socketserver
import threading

from app.mikrotik import encode_sentence


def read_sentence(rfile):
    words = []
    while True:
        first = rfile.read(1)
        if not first:
            return None
        b = first[0]
        if b < 0x80:
            length = b
        elif b < 0xC0:
            length = ((b & 0x3F) << 8) | rfile.read(1)[0]
        elif b < 0xE0:
            length = ((b & 0x1F) << 16) | int.from_bytes(rfile.read(2), 'big')
        elif b < 0xF0:
            length = ((b & 0x0F) << 24) | int.from_bytes(rfile.read(3), 'big')
        else:
            length = int.from_bytes(rfile.read(4), 'big')
        if length == 0:
            return words
        words.append(rfile.read(length).decode())


class FakeRouter:
    def __init__(self, username='api', password='secret'):
        self.username, self.password = username, password
        self.secrets, self.active, self.commands = [], [], []
        self.profiles = [{'.id': '*0', 'name': 'default', 'default': 'true'}, {'.id': '*P1', 'name': 'paket-30m', 'rate-limit': '30M/30M'},
                         {'.id': '*P2', 'name': 'isolir'}]
        self.pools = [{'.id': '*L1', 'name': 'pool-pppoe', 'ranges': '10.20.0.2-10.20.255.254'},
                      {'.id': '*L2', 'name': 'pool-bisnis', 'ranges': '172.16.5.10-172.16.5.200'}]
        self.addresses = [{'.id': '*I1', 'address': '172.16.5.1/24', 'interface': 'vlan-bisnis', 'disabled': 'false'}]
        self.next_id = 1
        router = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                authed = False
                while True:
                    words = read_sentence(self.rfile)
                    if words is None:
                        return
                    cmd, attrs, query = words[0], {}, {}
                    for w in words[1:]:
                        if w.startswith('='):
                            k, _, v = w[1:].partition('=')
                            attrs[k] = v
                        elif w.startswith('?'):
                            k, _, v = w[1:].partition('=')
                            query[k] = v
                    router.commands.append((cmd, attrs, query))
                    if cmd == '/login':
                        if attrs.get('name') == router.username and attrs.get('password') == router.password:
                            authed = True
                            self.send(['!done'])
                        else:
                            self.send(['!trap', '=message=invalid user name or password (6)'])
                            self.send(['!done'])
                        continue
                    if not authed:
                        self.send(['!fatal', 'not logged in'])
                        return
                    for reply in router.dispatch(cmd, attrs, query):
                        self.send(reply)

            def send(self, words):
                self.wfile.write(encode_sentence(words))

        self.server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def secret(self, name):
        return next((s for s in self.secrets if s['name'] == name), None)

    @staticmethod
    def rows(items, query):
        return [['!re'] + [f'={k}={v}' for k, v in item.items()] for item in items if all(item.get(k) == v for k, v in query.items())]

    def dispatch(self, cmd, attrs, query):
        if cmd == '/system/resource/print':
            return [['!re', '=version=7.16.2 (stable)', '=board-name=CCR2004', '=uptime=3d4h', '=cpu-load=7',
                     '=free-memory=3000000000', '=total-memory=4000000000'], ['!done']]
        if cmd == '/system/identity/print':
            return [['!re', '=name=BRAS-TEST'], ['!done']]
        if cmd == '/ppp/active/print':
            if 'count-only' in attrs:
                return [['!done', f'=ret={len(self.active)}']]
            return self.rows(self.active, query) + [['!done']]
        if cmd == '/ppp/profile/print':
            return self.rows(self.profiles, query) + [['!done']]
        if cmd == '/ip/address/print':
            return self.rows(self.addresses, query) + [['!done']]
        if cmd == '/ip/pool/print':
            return self.rows(self.pools, query) + [['!done']]
        for path, table in (('/ppp/profile', self.profiles), ('/ppp/secret', self.secrets)):
            if cmd == path + '/add' and path == '/ppp/profile':
                if any(p['name'] == attrs['name'] for p in table):
                    return [['!trap', '=message=failure: profile with the same name already exists'], ['!done']]
                item = {'.id': f'*{self.next_id}', **attrs}
                self.next_id += 1
                table.append(item)
                return [['!done', '=ret=' + item['.id']]]
            if cmd == path + '/set' and path == '/ppp/profile':
                next(p for p in table if p['.id'] == attrs['.id']).update({k: v for k, v in attrs.items() if k != '.id'})
                return [['!done']]
            if cmd == path + '/unset':
                next(p for p in table if p['.id'] == attrs['.id']).pop(attrs['value-name'], None)
                return [['!done']]
            if cmd == path + '/remove':
                table[:] = [p for p in table if p['.id'] != attrs['.id']]
                return [['!done']]
        if cmd == '/ppp/secret/print':
            return self.rows(self.secrets, query) + [['!done']]
        if cmd == '/ppp/secret/add':
            if self.secret(attrs['name']):
                return [['!trap', '=message=failure: secret with the same name already exists'], ['!done']]
            item = {'.id': f'*{self.next_id}', **attrs}
            self.next_id += 1
            self.secrets.append(item)
            return [['!done', '=ret=' + item['.id']]]
        if cmd == '/ppp/secret/set':
            item = next(s for s in self.secrets if s['.id'] == attrs['.id'])
            item.update({k: v for k, v in attrs.items() if k != '.id'})
            return [['!done']]
        if cmd == '/ppp/active/remove':
            self.active = [a for a in self.active if a['.id'] != attrs['.id']]
            return [['!done']]
        return [['!trap', f'=message=no such command {cmd}'], ['!done']]


def unused_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

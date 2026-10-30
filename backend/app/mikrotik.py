"""Minimal MikroTik RouterOS classic API client (port 8728, or 8729 with TLS).

Implements the documented sentence protocol without third-party dependencies so it
works on RouterOS v6.43+ and v7. Every call opens a short-lived connection with
timeouts; routers are never kept connected by the web process.
"""
import hashlib
import socket
import ssl
from binascii import hexlify, unhexlify

DEFAULT_TIMEOUT = 6.0


class RouterOSError(Exception):
    """Router replied with !trap/!fatal, or the connection failed."""


class RouterOSTrap(RouterOSError):
    """Router menolak perintah (!trap), mis. nama duplikat atau nilai tidak valid. Koneksi tetap sehat."""


def encode_length(length: int) -> bytes:
    if length < 0x80:
        return bytes([length])
    if length < 0x4000:
        return (length | 0x8000).to_bytes(2, 'big')
    if length < 0x200000:
        return (length | 0xC00000).to_bytes(3, 'big')
    if length < 0x10000000:
        return (length | 0xE0000000).to_bytes(4, 'big')
    return b'\xf0' + length.to_bytes(4, 'big')


def encode_word(word: str) -> bytes:
    data = word.encode('utf-8')
    return encode_length(len(data)) + data


def encode_sentence(words) -> bytes:
    return b''.join(encode_word(w) for w in words) + b'\x00'


class RouterOSClient:
    def __init__(self, host: str, port: int, username: str, password: str,
                 use_tls: bool = False, tls_verify: bool = False, timeout: float = DEFAULT_TIMEOUT):
        self.host, self.port, self.username, self.password = host, port, username, password
        self.use_tls, self.tls_verify, self.timeout = use_tls, tls_verify, timeout
        self.sock = None

    # --- connection -------------------------------------------------------
    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *exc):
        self.close()

    def connect(self):
        try:
            raw = socket.create_connection((self.host, self.port), timeout=self.timeout)
            if self.use_tls:
                ctx = ssl.create_default_context()
                if not self.tls_verify:
                    ctx.check_hostname = False
                    ctx.verify_mode = ssl.CERT_NONE
                raw = ctx.wrap_socket(raw, server_hostname=self.host)
            raw.settimeout(self.timeout)
            self.sock = raw
        except (OSError, ssl.SSLError) as exc:
            raise RouterOSError(f'Tidak dapat terhubung ke {self.host}:{self.port} ({exc.__class__.__name__}: {exc})') from None
        self.login()

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            finally:
                self.sock = None

    def login(self):
        replies = self.talk(['/login', '=name=' + self.username, '=password=' + self.password])
        challenge = next((r.get('ret') for r in replies if r.get('ret')), None)
        if challenge:  # RouterOS sebelum 6.43 memakai challenge MD5.
            digest = hashlib.md5(b'\x00' + self.password.encode('utf-8') + unhexlify(challenge)).digest()
            self.talk(['/login', '=name=' + self.username, '=response=00' + hexlify(digest).decode('ascii')])

    # --- protocol ---------------------------------------------------------
    def _recv_exact(self, n: int) -> bytes:
        buf = b''
        while len(buf) < n:
            try:
                chunk = self.sock.recv(n - len(buf))
            except (OSError, ssl.SSLError) as exc:
                raise RouterOSError(f'Koneksi ke router terputus ({exc})') from None
            if not chunk:
                raise RouterOSError('Koneksi ditutup oleh router')
            buf += chunk
        return buf

    def _read_length(self) -> int:
        first = self._recv_exact(1)[0]
        if first < 0x80:
            return first
        if first < 0xC0:
            return ((first & 0x3F) << 8) | self._recv_exact(1)[0]
        if first < 0xE0:
            return ((first & 0x1F) << 16) | int.from_bytes(self._recv_exact(2), 'big')
        if first < 0xF0:
            return ((first & 0x0F) << 24) | int.from_bytes(self._recv_exact(3), 'big')
        return int.from_bytes(self._recv_exact(4), 'big')

    def _read_sentence(self) -> list[str]:
        words = []
        while True:
            length = self._read_length()
            if length == 0:
                return words
            words.append(self._recv_exact(length).decode('utf-8', errors='replace'))

    def talk(self, words) -> list[dict]:
        """Send one command; return the attribute dicts of every !re (and !done with values)."""
        try:
            self.sock.sendall(encode_sentence(words))
        except (OSError, ssl.SSLError) as exc:
            raise RouterOSError(f'Gagal mengirim perintah ke router ({exc})') from None
        replies, error = [], None
        while True:
            sentence = self._read_sentence()
            if not sentence:
                continue
            kind, attrs = sentence[0], {}
            for word in sentence[1:]:
                if word.startswith('='):
                    key, _, value = word[1:].partition('=')
                    attrs[key] = value
            if kind == '!re':
                replies.append(attrs)
            elif kind == '!trap':
                error = error or attrs.get('message', 'Perintah ditolak router')
            elif kind == '!fatal':
                raise RouterOSError(sentence[1] if len(sentence) > 1 else 'Router menutup sesi API')
            elif kind == '!done':
                if error:
                    raise RouterOSTrap(error)
                if attrs:
                    replies.append(attrs)
                return replies

    # --- helpers ----------------------------------------------------------
    def query(self, path: str, **query) -> list[dict]:
        words = [path + '/print'] + [f'?{k}={v}' for k, v in query.items()]
        return self.talk(words)

    def run(self, command: str, **attrs) -> list[dict]:
        return self.talk([command] + [f'={k}={v}' for k, v in attrs.items()])

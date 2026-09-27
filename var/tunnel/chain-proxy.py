#!/usr/bin/env python3
"""Local chaining proxy for browser verification.
Listens on 127.0.0.1:8888, forwards to the upstream egress proxy from env.
- Strips client proxy-auth (Chromium proxy-auth is broken here); injects
  upstream Proxy-Authorization from the HTTPS_PROXY env var at runtime.
- Forces Accept-Encoding: identity (egress mangles compressed Pinggy bodies).
Creds never touch disk: read from os.environ only.
"""
import os, socket, threading, base64
from urllib.parse import urlparse

UP = urlparse(os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "")
UP_HOST, UP_PORT = UP.hostname, UP.port or 3128
AUTH = ("Proxy-Authorization: Basic " + base64.b64encode(
    f"{UP.username}:{UP.password}".encode()).decode()) if UP.username else None
LISTEN = ("127.0.0.1", 8888)

def relay(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass

def handle(client):
    try:
        f = client.makefile("rb")
        reqline = f.readline().decode("latin1")
        if not reqline:
            client.close(); return
        method, target, ver = reqline.split()[:3]
        headers = {}
        while True:
            line = f.readline().decode("latin1")
            if line in ("\r\n", "\n", ""): break
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()
        up = socket.create_connection((UP_HOST, UP_PORT), timeout=30)
        if method.upper() == "CONNECT":
            out = [f"CONNECT {target} HTTP/1.1", f"Host: {target}"]
            if AUTH: out.append(AUTH)
            out.append("Connection: keep-alive")
            up.sendall(("\r\n".join(out) + "\r\n\r\n").encode())
            resp = b""
            while b"\r\n\r\n" not in resp:
                chunk = up.recv(4096)
                if not chunk: break
                resp += chunk
            if b" 200" not in resp.split(b"\r\n", 1)[0]:
                client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                client.close(); up.close(); return
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            t1 = threading.Thread(target=relay, args=(client, up), daemon=True)
            t2 = threading.Thread(target=relay, args=(up, client), daemon=True)
            t1.start(); t2.start(); t1.join(); t2.join()
        else:
            out = [f"{method} {target} HTTP/1.1"]
            for k, v in headers.items():
                if k in ("proxy-authorization", "proxy-connection", "accept-encoding", "connection"):
                    continue
                out.append(f"{k}: {v}")
            out.append("Accept-Encoding: identity")
            if AUTH: out.append(AUTH)
            out.append("Connection: close")
            up.sendall(("\r\n".join(out) + "\r\n\r\n").encode())
            body = f.read()  # any request body (GETs have none)
            if body: up.sendall(body)
            client.sendall(b"")  # ensure client file obj flushed
            t = threading.Thread(target=relay, args=(up, client), daemon=True)
            t.start(); t.join()
    except Exception:
        try: client.close()
        except OSError: pass

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(LISTEN)
srv.listen(64)
print(f"chain proxy on {LISTEN[0]}:{LISTEN[1]} -> {UP_HOST}:{UP_PORT}", flush=True)
while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()

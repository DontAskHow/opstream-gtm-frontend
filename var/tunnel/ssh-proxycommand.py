#!/usr/bin/env python3
"""SSH ProxyCommand: tunnel SSH through the authenticating egress proxy.
Reads proxy URL (with creds) from HTTPS_PROXY env at runtime. Never writes creds to disk.
Usage: proxycommand.py <ssh-host> <ssh-port>
"""
import os, sys, subprocess
from urllib.parse import urlparse, unquote

host, port = sys.argv[1], sys.argv[2]
up = urlparse(os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "")
auth = f"{unquote(up.username or '')}:{unquote(up.password or '')}"
# socat PROXY: proxy-host : target-host : target-port
cmd = [
    "socat", "STDIO",
    f"PROXY:{up.hostname}:{host}:{port},proxyport={up.port or 3128},proxyauth={auth}",
]
os.execvp("socat", cmd)

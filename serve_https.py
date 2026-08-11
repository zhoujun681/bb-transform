"""
一键启动 HTTPS 静态服务器（用于启用扫码 / 让手机访问）。

为什么需要 HTTPS：
  浏览器只在「安全上下文」里开放摄像头(navigator.mediaDevices)。
  http://局域网IP 属于非安全上下文 → 摄像头被禁用 → 无法扫码。
  本脚本用自签证书开启 HTTPS，手机访问 https://电脑IP:8443 即可扫码。

注意：
  - 首次访问手机会提示「证书不受信任」，点「高级 / 仍然继续」即可（自签证书的正常现象）。
  - 电脑和手机必须连同一个 Wi-Fi（同一局域网）。
  - 全程不走外网，仍是断网可用的纯局域网传输。

用法：
  python serve_https.py            # 默认端口 8443
  python serve_https.py 9000       # 指定端口

依赖：仅 Python 标准库 + OpenSSL（系统 openssl 命令，用于生成证书）。
"""

import http.server
import os
import socket
import socketserver
import ssl
import subprocess
import sys
import shutil

# Force UTF-8 stdout so emoji / Chinese don't crash on the default GBK Windows console.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
HERE = os.path.dirname(os.path.abspath(__file__))
CERT = os.path.join(HERE, "_cert.pem")
KEY = os.path.join(HERE, "_key.pem")


def is_port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def find_free_port(preferred):
    """Return the preferred port if free, else the next free one above it."""
    for port in range(preferred, preferred + 50):
        if is_port_free(port):
            return port
    return preferred


def local_ips():
    """Return non-loopback IPv4 addresses of this machine."""
    ips = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    return ips or ["你的局域网IP"]


def ensure_cert():
    if os.path.exists(CERT) and os.path.exists(KEY):
        return
    print("生成自签证书（首次运行，约 1 秒）…")
    # Subject Alt Name must include IP entries so Chrome accepts the cert for IP access.
    # We add the most common LAN ranges + localhost.
    san = "DNS:localhost,IP:127.0.0.1"
    for ip in local_ips():
        if ip != "127.0.0.1":
            san += f",IP:{ip}"
    openssl = shutil.which("openssl")
    if not openssl and os.name == "nt":
        candidates = [
            r"C:\Program Files\Git\usr\bin\openssl.exe",
            r"C:\Program Files\Git\mingw64\bin\openssl.exe",
            r"C:\Program Files\OpenSSL-Win64\bin\openssl.exe",
        ]
        openssl = next((item for item in candidates if os.path.exists(item)), None)
    if not openssl:
        print("❌ 生成证书失败：未找到 openssl。")
        sys.exit(1)

    cmd = [
        openssl, "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", KEY, "-out", CERT, "-days", "365", "-nodes",
        "-subj", "/CN=bb-transform-local",
        "-addext", f"subjectAltName={san}",
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except Exception as e:
        print("❌ 生成证书失败：", e)
        sys.exit(1)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    def log_message(self, *a):  # quieter logs
        pass


def main():
    ensure_cert()
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)

    port = find_free_port(PORT)
    if port != PORT:
        print(f"  [note] port {PORT} busy, using {port} instead")

    class Server(socketserver.TCPServer):
        allow_reuse_address = True

    try:
        httpd = Server(("0.0.0.0", port), Handler)
    except OSError as e:
        print(f"  [error] cannot bind port {port}: {e}")
        print("   try: python serve_https.py 9443")
        sys.exit(1)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    ips = local_ips()
    print("=" * 56)
    print("  [OK] HTTPS server started")
    print("  Open this address on your phone (same Wi-Fi):")
    for ip in ips:
        print(f"     https://{ip}:{port}")
    print("  (First visit warns the cert is untrusted -> Advanced -> Proceed)")
    print("  Press Ctrl+C to stop")
    print("=" * 56)
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()

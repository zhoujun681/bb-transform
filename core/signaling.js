// signaling.js — offer/answer encoding for QR codes and manual paste.
//
// Uses the browser-native CompressionStream('deflate-raw') + base64url so no
// third-party compression lib is needed. A LAN host-only offer/answer compresses
// to ~600-900 bytes, fitting comfortably in a single QR code (version ~15-20,
// ECC level M) when rendered as a canvas via the vendored qrcode-generator.
//
// QR scanning is done with the vendored jsQR over a <video> frame stream.

const Signaling = (() => {
  // ---- SDP text <-> compressed base64url string ----

  function bytesToB64url(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlToBytes(str) {
    const s = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
    const bin = atob(s + '='.repeat(pad));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function deflateRaw(input) {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(input);
    writer.close();
    const out = [];
    const reader = cs.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(value);
    }
    let total = 0;
    for (const c of out) total += c.length;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of out) {
      merged.set(c, off);
      off += c.length;
    }
    return merged;
  }

  async function inflateRaw(input) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(input);
    writer.close();
    const out = [];
    const reader = ds.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(value);
    }
    let total = 0;
    for (const c of out) total += c.length;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of out) {
      merged.set(c, off);
      off += c.length;
    }
    return new TextDecoder().decode(merged);
  }

  async function encode(obj) {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    const deflated = await deflateRaw(bytes);
    return bytesToB64url(deflated);
  }

  async function decode(str) {
    const bytes = b64urlToBytes(str.trim());
    const json = await inflateRaw(bytes);
    return JSON.parse(json);
  }

  // ---- QR rendering (qrcode-generator, draw to canvas via isDark) ----

  function renderQR(canvas, text, cellPx = 6) {
    // typeNumber 0 = auto-detect smallest version; 'M' error correction.
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const margin = 2;
    const size = (count + margin * 2) * cellPx;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#111827';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect((c + margin) * cellPx, (r + margin) * cellPx, cellPx, cellPx);
        }
      }
    }
    return { size, count };
  }

  // ---- QR scanning (jsQR over <video>) ----
  let scanStream = null;
  let scanRaf = 0;
  let scanStop = false;

  async function startScan(video, onResult) {
    scanStop = false;
    // Secure-context gate: navigator.mediaDevices is undefined on http://LAN-IP
    // (not localhost, not https), so browsers disable the camera entirely.
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const isSecure = window.isSecureContext;
      throw new Error(
        isSecure
          ? '此浏览器/设备不支持摄像头扫码，请改用“粘贴码”。'
          : '当前为非安全上下文（http://局域网IP），浏览器已禁用摄像头。请改用“粘贴码”；或用 HTTPS / localhost 打开即可启用扫码。'
      );
    }
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    video.srcObject = scanStream;
    await video.play();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = () => {
      if (scanStop) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const w = (canvas.width = video.videoWidth);
        const h = (canvas.height = video.videoHeight);
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const res = jsQR(img.data, img.width, img.height, {
          inversionAttempts: 'dontInvert',
        });
        if (res && res.data) {
          onResult(res.data);
        }
      }
      scanRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopScan() {
    scanStop = true;
    if (scanRaf) cancelAnimationFrame(scanRaf);
    scanRaf = 0;
    if (scanStream) {
      scanStream.getTracks().forEach((t) => t.stop());
      scanStream = null;
    }
  }

  // Decode a QR from a static image (a photo taken on the phone). Works on plain
  // HTTP — no camera permission / secure context needed, since it just reads a
  // file the user picked. Returns the decoded payload string, or null on failure.
  function decodeImage(file) {
    return new Promise((resolve) => {
      if (typeof jsQR !== 'function') return resolve(null);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          // downscale very large photos a touch so getImageData stays affordable
          const MAX = 1600;
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;
          const scale = Math.min(1, MAX / Math.max(w, h));
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, w, h);
          const data = ctx.getImageData(0, 0, w, h);
          // attemptBoth: still photo is one-shot, accuracy over speed
          const res = jsQR(data.data, data.width, data.height, {
            inversionAttempts: 'attemptBoth',
          });
          resolve(res && res.data ? res.data : null);
        } catch {
          resolve(null);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  return { encode, decode, renderQR, startScan, stopScan, decodeImage };
})();

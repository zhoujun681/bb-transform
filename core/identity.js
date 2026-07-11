// identity.js — peer identity & display name
// Generates a stable random peerId (UUID) persisted in localStorage so a page
// refresh keeps the same identity. The WebRTC connections rebuild on reload,
// but mesh routing and the peers table stay consistent across refreshes.

const Identity = (() => {
  const STORE_ID = 'bbt.peerId';
  const STORE_NAME = 'bbt.name';

  function uuid() {
    // RFC4122 v4 without crypto.randomUUID() (works on file:// where
    // crypto.randomUUID may be gated; getRandomValues is universally available).
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h
      .slice(6, 8)
      .join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
  }

  let peerId = localStorage.getItem(STORE_ID);
  if (!peerId) {
    peerId = uuid();
    localStorage.setItem(STORE_ID, peerId);
  }

  let name = localStorage.getItem(STORE_NAME) || '';

  function setName(n) {
    name = (n || '').trim().slice(0, 24) || defaultName();
    localStorage.setItem(STORE_NAME, name);
    return name;
  }

  function defaultName() {
    // Friendly default derived from the peerId tail.
    return `设备-${peerId.slice(0, 4).toUpperCase()}`;
  }

  function displayName() {
    return name || defaultName();
  }

  return {
    id: () => peerId,
    name: () => name,
    displayName,
    setName,
    defaultName,
  };
})();

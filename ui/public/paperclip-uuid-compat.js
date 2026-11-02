// Paperclip LAN HTTP compatibility: UUID v4 from the existing CSPRNG.
(() => {
  const c = globalThis.crypto;
  if (!c || typeof c.randomUUID === "function" || typeof c.getRandomValues !== "function") return;
  Object.defineProperty(c, "randomUUID", {
    configurable: true,
    value() {
      const bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0"));
      return hex.slice(0,4).join("") + "-" + hex.slice(4,6).join("") + "-" + hex.slice(6,8).join("") + "-" + hex.slice(8,10).join("") + "-" + hex.slice(10).join("");
    }
  });
})();

// Shared by the background worker (via importScripts) and the content scripts.
globalThis.BB_CONFIG = {
  // Change this to your Railway URL after deploying the backend. Also make sure
  // it's covered by "host_permissions" in manifest.json.
  API_BASE: "https://broetry-blocker-production.up.railway.app",
  BATCH_SIZE: 10,
  // Posts shorter than this aren't worth a request (and rarely slop).
  MIN_CHARS: 80,
  MAX_CHARS: 3000,
  // Slop probability needed to flag a post, per sensitivity setting.
  THRESHOLDS: { relaxed: 0.85, normal: 0.7, strict: 0.5 },
  DEFAULT_SETTINGS: { enabled: true, mode: "label", sensitivity: "normal" },
};

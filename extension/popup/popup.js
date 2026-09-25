/* global BB_CONFIG */
const api = globalThis.browser ?? globalThis.chrome;
const t = (key, subs) => api.i18n.getMessage(key, subs) || key;

for (const node of document.querySelectorAll("[data-i18n]")) {
  node.textContent = t(node.dataset.i18n);
}
document.documentElement.lang = api.i18n.getUILanguage?.() ?? "en";

async function loadSettings() {
  const { settings } = await api.storage.local.get("settings");
  return { ...BB_CONFIG.DEFAULT_SETTINGS, ...settings };
}

async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await api.storage.local.set({ settings: next });
  applySettings(next);
}

function applySettings(settings) {
  document.getElementById("enabled").checked = settings.enabled;
  document.body.classList.toggle("disabled", !settings.enabled);
  for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === settings.mode;
  for (const input of document.querySelectorAll('input[name="sensitivity"]')) {
    input.checked = input.value === settings.sensitivity;
  }
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function renderStatus() {
  const status = await api.runtime.sendMessage({ type: "status" });
  document.getElementById("today").textContent = String(status.today ?? 0);
  document.getElementById("total").textContent = String(status.total ?? 0);
  const quota = document.getElementById("quota");
  if (status.limited) {
    const key = status.limited.reason === "service_busy" ? "serviceBusy" : "quotaExhausted";
    quota.textContent = t(key, [formatTime(status.limited.until)]);
    quota.classList.add("warn");
  } else if (status.quota) {
    quota.textContent = t("quotaRemaining", [String(status.quota.remaining), String(status.quota.limit)]);
  }
}

document.getElementById("enabled").addEventListener("change", (e) => saveSettings({ enabled: e.target.checked }));
for (const input of document.querySelectorAll('input[name="mode"]')) {
  input.addEventListener("change", () => saveSettings({ mode: input.value }));
}
for (const input of document.querySelectorAll('input[name="sensitivity"]')) {
  input.addEventListener("change", () => saveSettings({ sensitivity: input.value }));
}

loadSettings().then(applySettings);
renderStatus();
api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.stats || changes.quota || changes.limitedUntil)) renderStatus();
});

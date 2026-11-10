/*
 * Installable app plumbing shared by the staff and student pages:
 * - registers the service worker (static shell only, never API data)
 * - shows an "Install app" button when the browser offers one
 * - tells the user when they go offline, and hides the button once installed
 */
(function () {
  const style = document.createElement("style");
  style.textContent = `
    .pwa-install{display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:10px;
      border:1px solid rgba(17,22,63,.18);background:#11163f;color:#fff;font:inherit;font-size:14px;
      font-weight:600;cursor:pointer;text-decoration:none}
    .pwa-install[hidden]{display:none}
    .pwa-install:hover{background:#1c2470}
    .pwa-install svg{width:16px;height:16px;fill:currentColor}
    .pwa-offline{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:9999;
      background:#8a1c1c;color:#fff;padding:10px 16px;border-radius:999px;font:500 13px/1.2 system-ui,sans-serif;
      box-shadow:0 8px 24px rgba(0,0,0,.25)}
    .pwa-offline[hidden]{display:none}
  `;
  document.head.appendChild(style);

  // ---- install button ----
  let deferredPrompt = null;
  const buttons = () =>
    Array.from(document.querySelectorAll("[data-install], #installApp")).filter((b) => b);

  function syncButtons() {
    buttons().forEach((b) => {
      if (deferredPrompt) b.hidden = false;
      else if (!b.dataset.alwaysShow) b.hidden = true;
    });
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    // Keep the browser's mini-infobar away and offer the install in our own UI.
    event.preventDefault();
    deferredPrompt = event;
    syncButtons();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    syncButtons();
    document.dispatchEvent(new CustomEvent("attendsecure:installed"));
  });

  async function install() {
    if (!deferredPrompt) {
      // iOS Safari has no prompt API: explain the manual route instead of failing silently.
      alert(
        "To install on iPhone or iPad: open this page in Safari, tap Share, then choose “Add to Home Screen”.",
      );
      return;
    }
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice.catch(() => ({ outcome: "dismissed" }));
    if (choice && choice.outcome === "accepted") deferredPrompt = null;
    syncButtons();
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-install], #installApp");
    if (!button) return;
    event.preventDefault();
    install();
  });

  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.navigator.standalone === true;
  if (standalone) document.documentElement.dataset.standalone = "1";

  // ---- offline notice ----
  const banner = document.createElement("div");
  banner.className = "pwa-offline";
  banner.hidden = true;
  banner.textContent = "You are offline — attendance cannot be submitted until you reconnect.";
  document.body.appendChild(banner);
  const updateOnline = () => {
    banner.hidden = navigator.onLine;
  };
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();

  // ---- service worker ----
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
        console.warn("Service worker registration failed:", err && err.message);
      });
    });
  } else if ("serviceWorker" in navigator) {
    console.info("Service worker needs https:// (or localhost) to install the app.");
  }

  document.addEventListener("DOMContentLoaded", syncButtons);
  window.AttendSecurePWA = { install, get promptAvailable() { return Boolean(deferredPrompt); }, standalone };
})();

const icons = {
  app: "M5 5h14v14H5zM9 9h6v6H9z",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4",
  check: "m5 12 4 4L19 6",
  chevron: "m9 6 6 6-6 6",
  close: "M6 6l12 12M18 6 6 18",
  dashboard: "M4 4h6v6H4zm10 0h6v9h-6zM4 14h6v6H4zm10 3h6v3h-6z",
  grip: "M9 7h.01M15 7h.01M9 12h.01M15 12h.01M9 17h.01M15 17h.01",
  menu: "M4 7h16M4 12h16M4 17h16",
  moon: "M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  panel: "M4 4h16v16H4zM15 4v16",
  plus: "M12 5v14M5 12h14",
  search: "m20 20-4.3-4.3M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z",
  settings:
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19 13.5l2 1-2 3-2-1.1a8 8 0 0 1-2 1.2L14.8 20h-3.6l-.2-2.4a8 8 0 0 1-2-1.2L7 17.5l-2-3 2-1a8 8 0 0 1 0-3L5 9.5l2-3 2 1.1a8 8 0 0 1 2-1.2l.2-2.4h3.6l.2 2.4a8 8 0 0 1 2 1.2L19 6.5l2 3-2 1a8 8 0 0 1 0 3Z",
  sun: "M12 4V2m0 20v-2M4 12H2m20 0h-2m-2.3-5.7 1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2-1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  todo: "M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01",
};

function icon(name) {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${icons[name]}"/></svg>`;
}

document.querySelectorAll("[data-icon]").forEach((element) => {
  const name = element.dataset.icon;
  if (icons[name]) element.innerHTML = icon(name);
});

const root = document.documentElement;
const toast = document.querySelector(".toast");
let toastTimer;

function setTheme(theme, persist = true) {
  root.dataset.theme = theme;
  const toggle = document.querySelector("[data-theme-toggle]");
  if (toggle) {
    const next = theme === "dark" ? "light" : "dark";
    toggle.setAttribute("aria-label", `Switch to ${next} theme`);
    toggle.setAttribute("title", `Switch to ${next} theme`);
    toggle.innerHTML = icon(theme === "dark" ? "sun" : "moon");
  }
  if (persist) localStorage.setItem("archcode-prototype-theme", theme);
}

setTheme(localStorage.getItem("archcode-prototype-theme") || root.dataset.theme || "dark", false);

document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
  setTheme(root.dataset.theme === "dark" ? "light" : "dark");
});

function showToast(message) {
  if (!toast) return;
  toast.textContent = `${message} · 原型演示`;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2200);
}

document.querySelectorAll("[data-action]").forEach((element) => {
  element.addEventListener("click", () => showToast(element.dataset.action));
});

const sidebar = document.querySelector(".project-sidebar");

function closeOverlays() {
  document.body.classList.remove("sidebar-open");
}

document.querySelectorAll("[data-open-sidebar]").forEach((button) => {
  button.addEventListener("click", () => {
    if (window.matchMedia("(min-width: 761px)").matches) {
      const collapsed = document.body.classList.toggle("sidebar-collapsed");
      button.setAttribute("aria-expanded", String(!collapsed));
      return;
    }
    closeOverlays();
    document.body.classList.add("sidebar-open");
  });
});

document.querySelectorAll("[data-close-overlay]").forEach((button) => {
  button.addEventListener("click", closeOverlays);
});

document.querySelector(".scrim")?.addEventListener("click", closeOverlays);

document.querySelectorAll("[data-sidebar-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.dataset.sidebarTab;
    document.querySelectorAll("[data-sidebar-tab]").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab === button));
    });
    document.querySelectorAll("[data-sidebar-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.sidebarPanel !== target;
    });
  });
});

const resizeConfigs = [
  {
    handle: document.querySelector("[data-resize-sidebar]"),
    variable: "--sidebar-width",
    key: "archcode-prototype-sidebar-width",
    min: 210,
    max: 340,
    fallback: 264,
    direction: 1,
  },
];

function applyWidth(config, value, persist = true) {
  const next = Math.round(Math.max(config.min, Math.min(config.max, value)));
  root.style.setProperty(config.variable, `${next}px`);
  config.handle?.setAttribute("aria-valuenow", String(next));
  if (persist) localStorage.setItem(config.key, String(next));
}

resizeConfigs.forEach((config) => {
  if (!config.handle) return;
  const stored = Number(localStorage.getItem(config.key));
  applyWidth(config, Number.isFinite(stored) && stored > 0 ? stored : config.fallback, false);

  config.handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startWidth = Number(config.handle.getAttribute("aria-valuenow"));
    config.handle.classList.add("dragging");
    config.handle.setPointerCapture(event.pointerId);

    const move = (moveEvent) => {
      applyWidth(config, startWidth + (moveEvent.clientX - startX) * config.direction, false);
    };
    const finish = (upEvent) => {
      applyWidth(config, Number(config.handle.getAttribute("aria-valuenow")));
      config.handle.classList.remove("dragging");
      config.handle.releasePointerCapture(upEvent.pointerId);
      config.handle.removeEventListener("pointermove", move);
      config.handle.removeEventListener("pointerup", finish);
      config.handle.removeEventListener("pointercancel", finish);
    };
    config.handle.addEventListener("pointermove", move);
    config.handle.addEventListener("pointerup", finish);
    config.handle.addEventListener("pointercancel", finish);
  });

  config.handle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 12 : -12;
    applyWidth(
      config,
      Number(config.handle.getAttribute("aria-valuenow")) + delta * config.direction,
    );
  });
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeOverlays();
});

void sidebar;

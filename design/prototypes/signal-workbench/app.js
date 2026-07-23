// ArchCode Signal Workbench design prototype interactions.
const iconPaths = {
  arrow: "M5 12h14m-6-6 6 6-6 6",
  automation: "M4 7h11m0 0-3-3m3 3-3 3M20 17H9m0 0 3-3m-3 3 3 3",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4",
  changes: "M7 4v11m0 0-3-3m3 3 3-3M17 20V9m0 0-3 3m3-3 3 3",
  check: "m5 12 4 4L19 6",
  chevron: "m8 10 4 4 4-4",
  "chevron-right": "m9 6 6 6-6 6",
  close: "M6 6l12 12M18 6 6 18",
  collapse: "M4 5h16v14H4zM9 5v14m7-10-3 3 3 3",
  dashboard: "M4 4h6v6H4zm10 0h6v9h-6zM4 14h6v6H4zm10 3h6v3h-6z",
  delegate: "M5 5h6v6H5zm8 8h6v6h-6zm-2-5h4v5",
  edit: "m4 20 4.5-1 10-10-3.5-3.5-10 10zM13.5 7 17 10.5",
  expand: "M4 5h16v14H4zM9 5v14m4 4 3-3-3-3",
  file: "M6 3h8l4 4v14H6zM14 3v5h5",
  focus: "M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5",
  menu: "M4 7h16M4 12h16M4 17h16",
  moon: "M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z",
  panel: "M4 4h16v16H4zM15 4v16",
  plus: "M12 5v14M5 12h14",
  review: "M12 3 5 6v5c0 4.6 2.9 8.3 7 10 4.1-1.7 7-5.4 7-10V6zM9 12l2 2 4-5",
  search: "m20 20-4.3-4.3M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19 13.5l2 1-2 3-2-1.1a8 8 0 0 1-2 1.2L14.8 20h-3.6l-.2-2.4a8 8 0 0 1-2-1.2L7 17.5l-2-3 2-1a8 8 0 0 1 0-3L5 9.5l2-3 2 1.1a8 8 0 0 1 2-1.2l.2-2.4h3.6l.2 2.4a8 8 0 0 1 2 1.2L19 6.5l2 3-2 1a8 8 0 0 1 0 3Z",
  stop: "M7 7h10v10H7z",
  sun: "M12 4V2m0 20v-2M4 12H2m20 0h-2m-2.3-5.7 1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2-1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  terminal: "m5 7 5 5-5 5m8 0h6",
  todo: "M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01",
};

function icon(name) {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${iconPaths[name]}"/></svg>`;
}

document.querySelectorAll("[data-icon]").forEach((element) => {
  const iconName = element.dataset.icon;
  if (iconPaths[iconName]) {
    element.insertAdjacentHTML("afterbegin", icon(iconName));
  }
});

const documentElement = document.documentElement;
const toast = document.querySelector(".toast");
const inspector = document.querySelector("#changes-inspector");
const sidebar = document.querySelector("#thread-sidebar");
const workCanvas = document.querySelector("#work-canvas");
const todosView = document.querySelector("[data-canvas-view='todos']");
const focusModeButton = document.querySelector("[data-focus-mode]");
let toastTimer;

const layoutDimensions = {
  sidebar: {
    variable: "--sidebar-width",
    storageKey: "signal-workbench-sidebar-width",
    min: 210,
    max: 340,
    fallback: 248,
    direction: 1,
    handle: document.querySelector("[data-resize-sidebar]"),
  },
  inspector: {
    variable: "--inspector-width",
    storageKey: "signal-workbench-inspector-width",
    min: 280,
    max: 460,
    fallback: 330,
    direction: -1,
    handle: document.querySelector("[data-resize-inspector]"),
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readStoredWidth(config) {
  try {
    const stored = Number(window.localStorage.getItem(config.storageKey));
    return Number.isFinite(stored) && stored > 0 ? stored : config.fallback;
  } catch {
    return config.fallback;
  }
}

function setLayoutWidth(config, value, persist = true) {
  const next = Math.round(clamp(value, config.min, config.max));
  document.documentElement.style.setProperty(config.variable, `${next}px`);
  config.handle.setAttribute("aria-valuenow", String(next));
  config.handle.setAttribute("aria-valuetext", `${next} pixels`);
  if (persist) {
    try {
      window.localStorage.setItem(config.storageKey, String(next));
    } catch {
      // Persistence is optional when the prototype is opened from a restricted origin.
    }
  }
  return next;
}

function bindLayoutResize(config) {
  setLayoutWidth(config, readStoredWidth(config), false);

  config.handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = Number(config.handle.getAttribute("aria-valuenow"));
    config.handle.classList.add("dragging");

    const onMove = (moveEvent) => {
      const delta = (moveEvent.clientX - startX) * config.direction;
      setLayoutWidth(config, startWidth + delta, false);
    };
    const onEnd = () => {
      const finalWidth = Number(config.handle.getAttribute("aria-valuenow"));
      setLayoutWidth(config, finalWidth, true);
      config.handle.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  });

  config.handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = Number(config.handle.getAttribute("aria-valuenow"));
    const movement = event.key === "ArrowRight" ? 12 : -12;
    setLayoutWidth(config, current + movement * config.direction);
  });
}

Object.values(layoutDimensions).forEach(bindLayoutResize);

function showToast(message) {
  toast.textContent = `${message} · 原型演示`;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2400);
}

function setTheme(theme) {
  documentElement.dataset.theme = theme;
  const toggle = document.querySelector("[data-theme-toggle]");
  const nextTheme = theme === "light" ? "dark" : "light";
  toggle.setAttribute("aria-label", `Switch to ${nextTheme} theme`);
  toggle.setAttribute("title", `Switch to ${nextTheme} theme`);
  toggle.innerHTML = icon(theme === "light" ? "moon" : "sun");
}

function closeOverlays() {
  inspector.classList.remove("open");
  sidebar.classList.remove("open");
  document.body.classList.remove("inspector-open", "sidebar-open");
}

function closeTodoDetail() {
  todosView.classList.remove("detail-open");
  document.querySelectorAll("[data-todo-card]").forEach((card) => card.classList.remove("selected"));
}

function setFocusMode(active) {
  document.body.classList.toggle("focus-mode", active);
  focusModeButton.setAttribute("aria-pressed", String(active));
  focusModeButton.setAttribute("aria-label", active ? "Exit focus mode" : "Enter focus mode");
}

function showCanvas(view) {
  document.querySelectorAll("[data-canvas-view]").forEach((canvasView) => {
    const active = canvasView.dataset.canvasView === view;
    canvasView.hidden = !active;
    canvasView.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-canvas-target]").forEach((button) => {
    button.classList.toggle("active", button.dataset.canvasTarget === view);
  });
  document.body.classList.toggle("non-session-view", view !== "session");
  closeOverlays();
  closeTodoDetail();
  workCanvas.focus({ preventScroll: true });
}

document.querySelector("[data-theme-toggle]").addEventListener("click", () => {
  setTheme(documentElement.dataset.theme === "light" ? "dark" : "light");
});

document.querySelector("[data-open-inspector]").addEventListener("click", () => {
  if (window.matchMedia("(min-width: 1181px)").matches) {
    if (document.body.classList.contains("focus-mode")) {
      setFocusMode(false);
      document.body.classList.remove("inspector-collapsed");
      document.querySelector("[data-open-inspector]").setAttribute("aria-expanded", "true");
      return;
    }
    const collapsed = document.body.classList.toggle("inspector-collapsed");
    document.querySelector("[data-open-inspector]").setAttribute("aria-expanded", String(!collapsed));
    return;
  }
  inspector.classList.add("open");
  document.body.classList.add("inspector-open");
});

document.querySelector("[data-close-inspector]").addEventListener("click", closeOverlays);
document.querySelectorAll("[data-open-sidebar]").forEach((button) => {
  button.addEventListener("click", () => {
    sidebar.classList.add("open");
    document.body.classList.add("sidebar-open");
  });
});
document.querySelector("[data-close-sidebar]").addEventListener("click", closeOverlays);
document.querySelector("[data-close-overlays]").addEventListener("click", closeOverlays);
document.querySelector("[data-collapse-sidebar]").addEventListener("click", () => {
  document.body.classList.toggle("sidebar-collapsed");
});
focusModeButton.addEventListener("click", () => {
  const active = !document.body.classList.contains("focus-mode");
  setFocusMode(active);
  closeOverlays();
  showToast(active ? "已进入专注模式" : "已退出专注模式");
});
document.querySelectorAll("[data-expand-sidebar]").forEach((button) => {
  button.addEventListener("click", () => {
    if (document.body.classList.contains("focus-mode")) {
      setFocusMode(false);
      return;
    }
    document.body.classList.remove("sidebar-collapsed");
  });
});

document.querySelectorAll("[data-canvas-target]").forEach((button) => {
  button.addEventListener("click", () => {
    showCanvas(button.dataset.canvasTarget);
  });
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => showToast(button.dataset.action));
});

document.querySelectorAll("[data-thread]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-thread]").forEach((thread) => thread.classList.remove("active"));
    button.classList.add("active");
    showCanvas("session");
    showToast(`切换到 ${button.querySelector("strong").textContent}`);
  });
});

document.querySelectorAll("[data-thread-jump]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = document.querySelector(`[data-thread="${button.dataset.threadJump}"]`);
    document.querySelectorAll("[data-thread]").forEach((thread) => thread.classList.remove("active"));
    target?.classList.add("active");
    showCanvas("session");
    showToast(`切换到 ${target?.querySelector("strong")?.textContent ?? "Session"}`);
  });
});

document.querySelectorAll("[data-file]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-file]").forEach((file) => file.classList.remove("active"));
    button.classList.add("active");
    const name = button.querySelector("strong").textContent;
    showToast(`在主画布打开 ${name} 的 Diff`);
  });
});

function bindTabs(tabSelector, panelSelector, tabKey, panelKey) {
  document.querySelectorAll(tabSelector).forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(tabSelector).forEach((tab) => tab.setAttribute("aria-selected", "false"));
      document.querySelectorAll(panelSelector).forEach((panel) => {
        panel.hidden = panel.dataset[panelKey] !== button.dataset[tabKey];
        panel.classList.toggle("active", !panel.hidden);
      });
      button.setAttribute("aria-selected", "true");
    });
  });
}

bindTabs("[data-sidebar-tab]", "[data-sidebar-panel]", "sidebarTab", "sidebarPanel");
bindTabs("[data-inspector-tab]", "[data-inspector-panel]", "inspectorTab", "inspectorPanel");

document.querySelector("[data-execution-toggle]").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  document.querySelector("[data-execution-body]").hidden = expanded;
});

document.querySelectorAll("[data-tool-group-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    button.closest(".tool-group-card").querySelector("[data-tool-group-children]").hidden = expanded;
  });
});

document.querySelectorAll("[data-tool-child-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    button.closest(".tool-child").querySelector(".tool-child-detail").hidden = expanded;
  });
});

document.querySelectorAll("[data-tool-call-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    button.closest(".tool-call-card").querySelector("[data-tool-call-detail]").hidden = expanded;
  });
});

document.querySelector("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#follow-up");
  showToast(input.value.trim() ? "消息已加入队列" : "输入一条消息后加入队列");
  if (input.value.trim()) input.value = "";
});

const todoDetails = {
  "visual-qa": {
    title: "Visual QA for the workbench",
    state: "Idea · Discussion waiting for you",
    objective: "Define the visual acceptance surface before handing implementation to a new Lead Session.",
    link: "Discussion Session · waiting for your response",
    primary: "Continue Discussion",
    secondary: ["Edit", "Mark Ready", "Reject", "Archive"],
  },
  "output-boundary": {
    title: "Finalize tool output boundary",
    state: "Ready · no linked work yet",
    objective: "Complete the remaining implementation and verify that raw output is finalized exactly once.",
    link: "No linked work yet",
    primary: "Start Session",
    secondary: ["Edit", "Discuss", "Create Automation", "Move to Idea", "Reject", "Mark Done", "Archive"],
  },
  runtime: {
    title: "Move runtime authority",
    state: "In Progress · Session running",
    objective: "Move project-owned runtime state into one protected authority subtree with no dual reads.",
    link: "Runtime authority migration · Lead · running 14:32",
    primary: "Open Session",
    secondary: ["Edit", "Discuss", "Return to Ready", "Mark Done"],
  },
  regression: {
    title: "Nightly regression review",
    state: "In Progress · Automation active",
    objective: "Run a scheduled review over newly changed paths and surface only actionable regressions.",
    link: "Nightly regression review · next run tomorrow at 02:00",
    primary: "Open Automation",
    secondary: ["Edit", "Discuss", "Return to Ready", "Mark Done"],
  },
  model: {
    title: "Model runtime snapshots",
    state: "Done · completed Tuesday",
    objective: "Make resolved model identity immutable for each execution and preserve the audit trail.",
    link: "Completed Session · no active execution",
    primary: "Reopen",
    secondary: ["Edit", "Archive"],
  },
  "legacy-aliases": {
    title: "Keep compatibility aliases for runtime paths",
    state: "Rejected · reason preserved",
    objective: "Retain legacy runtime paths alongside the new authority tree.",
    link: "Discussion Session · completed",
    primary: "Restore to Idea",
    secondary: ["Edit", "Discuss", "Archive"],
  },
  "dashboard-metrics": {
    title: "Add velocity metrics to Project Dashboard",
    state: "Rejected · reason preserved",
    objective: "Add task throughput and activity counters to the project overview.",
    link: "No linked work",
    primary: "Restore to Idea",
    secondary: ["Edit", "Discuss", "Archive"],
  },
  "old-provider-audit": {
    title: "Audit retired provider configuration",
    state: "Archived · formerly Done",
    objective: "Review the configuration surface removed by the provider hard cut.",
    link: "Completed Session · June 18",
    primary: "Restore",
    secondary: ["Edit"],
  },
  "memory-notes": {
    title: "Collect memory extraction notes",
    state: "Archived · formerly Done",
    objective: "Consolidate implementation notes from the memory extraction work.",
    link: "Completed Session · May 29",
    primary: "Restore",
    secondary: ["Edit"],
  },
};

function openTodoDetail(card) {
  const detail = todoDetails[card.dataset.todoCard];
  if (!detail) return;
  document.querySelectorAll("[data-todo-card]").forEach((item) => item.classList.toggle("selected", item === card));
  document.querySelector("[data-todo-detail-title]").textContent = detail.title;
  document.querySelector("[data-todo-detail-state]").textContent = detail.state;
  document.querySelector("[data-todo-detail-objective]").textContent = detail.objective;
  document.querySelector("[data-todo-detail-link]").textContent = detail.link;
  const primary = document.querySelector("[data-todo-detail-primary]");
  primary.textContent = detail.primary;
  const secondary = document.querySelector("[data-todo-detail-secondary]");
  secondary.replaceChildren();
  detail.secondary.forEach((label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button";
    button.textContent = label;
    button.addEventListener("click", () => showToast(label));
    secondary.appendChild(button);
  });
  todosView.classList.add("detail-open");
}

document.querySelectorAll("[data-todo-view]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-todo-view]").forEach((tab) => {
      tab.setAttribute("aria-pressed", String(tab === button));
    });
    document.querySelectorAll("[data-todo-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.todoPanel !== button.dataset.todoView;
      panel.classList.toggle("active", !panel.hidden);
    });
    closeTodoDetail();
  });
});

document.querySelectorAll("[data-todo-card]").forEach((card) => {
  card.addEventListener("click", () => openTodoDetail(card));
});

document.querySelectorAll("[data-close-todo-detail]").forEach((button) => {
  button.addEventListener("click", closeTodoDetail);
});

document.querySelector("[data-todo-detail-primary]").addEventListener("click", (event) => {
  showToast(event.currentTarget.textContent);
});

document.querySelector("#todo-capture").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#new-todo-title");
  showToast(input.value.trim() ? "已创建 Todo" : "输入 Todo 标题后创建");
  if (input.value.trim()) input.value = "";
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeTodoDetail();
    closeOverlays();
  }
});

setTheme("light");

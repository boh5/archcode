const icons = {
  app: "M5 5h14v14H5zM9 9h6v6H9z",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4",
  check: "m5 12 4 4L19 6",
  chevron: "m9 6 6 6-6 6",
  close: "M6 6l12 12M18 6 6 18",
  dashboard: "M4 4h6v6H4zm10 0h6v9h-6zM4 14h6v6H4zm10 3h6v3h-6z",
  filter: "M4 6h16M7 12h10M10 18h4",
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

const baseWorkSearchItems = [
  {
    group: "Needs you",
    workKey: "todo-profile-defaults",
    type: "Session",
    tone: "attention",
    state: "Permission",
    title: "Implementation Session",
    meta: "Todo · Model profile defaults per project",
    href: "./session.html?todo=todo-profile-defaults&session=sess-profile-implementation",
  },
  {
    group: "Needs you",
    workKey: "todo-worktree-permission",
    type: "Todo",
    tone: "attention",
    state: "Needs you",
    title: "Review worktree deletion permission",
    meta: "In Progress · 1 bound Session",
    href: "./todos.html#todo=todo-worktree-permission",
  },
  {
    group: "Needs you",
    workKey: "automation-aut-health",
    type: "Automation",
    tone: "attention",
    state: "Failed run",
    title: "Daily project health check",
    meta: "Automation · latest run needs a decision",
    href: "./session.html?automation=aut-health&session=sess-aut-health-failed&title=Daily%20project%20health%20check",
  },
  {
    group: "Running",
    workKey: "todo-live-recovery",
    type: "Session",
    tone: "running",
    state: "Running",
    title: "Live execution recovery",
    meta: "Todo · Live execution recovery · 12m",
    href: "./session.html?todo=todo-live-recovery&session=sess-live-recovery",
  },
  {
    group: "Ready to review",
    workKey: "todo-work-search",
    type: "Todo",
    tone: "review",
    state: "Review",
    title: "Unify project work search",
    meta: "In Progress · Lead + Build · result ready",
    href: "./todos.html#todo=todo-work-search",
  },
  {
    group: "Ready to review",
    workKey: "todo-work-search",
    defaultVisible: false,
    type: "Session",
    tone: "review",
    state: "Done",
    title: "Project work search review",
    meta: "Todo · Unify project work search",
    href: "./session.html?todo=todo-work-search&session=sess-work-search-review",
  },
  {
    group: "Recent",
    workKey: "automation-aut-regression",
    type: "Automation",
    tone: "",
    state: "Scheduled",
    title: "Regression check",
    meta: "Weekdays at 09:00 · latest run passed",
    href: "./automations.html?automation=aut-regression",
  },
  {
    group: "Recent",
    workKey: "session-profile-review",
    type: "Session",
    tone: "done",
    state: "Done",
    title: "Review Session",
    meta: "Todo · Model profile defaults per project",
    href: "./session.html?todo=todo-profile-defaults&session=sess-profile-review",
  },
  {
    group: "Recent",
    workKey: "session-direct-context-audit",
    type: "Session",
    tone: "",
    state: "Done",
    title: "Audit project context loading",
    meta: "Direct · Lead · completed",
    href: "./session.html?session=sess-legacy-context-audit",
  },
  {
    group: "Recent",
    workKey: "todo-context-presets",
    type: "Todo",
    tone: "",
    state: "Idea",
    title: "Add per-project context presets",
    meta: "Captured for later · no execution",
    href: "./todos.html#todo=todo-context-presets",
  },
];

function icon(name) {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${icons[name]}"/></svg>`;
}

window.archcodePrototypeIcon = icon;

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

window.showToast = showToast;

function readPrototypeSessions() {
  try {
    const value = JSON.parse(localStorage.getItem("archcode-prototype-sessions") || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

window.readArchcodePrototypeSessions = readPrototypeSessions;

function escapePrototypeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

try {
  const storedTodos = JSON.parse(localStorage.getItem("archcode-prototype-created-todos") || "[]");
  const todoToolbarCount = document.querySelector('.project-toolbar-nav a[href="./todos.html"] .toolbar-count');
  if (todoToolbarCount && Array.isArray(storedTodos)) todoToolbarCount.textContent = String(6 + storedTodos.length);
} catch {
  // Keep the static prototype count when local demo state is unreadable.
}

function readPrototypeTodos() {
  try {
    const value = JSON.parse(localStorage.getItem("archcode-prototype-created-todos") || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function projectWorkSearchItems() {
  return [
    ...readPrototypeSessions().map((item) => {
      const href = item.href || `./session.html?session=${encodeURIComponent(item.sessionId)}`;
      const source = item.source || (item.automationId || href.includes("automation=") ? "Automation" : item.todoId || href.includes("todo=") ? "Todo" : "Direct");
      const sourceMeta = source === "Direct" ? "Direct · Lead" : source === "Automation" ? "Automation · Invocation" : "Todo · Started with Run now";
      return {
        group: item.group || "Running",
        workKey: item.workKey || item.todoId || item.automationId || item.sessionId,
        type: "Session",
        tone: item.tone || "running",
        state: item.state || "Running",
        title: item.title || item.sessionId,
        meta: item.meta || sourceMeta,
        href,
      };
    }),
    ...readPrototypeTodos().map((item) => ({
      group: item.lane === "in_progress" ? "Running" : "Recent",
      workKey: item.id,
      type: "Todo",
      tone: item.lane === "in_progress" ? "running" : "",
      state: item.lane === "in_progress" ? "In Progress" : "Idea",
      title: item.title,
      meta: item.lane === "in_progress" ? "Lead · started with Run now" : "Captured for later · no execution",
      href: `./todos.html#todo=${encodeURIComponent(item.id)}`,
    })),
    ...baseWorkSearchItems,
  ];
}

const globalProjectSearchItems = [
  {
    group: "Projects",
    workKey: "project-archcode",
    type: "Project",
    tone: "running",
    state: "Current",
    title: "archcode",
    meta: "/workspace/archcode",
    href: "./todos.html",
  },
  {
    group: "Projects",
    workKey: "project-archcode-readme-demo",
    type: "Project",
    tone: "",
    state: "Recent",
    title: "archcode-readme-demo-workspace",
    meta: "Recently opened project",
    demoAction: "Open archcode-readme-demo-workspace",
  },
  {
    group: "Projects",
    workKey: "project-specra-test",
    type: "Project",
    tone: "",
    state: "Recent",
    title: "specra-test-projects",
    meta: "Recently opened project",
    demoAction: "Open specra-test-projects",
  },
];

function globalWorkSearchItems() {
  return [
    ...globalProjectSearchItems,
    ...projectWorkSearchItems().map((item) => ({
      ...item,
      group: "archcode",
      meta: `archcode · ${item.meta}`,
    })),
  ];
}

function createSearchDialog({ triggerSelector, scope, title, description, placeholder, shortcut, items, groupOrder, emptyHint }) {
  const triggers = [...document.querySelectorAll(triggerSelector)];
  if (!triggers.length) return null;

  const finder = document.createElement("dialog");
  const titleId = `${scope}-search-title`;
  finder.className = "session-finder";
  finder.setAttribute("aria-labelledby", titleId);
  finder.innerHTML = `
    <div class="session-finder-shell">
      <header class="session-finder-header">
        <div><strong id="${titleId}">${escapePrototypeHtml(title)}</strong><span>${escapePrototypeHtml(description)}</span></div>
        <button class="icon-button" type="button" aria-label="Close ${escapePrototypeHtml(title)}" data-close-search>${icon("close")}</button>
      </header>
      <label class="session-finder-search">
        ${icon("search")}
        <input type="search" aria-label="${escapePrototypeHtml(title)}" placeholder="${escapePrototypeHtml(placeholder)}" autocomplete="off" data-search-input />
        <kbd>${escapePrototypeHtml(shortcut)}</kbd>
      </label>
      <div class="session-finder-results" data-search-results></div>
    </div>`;
  document.body.append(finder);

  const input = finder.querySelector("[data-search-input]");
  const results = finder.querySelector("[data-search-results]");
  let restoreFocus = null;

  function rowMarkup(item) {
    const content = `
      <span class="session-finder-orbit ${escapePrototypeHtml(item.tone || "")}"></span>
      <span class="session-finder-copy"><span class="session-finder-type">${escapePrototypeHtml(item.type)}</span><strong>${escapePrototypeHtml(item.title)}</strong><small>${escapePrototypeHtml(item.meta)}</small></span>
      <span class="session-finder-state ${escapePrototypeHtml(item.tone || "")}">${escapePrototypeHtml(item.state)}</span>`;
    if (item.href) return `<a class="session-finder-row" href="${escapePrototypeHtml(item.href)}">${content}</a>`;
    return `<button class="session-finder-row" type="button" data-search-demo-action="${escapePrototypeHtml(item.demoAction || item.title)}">${content}</button>`;
  }

  function render(query = "") {
    const normalized = query.trim().toLowerCase();
    const matches = items().filter((item) => (
      normalized
        ? `${item.group} ${item.type} ${item.title} ${item.meta} ${item.state} ${item.href || ""}`.toLowerCase().includes(normalized)
        : item.defaultVisible !== false
    ));
    const visibleMatches = normalized ? matches : matches.filter((item, index) => (
      matches.findIndex((candidate) => candidate.workKey === item.workKey) === index
    ));
    const orderedGroups = [...groupOrder, ...new Set(visibleMatches.map((item) => item.group).filter((group) => !groupOrder.includes(group)))];
    const markup = orderedGroups.map((group) => {
      const groupItems = visibleMatches.filter((item) => item.group === group);
      if (!groupItems.length) return "";
      return `<section class="session-finder-group"><h2>${escapePrototypeHtml(group)}</h2>${groupItems.map(rowMarkup).join("")}</section>`;
    }).join("");
    results.innerHTML = markup || `<p class="session-finder-empty"><strong>No results match “${escapePrototypeHtml(query)}”.</strong><span>${escapePrototypeHtml(emptyHint)}</span></p>`;
  }

  function open(trigger = triggers[0]) {
    restoreFocus = trigger;
    input.value = "";
    render();
    finder.showModal();
    requestAnimationFrame(() => input.focus());
  }

  function close({ restore = true } = {}) {
    if (!finder.open) return;
    finder.close();
    if (restore) requestAnimationFrame(() => restoreFocus?.focus());
  }

  triggers.forEach((trigger) => trigger.addEventListener("click", () => open(trigger)));
  finder.querySelector("[data-close-search]").addEventListener("click", () => close());
  finder.addEventListener("click", (event) => {
    if (event.target === finder) close();
    const demoResult = event.target.closest("[data-search-demo-action]");
    if (demoResult) {
      showToast(demoResult.dataset.searchDemoAction);
      close();
    }
  });
  finder.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  input.addEventListener("input", () => render(input.value));

  return { finder, open, close };
}

const currentProjectName = document.querySelector(".project-identity-copy h1")?.textContent.trim() || "project";
const globalSearch = createSearchDialog({
  triggerSelector: "[data-open-global-search]",
  scope: "global",
  title: "Search all work",
  description: "Find projects and work across every workspace.",
  placeholder: "Search projects, Todos, Sessions, Automations, or IDs",
  shortcut: "⌘K",
  items: globalWorkSearchItems,
  groupOrder: ["Projects", currentProjectName],
  emptyHint: "Try a project, Todo label, Session ID, or Automation name.",
});

window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (globalSearch?.finder.open) globalSearch.close();
    else globalSearch?.open();
  }
});

const attentionItems = [
  {
    type: "Session",
    title: "Implementation Session",
    meta: "Permission · Model profile defaults per project",
    state: "Permission",
    href: "./session.html?todo=todo-profile-defaults&session=sess-profile-implementation",
  },
  {
    type: "Todo",
    title: "Review worktree deletion permission",
    meta: "Lead is waiting on one scoped decision",
    state: "Decision",
    href: "./todos.html#todo=todo-worktree-permission",
  },
  {
    type: "Automation",
    title: "Daily project health check",
    meta: "Latest run stopped before the final report",
    state: "Failed run",
    href: "./session.html?automation=aut-health&session=sess-aut-health-failed&title=Daily%20project%20health%20check",
  },
];

function createAttentionInbox() {
  const triggers = [...document.querySelectorAll("[data-open-attention]")];
  if (!triggers.length) return;

  const inbox = document.createElement("dialog");
  inbox.className = "attention-inbox";
  inbox.setAttribute("aria-labelledby", "attention-inbox-title");
  inbox.innerHTML = `
    <header class="attention-inbox-header">
      <div><strong id="attention-inbox-title">Needs you</strong><span>Decisions blocking Agent work.</span></div>
      <button class="icon-button" type="button" aria-label="Close Needs you" data-close-attention>${icon("close")}</button>
    </header>
    <div class="attention-inbox-list">
      ${attentionItems.map((item) => `
        <a class="session-finder-row" href="${escapePrototypeHtml(item.href)}">
          <span class="session-finder-orbit attention"></span>
          <span class="session-finder-copy"><span class="session-finder-type">${escapePrototypeHtml(item.type)}</span><strong>${escapePrototypeHtml(item.title)}</strong><small>${escapePrototypeHtml(item.meta)}</small></span>
          <span class="session-finder-state attention">${escapePrototypeHtml(item.state)}</span>
        </a>`).join("")}
    </div>`;
  document.body.append(inbox);

  let restoreFocus = null;
  function close() {
    inbox.close();
    requestAnimationFrame(() => restoreFocus?.focus());
  }

  triggers.forEach((trigger) => trigger.addEventListener("click", () => {
    restoreFocus = trigger;
    inbox.showModal();
    requestAnimationFrame(() => inbox.querySelector("a")?.focus());
  }));
  inbox.querySelector("[data-close-attention]").addEventListener("click", close);
  inbox.addEventListener("click", (event) => {
    if (event.target === inbox) close();
  });
  inbox.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
}

createAttentionInbox();

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

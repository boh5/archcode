const icons = {
  app: "M5 5h14v14H5zM9 9h6v6H9z",
  "arrow-up": "M12 19V5M5 12l7-7 7 7",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4",
  board: "M4 5h4v14H4zM10 5h4v14h-4zM16 5h4v14h-4z",
  check: "m5 12 4 4L19 6",
  chevron: "m9 6 6 6-6 6",
  "circle-check": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-12 0 2 2 4-4",
  "circle-dot": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-6 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  "circle-play": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-11-4 6 4-6 4Z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 3",
  close: "M6 6l12 12M18 6 6 18",
  // Lucide corner-down-right — standard “inject / reply into flow” glyph for Steer
  "corner-down-right": "M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12",
  dashboard: "M4 4h6v6H4zm10 0h6v9h-6zM4 14h6v6H4zm10 3h6v3h-6z",
  edit: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  "file-plus": "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 18v-6M9 15h6",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  filter: "M4 6h16M7 12h10M10 18h4",
  grip: "M9 7h.01M15 7h.01M9 12h.01M15 12h.01M9 17h.01M15 17h.01",
  hammer: "m15 12-8.5 8.5-3-3L12 9m2-6 7 7-4 4-7-7 4-4Z",
  layers: "m12 2 9 5-9 5-9-5 9-5Zm-9 10 9 5 9-5M3 17l9 5 9-5",
  lightbulb: "M9 18h6M10 22h4M8.2 14.6A7 7 0 1 1 15.8 14.6C15.2 15.1 15 15.7 15 16H9c0-.3-.2-.9-.8-1.4Z",
  menu: "M4 7h16M4 12h16M4 17h16",
  moon: "M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  panel: "M4 4h16v16H4zM15 4v16",
  plus: "M12 5v14M5 12h14",
  search: "m20 20-4.3-4.3M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z",
  save: "M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM17 21v-8H7v8M7 3v5h8",
  scan: "M3 3v5M3 3h5M21 3h-5M21 3v5M3 21v-5M3 21h5M21 21h-5M21 21v-5M8 15l3-3 2 2 4-5",
  settings:
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19 13.5l2 1-2 3-2-1.1a8 8 0 0 1-2 1.2L14.8 20h-3.6l-.2-2.4a8 8 0 0 1-2-1.2L7 17.5l-2-3 2-1a8 8 0 0 1 0-3L5 9.5l2-3 2 1.1a8 8 0 0 1 2-1.2l.2-2.4h3.6l.2 2.4a8 8 0 0 1 2 1.2L19 6.5l2 3-2 1a8 8 0 0 1 0 3Z",
  square: "M6 6h12v12H6z",
  sun: "M12 4V2m0 20v-2M4 12H2m20 0h-2m-2.3-5.7 1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2-1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  sparkles: "m12 3-1.1 3.1L8 7.2l2.9 1.1L12 11l1.1-2.7L16 7.2l-2.9-1.1L12 3Zm6 9-.7 2-1.8.7 1.8.7.7 2 .7-2 1.8-.7-1.8-.7-.7-2ZM6 13l-1 2.6-2.5 1L5 17.5 6 20l1-2.5 2.5-.9-2.5-1L6 13Z",
  telescope: "m10 6 8-3 2 4-8 3M10 6l2 4M8 12l-4 9M12 12l4 9",
  todo: "M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  trash: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6",
  workflow: "M3 5h6v6H3zM15 13h6v6h-6zM9 8h3a3 3 0 0 1 3 3v2",
  zap: "M13 2 3 14h8l-1 8 10-12h-8l1-8Z",
};

const baseWorkSearchItems = [
  {
    group: "Needs you",
    workKey: "todo-profile-defaults",
    type: "Session",
    tone: "attention",
    state: "Needs you",
    title: "Implementation Session",
    meta: "Todo · Model profile defaults per project",
    href: "./session.html?todo=todo-profile-defaults&session=sess-profile-implementation&state=hitl",
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
    tone: "failed",
    state: "Failed",
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
    state: "Ready to review",
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

document.querySelectorAll("[data-filter-clear]").forEach((button) => {
  const attribute = button.dataset.filterClear;
  const input = attribute ? document.querySelector(`[${attribute}]`) : null;
  if (!(input instanceof HTMLInputElement)) return;
  const sync = () => { button.hidden = input.value.length === 0; };
  input.addEventListener("input", sync);
  button.addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  });
  sync();
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
  toast.textContent = `${message} · prototype demo`;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2200);
}

window.showToast = showToast;

function createProjectContextMenu() {
  const identities = [...document.querySelectorAll(".project-identity")];
  if (!identities.length) return;

  const menu = document.createElement("div");
  menu.id = "project-context-menu";
  menu.className = "project-context-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Project actions");
  menu.innerHTML = `
    <button type="button" role="menuitem" data-project-context-action="Edit project">Edit project</button>
    <button class="danger" type="button" role="menuitem" data-project-context-action="Close project">Close project</button>`;
  document.body.append(menu);

  let activeIdentity = null;

  function projectName(identity) {
    return identity.querySelector("h1, strong")?.textContent.trim() || "project";
  }

  function close({ restoreFocus = false } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (restoreFocus) activeIdentity?.focus();
    activeIdentity = null;
  }

  function open(identity, clientX, clientY) {
    activeIdentity = identity;
    menu.hidden = false;
    menu.style.visibility = "hidden";
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(clientX, window.innerWidth - menuRect.width - 8));
    const top = Math.max(8, Math.min(clientY, window.innerHeight - menuRect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";
    requestAnimationFrame(() => menu.querySelector("button")?.focus());
  }

  identities.forEach((identity) => {
    const name = projectName(identity);
    identity.tabIndex = 0;
    identity.setAttribute("aria-haspopup", "menu");
    identity.setAttribute("aria-controls", menu.id);
    identity.setAttribute("aria-label", `${name} project actions`);
    identity.setAttribute("aria-keyshortcuts", "Enter Space Shift+F10");
    identity.setAttribute("role", "button");
    identity.setAttribute("title", "Right-click for project actions");
    identity.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      open(identity, event.clientX, event.clientY);
    });
    identity.addEventListener("keydown", (event) => {
      if (!(event.key === "Enter" || event.key === " " || event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
      event.preventDefault();
      const rect = identity.getBoundingClientRect();
      open(identity, rect.left, rect.bottom + 4);
    });
  });

  menu.addEventListener("click", (event) => {
    const action = event.target.closest("[data-project-context-action]");
    if (!action || !activeIdentity) return;
    showToast(`${action.dataset.projectContextAction}: ${projectName(activeIdentity)}`);
    close({ restoreFocus: true });
  });

  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      close({ restoreFocus: true });
    }
  });
  window.addEventListener("resize", () => close());
  window.addEventListener("scroll", () => close(), true);
}

createProjectContextMenu();

function readPrototypeSessions() {
  try {
    const value = JSON.parse(localStorage.getItem("archcode-prototype-sessions") || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

window.readPrototypeSessions = readPrototypeSessions;

/** Shared static Sessions catalog for list pages + Home Needs-you slice. */
const archcodePrototypeStaticSessions = [
  {
    group: "Needs you",
    tone: "attention",
    state: "Needs you",
    source: "Todo",
    title: "Implementation Session",
    sessionId: "sess-profile-implementation",
    parent: "Model profile defaults per project",
    agent: "Lead → Build",
    href: "./session.html?todo=todo-profile-defaults&session=sess-profile-implementation&state=hitl",
  },
  {
    group: "Needs you",
    tone: "failed",
    state: "Failed",
    source: "Automation",
    title: "Daily project health check",
    sessionId: "sess-aut-health-failed",
    parent: "Daily project health check",
    agent: "Lead",
    href: "./session.html?automation=aut-health&session=sess-aut-health-failed&title=Daily%20project%20health%20check",
  },
  {
    group: "Needs you",
    tone: "attention",
    state: "Needs you",
    source: "Todo",
    title: "Review recoverable worktree cleanup",
    sessionId: "sess-worktree-permission",
    parent: "Review recoverable worktree cleanup",
    agent: "Lead",
    href: "./session.html?todo=todo-worktree-permission&session=sess-worktree-permission",
  },
  {
    group: "Running",
    tone: "running",
    state: "12m",
    source: "Todo",
    title: "Live execution recovery",
    sessionId: "sess-live-recovery",
    parent: "Live execution recovery",
    agent: "Lead → Explore",
    href: "./session.html?todo=todo-live-recovery&session=sess-live-recovery",
  },
  {
    group: "Running",
    tone: "running",
    state: "34s",
    source: "Direct",
    title: "Fix incorrect model type",
    sessionId: "sess-direct-model-type",
    parent: "Lead",
    agent: "Lead",
    href: "./session.html?session=sess-direct-model-type&title=Fix%20incorrect%20model%20type",
  },
  {
    group: "Recent",
    tone: "done",
    state: "Completed · 1h",
    source: "Todo",
    title: "Review Session",
    sessionId: "sess-profile-review",
    parent: "Model profile defaults per project",
    agent: "Analyst",
    href: "./session.html?todo=todo-profile-defaults&session=sess-profile-review",
  },
  {
    group: "Recent",
    tone: "done",
    state: "Completed · Yesterday",
    source: "Automation",
    title: "Regression check · Aug 1",
    sessionId: "sess-aut-regression-20260801",
    parent: "Regression check",
    agent: "Lead",
    href: "./session.html?automation=aut-regression&session=sess-aut-regression-20260801&title=Regression%20check",
  },
  {
    group: "Recent",
    tone: "done",
    state: "Completed · Jul 30",
    source: "Direct",
    title: "Audit project context loading",
    sessionId: "sess-legacy-context-audit",
    parent: "Lead",
    agent: "Lead",
    href: "./session.html?session=sess-legacy-context-audit",
  },
];
window.archcodePrototypeStaticSessions = archcodePrototypeStaticSessions;

function escapePrototypeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
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
    state: "Project",
    title: "archcode-readme-demo-workspace",
    meta: "Registered project",
    demoAction: "Open archcode-readme-demo-workspace",
  },
  {
    group: "Projects",
    workKey: "project-specra-test",
    type: "Project",
    tone: "",
    state: "Project",
    title: "specra-test-projects",
    meta: "Registered project",
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

const currentProjectName = document.querySelector(".project-identity h1")?.textContent.trim() || "project";
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
    meta: "Permission gate · Model profile defaults per project",
    state: "Needs you",
    tone: "attention",
    href: "./session.html?todo=todo-profile-defaults&session=sess-profile-implementation&state=hitl",
  },
  {
    type: "Todo",
    title: "Review worktree deletion permission",
    meta: "Lead is waiting on one scoped decision",
    state: "Needs you",
    tone: "attention",
    href: "./todos.html#todo=todo-worktree-permission",
  },
  {
    type: "Automation",
    title: "Daily project health check",
    meta: "Latest run stopped before the final report",
    state: "Failed",
    tone: "failed",
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
          <span class="session-finder-orbit ${escapePrototypeHtml(item.tone || "attention")}"></span>
          <span class="session-finder-copy"><span class="session-finder-type">${escapePrototypeHtml(item.type)}</span><strong>${escapePrototypeHtml(item.title)}</strong><small>${escapePrototypeHtml(item.meta)}</small></span>
          <span class="session-finder-state ${escapePrototypeHtml(item.tone || "attention")}">${escapePrototypeHtml(item.state)}</span>
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

function createProjectPicker() {
  const trigger = document.querySelector("[data-open-project-picker]");
  const projects = [...document.querySelectorAll(".rail-project[data-project-key]")];
  if (!(trigger instanceof HTMLButtonElement) || !projects.length) return;

  const picker = document.createElement("section");
  picker.id = "project-picker";
  picker.className = "project-picker";
  picker.hidden = true;
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-modal", "false");
  picker.setAttribute("aria-label", "Switch project");
  picker.setAttribute("aria-hidden", "true");
  picker.innerHTML = `
    <div class="project-picker-header">
      <strong>Switch project</strong>
      <span>${projects.length} projects</span>
    </div>
    <label class="project-picker-filter">
      ${icon("search")}
      <span class="sr-only">Filter projects</span>
      <input type="search" autocomplete="off" placeholder="Filter projects…" aria-label="Filter projects" data-project-picker-filter />
    </label>
    <div class="project-picker-list">
      ${projects.map((project) => {
        const name = project.dataset.projectName || project.dataset.projectKey || "Project";
        const path = project.dataset.projectPath || "";
        const mark = [...project.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)?.textContent?.trim() || name.slice(0, 2).toLowerCase();
        const attention = project.dataset.projectAttention;
        const current = project.classList.contains("active");
        return `<button type="button" class="project-picker-row" data-project-picker-key="${escapePrototypeHtml(project.dataset.projectKey)}" data-project-picker-search="${escapePrototypeHtml(`${name} ${path}`.toLowerCase())}"${current ? ' aria-current="page"' : ""}>
          <span class="project-picker-mark">${escapePrototypeHtml(mark)}</span>
          <span class="project-picker-copy"><strong>${escapePrototypeHtml(name)}</strong><small>${escapePrototypeHtml(path)}</small></span>
          ${attention ? `<span class="project-picker-count" aria-label="${escapePrototypeHtml(attention)} items need you">${escapePrototypeHtml(attention)}</span>` : ""}
        </button>`;
      }).join("")}
      <p class="project-picker-empty" role="status" hidden>No projects match.</p>
    </div>`;
  document.body.append(picker);

  const filter = picker.querySelector("[data-project-picker-filter]");
  const rows = [...picker.querySelectorAll("[data-project-picker-key]")];
  const empty = picker.querySelector(".project-picker-empty");

  function close({ restoreFocus = true } = {}) {
    if (picker.hidden) return;
    picker.hidden = true;
    picker.setAttribute("aria-hidden", "true");
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) requestAnimationFrame(() => trigger.focus());
  }

  function open() {
    picker.hidden = false;
    picker.setAttribute("aria-hidden", "false");
    trigger.setAttribute("aria-expanded", "true");
    if (filter instanceof HTMLInputElement) {
      filter.value = "";
      rows.forEach((row) => { row.hidden = false; });
      if (empty) empty.hidden = true;
      requestAnimationFrame(() => filter.focus());
    }
  }

  trigger.addEventListener("click", () => {
    if (picker.hidden) open();
    else close();
  });

  filter?.addEventListener("input", () => {
    const query = filter instanceof HTMLInputElement ? filter.value.trim().toLowerCase() : "";
    let visible = 0;
    rows.forEach((row) => {
      const match = query.length === 0 || row.dataset.projectPickerSearch?.includes(query);
      row.hidden = !match;
      if (match) visible += 1;
    });
    if (empty) empty.hidden = visible !== 0;
  });

  picker.addEventListener("click", (event) => {
    const row = event.target.closest("[data-project-picker-key]");
    if (!(row instanceof HTMLButtonElement)) return;
    const source = projects.find((project) => project.dataset.projectKey === row.dataset.projectPickerKey);
    close({ restoreFocus: false });
    source?.click();
  });

  document.addEventListener("pointerdown", (event) => {
    if (picker.hidden || picker.contains(event.target) || trigger.contains(event.target)) return;
    close({ restoreFocus: false });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !picker.hidden) {
      event.preventDefault();
      close();
    }
  });
}

createProjectPicker();

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

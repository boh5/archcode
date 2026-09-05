(() => {
  const icons = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-7h6v7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    inbox: '<path d="M4 4h16v13H4z"/><path d="M4 13h4l2 3h4l2-3h4"/>',
    message: '<path d="M4 5h16v11H9l-5 4Z"/><path d="M8 9h8M8 12h5"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.15.35.36.7.6 1 .31.32.7.46 1.1.4H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    more: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    inspector: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/>',
    play: '<path d="m8 5 11 7-11 7Z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    'corner-down-right': '<path d="M15 10l5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    code: '<path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14"/>',
    file: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/>',
    'file-plus': '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 14h6M12 11v6"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 10c5 0 5-3 8-3"/>',
    send: '<path d="m4 4 17 8-17 8 3-8Z"/><path d="M7 12h14"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
    spark: '<path d="m12 3 1.3 4.2L17.5 9l-4.2 1.8L12 15l-1.3-4.2L6.5 9l4.2-1.8Z"/><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7Z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/>',
    activity: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
    filter: '<path d="M4 5h16l-6 7v5l-4 2v-7Z"/>',
    sort: '<path d="M8 6h12M8 12h9M8 18h6M4 5v14"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
    alert: '<path d="M12 3 2.8 20h18.4Z"/><path d="M12 9v4M12 17h.01"/>',
    shield: '<path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6Z"/><path d="m9 12 2 2 4-4"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m13 7 4 4"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 9A7 7 0 0 1 18.8 7M17.9 15A7 7 0 0 1 5.2 17"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    square: '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>',
    git: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 10c5 0 5-3 8-3"/>',
    attach: '<path d="m21 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8L15 6.3"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    'arrow-up': '<path d="m6 11 6-6 6 6M12 5v14"/>',
    'arrow-left': '<path d="m19 12-14 0M11 18l-6-6 6-6"/>',
    memory: '<path d="M8 3h8v4h3v10h-3v4H8v-4H5V7h3Z"/><path d="M9 9h6M9 13h6"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  };

  function renderIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((node) => {
      const name = node.dataset.icon;
      const body = icons[name];
      if (!body || node.dataset.iconReady) return;
      node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
      node.dataset.iconReady = 'true';
    });
  }

  const prototypeTodoStoreKey = 'archcode-prototype-todos';
  function readPrototypeTodoStore() {
    try {
      const value = JSON.parse(sessionStorage.getItem(prototypeTodoStoreKey) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  function writePrototypeTodoStore(store) {
    try { sessionStorage.setItem(prototypeTodoStoreKey, JSON.stringify(store)); } catch { /* Reference-only prototype state. */ }
  }
  function prototypeTodoById(id) {
    if (!id) return undefined;
    return readPrototypeTodoStore()[id];
  }
  function savePrototypeTodo(content, lane = 'idea', requestedId) {
    const normalizedContent = String(content || '').trim();
    const store = readPrototypeTodoStore();
    const existing = Object.values(store).find((todo) => todo?.content === normalizedContent);
    const id = requestedId || existing?.id || crypto.randomUUID();
    const todo = { id, content: normalizedContent, lane, updatedAt: Date.now() };
    store[id] = todo;
    writePrototypeTodoStore(store);
    return todo;
  }
  function updatePrototypeTodoLane(id, lane) {
    const todo = prototypeTodoById(id);
    if (todo) savePrototypeTodo(todo.content, lane, id);
  }
  function normalizeTodoDisplayLine(line) {
    return line
      .replace(/^(?:#{1,6}|>|[-+*]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s*/, '');
  }
  function truncateTodoDisplayText(value, maximum) {
    const characters = Array.from(value);
    return characters.length <= maximum ? value : `${characters.slice(0, maximum - 1).join('').trimEnd()}…`;
  }
  function projectTodoDisplayLead(content) {
    const lines = String(content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const heading = lines.find((line) => /^#{1,6}\s+/.test(line));
    const source = heading
      ? heading.replace(/^#{1,6}\s+/, '')
      : lines.map(normalizeTodoDisplayLine).filter(Boolean).join(' ');
    return truncateTodoDisplayText(source.replace(/\s+/g, ' ').trim(), 80) || 'Untitled Todo';
  }
  function projectTodoPreviewExcerpt(content) {
    const lines = String(content || '').split(/\r?\n/);
    const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
    if (firstContentLine >= 0 && /^#{1,6}\s+/.test(lines[firstContentLine].trim())) lines.splice(firstContentLine, 1);
    const plain = lines.join('\n')
      .replace(/^#+\s+/gm, '')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^\d+[.)]\s+/gm, '')
      .replace(/[#>*_`]/g, '')
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return truncateTodoDisplayText(plain, 180);
  }
  function escapePrototypeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }
  function renderPrototypeMarkdown(markdown) {
    const output = document.createDocumentFragment();
    const paragraph = [];
    let listType;
    let listItems = [];
    let fence;
    let codeLines = [];
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const node = document.createElement('p');
      node.textContent = paragraph.join(' ');
      output.appendChild(node);
      paragraph.length = 0;
    };
    const flushList = () => {
      if (!listType) return;
      const list = document.createElement(listType);
      listItems.forEach((item) => {
        const node = document.createElement('li');
        node.textContent = item;
        list.appendChild(node);
      });
      output.appendChild(list);
      listType = undefined;
      listItems = [];
    };
    const appendCodeBlock = () => {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.appendChild(code);
      output.appendChild(pre);
    };
    String(markdown || '').split(/\r?\n/).forEach((line) => {
      const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
          appendCodeBlock();
          fence = undefined;
          codeLines = [];
        } else codeLines.push(line);
        return;
      }
      if (fenceMatch) {
        flushParagraph();
        flushList();
        fence = fenceMatch[1];
        return;
      }
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = Math.min(6, heading[1].length + 2);
        const node = document.createElement(`h${level}`);
        node.textContent = heading[2];
        output.appendChild(node);
        return;
      }
      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const nextType = ordered ? 'ol' : 'ul';
        if (listType && listType !== nextType) flushList();
        listType = nextType;
        listItems.push((unordered || ordered)[1]);
        return;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        return;
      }
      flushList();
      paragraph.push(line.trim());
    });
    if (fence) appendCodeBlock();
    flushParagraph();
    flushList();
    return output;
  }
  window.prototypeTodoDisplayLead = projectTodoDisplayLead;
  window.renderPrototypeTodoMarkdown = (target, markdown) => {
    target.replaceChildren(renderPrototypeMarkdown(markdown));
  };
  window.persistPrototypeTodoContent = (id, content, lane = 'idea') => savePrototypeTodo(content, lane, id);

  function ensureSharedDialogs() {
    if (!document.querySelector('[data-work-search-dialog]')) {
      document.body.insertAdjacentHTML('beforeend', `
        <dialog class="work-search-dialog" data-work-search-dialog aria-labelledby="work-search-title">
          <div class="work-search-shell">
            <header class="work-search-head"><div><h2 id="work-search-title">Search all work</h2><p>Projects, Todos, Sessions, and Automations</p></div><button class="icon-button" type="button" data-work-search-close aria-label="Close search"><span data-icon="close"></span></button></header>
            <label class="work-search-field"><span data-icon="search"></span><input type="search" autocomplete="off" placeholder="Search by content, stable ID, or source…" aria-label="Search all work" data-work-search-input></label>
            <div class="work-search-results" data-work-search-results>
              <section class="work-search-group" data-work-search-group hidden><h3>Projects</h3><a class="work-search-row" href="./todos.html" data-work-search-text="archcode project developer ai archcode"><span class="search-result-mark">ac</span><span><strong>ArchCode</strong><small>~/Developer/AI/archcode</small></span><b>Current</b></a></section>
              <section class="work-search-group" data-work-search-group hidden><h3>ArchCode</h3><a class="work-search-row" href="./session.html?view=detail&amp;sample=permission" data-work-search-text="recovery policy permission needs you 3ae77f76-0a63-42f4-85db-53ec65c02cec"><span class="search-result-dot attention"></span><span><strong>Recovery policy</strong><small>Work Session · Permission waiting</small></span><b>Needs you</b></a><a class="work-search-row" href="./session.html?view=detail&amp;sample=running" data-work-search-text="model profile defaults session running 4e8b1d3a-2f9c-4a67-a1cd-825da20d2e6b"><span class="search-result-dot live"></span><span><strong>Model profile defaults per project</strong><small>Work Session · Lead</small></span><b>Running</b></a><a class="work-search-row" href="./session.html?view=detail&amp;sample=direct-completed" data-work-search-text="preserve approval state restart direct completed 7c6cc655-1d3e-4c4f-9368-9014460322df"><span class="search-result-dot done"></span><span><strong>Preserve approval state after restart</strong><small>Direct Session · Lead</small></span><b>Completed</b></a><a class="work-search-row" href="./automations.html?automation=dependency" data-work-search-text="profile validation sweep automation todo schedule 5ed67823-cf0e-4690-a7c4-f4c7bd53e5e9"><span class="search-result-dot neutral"></span><span><strong>Profile validation sweep</strong><small>Automation · Weekdays at 09:00</small></span><b>Scheduled</b></a></section>
              <p class="work-search-empty" data-work-search-empty>Search by content, stable ID, or source.</p>
            </div>
          </div>
        </dialog>`);
    }
    if (!document.querySelector('[data-project-dialog]')) {
      document.body.insertAdjacentHTML('beforeend', `<dialog class="modal project-dialog" data-project-dialog aria-labelledby="project-dialog-title"><form class="modal-card" method="dialog"><div class="modal-head"><h2 id="project-dialog-title">Add Project</h2><button class="icon-button" type="button" data-project-dialog-close aria-label="Close"><span data-icon="close"></span></button></div><div class="project-dialog-search"><label class="sr-only" for="project-path">Search or type a folder path</label><div class="project-dialog-field"><span data-icon="search"></span><input id="project-path" type="text" placeholder="Search or type a folder path…" autocomplete="off" data-project-path></div></div><div class="project-dialog-actions"><span data-project-dialog-help>Type to search for directories</span><div><button class="quiet-button" type="button" data-project-dialog-close>Cancel</button><button class="primary-button" type="button" data-project-open disabled>Add Project</button></div></div></form></dialog>`);
    }
    if (!document.querySelector('[data-settings-dialog]')) {
      document.body.insertAdjacentHTML('beforeend', `
        <dialog class="modal settings-dialog" data-settings-dialog aria-labelledby="settings-dialog-title" aria-describedby="settings-dialog-description">
          <div class="settings-card">
            <header class="modal-head settings-head">
              <div><h2 id="settings-dialog-title">Settings</h2><p id="settings-dialog-description">Server and application</p></div>
              <button class="icon-button" type="button" data-settings-dialog-close aria-label="Close Settings"><span data-icon="close"></span></button>
            </header>
            <div class="settings-layout">
              <nav aria-label="Settings sections" data-settings-nav>
                <span class="settings-nav-label">Server</span>
                <button class="active" type="button" data-settings-section="models" aria-current="page">Models</button>
                <button type="button" data-settings-section="profiles">Profiles</button>
                <button type="button" data-settings-section="security">Security</button>
                <button type="button" data-settings-section="runtime-data">Runtime Data</button>
                <button type="button" data-settings-section="mcp">MCP</button>
                <button type="button" data-settings-section="skills">Skills</button>
                <button type="button" data-settings-section="memory">Memory</button>
                <button type="button" data-settings-section="github">GitHub</button>
                <button type="button" data-settings-section="updates">About &amp; Updates</button>
              </nav>
              <div class="settings-workspace">
                <div class="settings-apply-notice" role="status" aria-live="polite" data-settings-notice hidden></div>
                <section class="settings-panel" tabindex="-1" data-settings-panel></section>
                <footer class="settings-footer" data-settings-footer>
                  <span data-settings-save-state>All changes saved</span>
                  <div><button class="quiet-button" type="button" data-settings-action="reload">Reload</button><button class="primary-button" type="button" data-settings-action="save" disabled>Save changes</button></div>
                </footer>
              </div>
            </div>
          </div>
        </dialog>
        <dialog class="modal settings-confirm-dialog" data-settings-confirm-dialog aria-labelledby="settings-confirm-title" aria-describedby="settings-confirm-copy">
          <div class="modal-card">
            <div class="modal-head"><div><h2 id="settings-confirm-title" data-settings-confirm-title>Confirm action</h2><p id="settings-confirm-copy" data-settings-confirm-copy></p></div><button class="icon-button" type="button" data-settings-confirm-cancel aria-label="Cancel action"><span data-icon="close"></span></button></div>
            <div class="modal-body settings-confirm-body" data-settings-confirm-body></div>
            <div class="modal-actions"><button class="quiet-button" type="button" data-settings-confirm-cancel>Cancel</button><button class="danger-button" type="button" data-settings-confirm-accept>Confirm</button></div>
          </div>
        </dialog>`);
    }
  }

  ensureSharedDialogs();
  const storedTheme = localStorage.getItem('archcode-prototype-theme');
  document.documentElement.dataset.theme = storedTheme || 'dark';
  renderIcons();

  const focusableSelector = [
    'a[href]:not([hidden])',
    'button:not([hidden]):not(:disabled)',
    'input:not([hidden]):not(:disabled)',
    'select:not([hidden]):not(:disabled)',
    'textarea:not([hidden]):not(:disabled)',
    '[tabindex]:not([tabindex="-1"]):not([hidden])',
  ].join(',');
  function trapTabWithin(container, event) {
    if (event.key !== 'Tab') return;
    const items = [...container.querySelectorAll(focusableSelector)].filter((item) => !item.closest('[hidden]') && item.getClientRects().length);
    if (!items.length) return;
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('archcode-prototype-theme', next);
      button.setAttribute('aria-label', next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    });
  });

  const todoNav = document.querySelector('.todo-nav');
  const navToggles = [...document.querySelectorAll('[data-nav-toggle]')];
  let todoNavOrigin;
  let todoNavScrim;
  if (todoNav) {
    todoNavScrim = document.createElement('button');
    todoNavScrim.type = 'button';
    todoNavScrim.className = 'todo-nav-scrim';
    todoNavScrim.hidden = true;
    todoNavScrim.tabIndex = -1;
    todoNavScrim.setAttribute('aria-label', 'Close Todo navigation');
    document.body.appendChild(todoNavScrim);
  }
  function syncTodoNavState() {
    if (!todoNav) return;
    if (!todoNav.id) todoNav.id = 'todo-navigation';
    const drawer = matchMedia('(max-width: 980px)').matches;
    const expanded = !drawer || document.body.classList.contains('nav-open');
    if (todoNavScrim) todoNavScrim.hidden = !drawer || !expanded;
    todoNav.toggleAttribute('inert', !expanded);
    todoNav.setAttribute('aria-hidden', String(!expanded));
    navToggles.forEach((button) => {
      button.setAttribute('aria-controls', todoNav.id);
      button.setAttribute('aria-expanded', String(expanded));
    });
  }
  function closeTodoNav(restoreFocus = false) {
    document.body.classList.remove('nav-open');
    syncTodoNavState();
    if (restoreFocus) todoNavOrigin?.focus();
  }
  window.syncPrototypeNavState = syncTodoNavState;
  navToggles.forEach((button) => {
    button.addEventListener('click', () => {
      if (!matchMedia('(max-width: 980px)').matches) return;
      todoNavOrigin = button;
      document.body.classList.toggle('nav-open');
      syncTodoNavState();
      if (document.body.classList.contains('nav-open')) requestAnimationFrame(() => todoNav?.querySelector('a,button')?.focus());
    });
  });
  todoNavScrim?.addEventListener('click', () => closeTodoNav(true));
  todoNav?.addEventListener('keydown', (event) => {
    if (matchMedia('(max-width: 980px)').matches && document.body.classList.contains('nav-open')) trapTabWithin(todoNav, event);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('nav-open')) {
      event.preventDefault();
      closeTodoNav(true);
    }
  });
  window.addEventListener('resize', syncTodoNavState);
  syncTodoNavState();

  const inspectorToggles = [...document.querySelectorAll('[data-inspector-toggle]')];
  const inspector = document.querySelector('.context-inspector');
  let inspectorOrigin;
  let inspectorScrim;
  if (inspector) {
    inspectorScrim = document.createElement('button');
    inspectorScrim.type = 'button';
    inspectorScrim.className = 'inspector-scrim';
    inspectorScrim.hidden = true;
    inspectorScrim.tabIndex = -1;
    inspectorScrim.setAttribute('aria-label', 'Close Session inspector');
    document.body.appendChild(inspectorScrim);
  }
  const inspectorResize = document.querySelector('[data-inspector-resize]');
  const inspectorWidthKey = 'archcode-prototype-inspector-width';
  const clampInspectorWidth = (width) => Math.min(460, Math.max(280, Math.round(width)));
  const storedInspectorWidth = Number(localStorage.getItem(inspectorWidthKey));
  let inspectorWidth = clampInspectorWidth(Number.isFinite(storedInspectorWidth) && storedInspectorWidth ? storedInspectorWidth : 312);
  document.documentElement.style.setProperty('--inspector-width', `${inspectorWidth}px`);
  if (inspectorResize) inspectorResize.setAttribute('aria-valuenow', String(inspectorWidth));
  function syncInspectorState() {
    const overlay = matchMedia('(max-width: 1260px)').matches;
    const expanded = overlay
      ? document.body.classList.contains('inspector-open')
      : !document.body.classList.contains('inspector-collapsed');
    if (inspectorScrim) inspectorScrim.hidden = !overlay || !expanded;
    inspectorToggles.forEach((button) => {
      button.setAttribute('aria-expanded', String(expanded));
      button.classList.toggle('active', expanded);
    });
    inspector?.toggleAttribute('inert', !expanded);
    inspector?.setAttribute('aria-hidden', String(!expanded));
  }
  window.syncPrototypeInspectorState = syncInspectorState;
  inspectorToggles.forEach((button) => {
    button.addEventListener('click', () => {
      inspectorOrigin = button;
      if (matchMedia('(max-width: 1260px)').matches) {
        document.body.classList.toggle('inspector-open');
      } else {
        document.body.classList.toggle('inspector-collapsed');
      }
      syncInspectorState();
      const expanded = inspectorToggles.some((item) => item.getAttribute('aria-expanded') === 'true');
      if (expanded) requestAnimationFrame(() => inspector?.querySelector('[data-inspector-close]')?.focus());
    });
  });
  function closeInspector(restoreFocus = true) {
    if (matchMedia('(max-width: 1260px)').matches) document.body.classList.remove('inspector-open');
    else document.body.classList.add('inspector-collapsed');
    syncInspectorState();
    if (restoreFocus) inspectorOrigin?.focus();
  }
  document.querySelectorAll('[data-inspector-close]').forEach((button) => {
    button.addEventListener('click', () => closeInspector());
  });
  inspector?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeInspector();
      return;
    }
    if (matchMedia('(max-width: 1260px)').matches && document.body.classList.contains('inspector-open')) trapTabWithin(inspector, event);
  });
  inspectorScrim?.addEventListener('click', () => closeInspector(true));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const expanded = inspectorToggles.some((button) => button.getAttribute('aria-expanded') === 'true');
    if (!expanded || !matchMedia('(max-width: 1260px)').matches) return;
    event.preventDefault();
    closeInspector();
  });
  const inspectorTabs = [...(inspector?.querySelectorAll('[role="tab"]') || [])];
  inspectorTabs.forEach((tab, index) => tab.addEventListener('keydown', (event) => {
    const keyTarget = event.key === 'ArrowRight'
      ? index + 1
      : event.key === 'ArrowLeft'
        ? index - 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? inspectorTabs.length - 1
            : null;
    if (keyTarget === null) return;
    event.preventDefault();
    const next = inspectorTabs[(keyTarget + inspectorTabs.length) % inspectorTabs.length];
    next.click();
    next.focus();
  }));
  let inspectorResizeStart;
  function setInspectorWidth(width, persist = false) {
    inspectorWidth = clampInspectorWidth(width);
    document.documentElement.style.setProperty('--inspector-width', `${inspectorWidth}px`);
    inspectorResize?.setAttribute('aria-valuenow', String(inspectorWidth));
    if (persist) localStorage.setItem(inspectorWidthKey, String(inspectorWidth));
  }
  inspectorResize?.addEventListener('pointerdown', (event) => {
    inspectorResizeStart = { x: event.clientX, width: inspectorWidth };
    inspectorResize.setPointerCapture(event.pointerId);
  });
  inspectorResize?.addEventListener('pointermove', (event) => {
    if (!inspectorResizeStart) return;
    setInspectorWidth(inspectorResizeStart.width + inspectorResizeStart.x - event.clientX);
  });
  const finishInspectorResize = (event) => {
    if (!inspectorResizeStart) return;
    inspectorResizeStart = undefined;
    if (inspectorResize?.hasPointerCapture(event.pointerId)) inspectorResize.releasePointerCapture(event.pointerId);
    setInspectorWidth(inspectorWidth, true);
  };
  inspectorResize?.addEventListener('pointerup', finishInspectorResize);
  inspectorResize?.addEventListener('pointercancel', finishInspectorResize);
  inspectorResize?.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 40 : 10;
    if (event.key === 'ArrowLeft') setInspectorWidth(inspectorWidth + step, true);
    else if (event.key === 'ArrowRight') setInspectorWidth(inspectorWidth - step, true);
    else if (event.key === 'Home') setInspectorWidth(280, true);
    else if (event.key === 'End') setInspectorWidth(460, true);
    else return;
    event.preventDefault();
  });
  window.addEventListener('resize', syncInspectorState);
  syncInspectorState();

  document.querySelectorAll('[data-surface]').forEach((button) => {
    button.addEventListener('click', () => {
      window.closePrototypeTodoPreview?.({ restoreFocus: false });
      const value = button.dataset.surface;
      const scope = button.closest('[data-surface-scope]') || document;
      scope.querySelectorAll('[data-surface]').forEach((item) => {
        const selected = item === button;
        item.classList.toggle('active', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      document.querySelectorAll('[data-surface-panel]').forEach((panel) => { panel.hidden = panel.dataset.surfacePanel !== value; });
      window.syncPrototypeTodoFilter?.();
    });
  });
  document.querySelectorAll('.page-todos [data-surface-panel="rejected"] button[data-toast],.page-todos [data-surface-panel="archived"] button[data-toast]').forEach((button) => {
    const confirmation = button.dataset.toast;
    delete button.dataset.toast;
    button.addEventListener('click', () => {
      const row = button.closest('.work-row');
      const displayLead = row?.querySelector('strong')?.textContent.trim();
      const todoId = row?.dataset.todoId;
      const content = prototypeTodoById(todoId)?.content || displayLead;
      const group = row?.closest('.work-group');
      const isArchived = Boolean(row?.closest('[data-surface-panel="archived"]'));
      const restoreLane = isArchived ? (row?.dataset.restoreLane || 'idea') : 'idea';
      row?.remove();
      if (group) {
        const remaining = group.querySelectorAll('.todo-filter-item').length;
        const count = group.querySelector('.group-heading b');
        if (count) count.textContent = String(remaining);
        group.hidden = remaining === 0;
      }
      if (content) window.addPrototypeTodo?.(content, restoreLane, 'Restored', todoId);
      document.querySelector('[data-surface="active"]')?.click();
      showToast(confirmation || `Todo restored to ${restoreLane === 'idea' ? 'Ideas' : restoreLane === 'in_progress' ? 'In progress' : restoreLane[0].toUpperCase() + restoreLane.slice(1)}.`);
    });
  });

  const knownTodoSamples = new Map([
    ['Model profile defaults per project', 'running'],
    ['Add a durable permission audit trail', 'ready'],
    ['Choose the recovery policy for interrupted runs', 'permission'],
    ['Review the Todo → Run handoff contract', 'question'],
    ['Make tool output recovery inspectable', 'output-recovery-review'],
    ['Recover remote projects after cold start', 'remote-recovery-failed'],
  ]);
  const knownTodoKeys = new Map([
    ['Model profile defaults per project', 'profile'],
    ['Add a durable permission audit trail', 'audit'],
    ['Choose the recovery policy for interrupted runs', 'recovery'],
    ['Review the Todo → Run handoff contract', 'handoff'],
    ['Make tool output recovery inspectable', 'outputRecovery'],
    ['Recover remote projects after cold start', 'remoteRecovery'],
    ['Expose workspace health before bootstrap', 'workspaceHealth'],
  ]);
  const todoDetailUrl = (contentOrLead, lane, todoId) => {
    const displayLead = projectTodoDisplayLead(contentOrLead);
    const sample = knownTodoSamples.get(displayLead) || 'todo-shell';
    if (sample !== 'todo-shell') return `./session.html?view=todo&sample=${sample}&lane=${encodeURIComponent(lane)}`;
    const knownTodoKey = knownTodoKeys.get(displayLead);
    if (knownTodoKey) return `./session.html?view=todo&sample=todo-shell&todo=${encodeURIComponent(knownTodoKey)}&lane=${encodeURIComponent(lane)}`;
    const todo = savePrototypeTodo(contentOrLead, lane, todoId);
    return `./session.html?view=todo&sample=todo-shell&todo=${encodeURIComponent(todo.id)}&lane=${encodeURIComponent(lane)}`;
  };
  const navTodoTitles = {
    'Tool output recovery': ['Make tool output recovery inspectable', 'in_progress'],
    'Remote cold start': ['Recover remote projects after cold start', 'in_progress'],
    'Workspace health check': ['Expose workspace health before bootstrap', 'ready'],
  };
  document.querySelectorAll('.todo-nav a.nav-row').forEach((link) => {
    const label = link.querySelector('span:nth-child(2)')?.textContent.trim();
    const target = navTodoTitles[label];
    if (target) link.href = todoDetailUrl(target[0], target[1]);
  });
  const todoLaneLabels = { idea: 'Ideas', ready: 'Ready', in_progress: 'In progress', done: 'Done' };
  const todoLaneVisuals = {
    idea: { tone: 'neutral', icon: 'spark' },
    ready: { tone: 'ready', icon: 'play' },
    in_progress: { tone: 'progress', icon: 'activity' },
    done: { tone: 'done', icon: 'check' },
  };
  document.querySelectorAll('.page-todos [data-view-panel="list"] .work-group').forEach((group) => {
    const heading = group.querySelector('.group-heading span')?.textContent.trim().toLocaleLowerCase() || '';
    const lane = group.dataset.todoStage || (heading.startsWith('ready') ? 'ready' : heading.startsWith('in progress') ? 'in_progress' : heading.startsWith('done') ? 'done' : 'idea');
    group.querySelectorAll('a.todo-filter-item').forEach((link) => {
      const title = link.querySelector('strong')?.textContent.trim() || 'Todo';
      link.href = todoDetailUrl(title, lane);
    });
  });

  window.addPrototypeTodo = (content, laneKey = 'idea', activity = 'Restored', todoId) => {
    const targetGroup = [...document.querySelectorAll('.page-todos [data-view-panel="list"] .work-group')]
      .find((group) => group.dataset.todoStage === laneKey);
    const targetList = targetGroup?.querySelector('.work-list');
    const visual = todoLaneVisuals[laneKey];
    if (!targetList || !visual) return;
    const todo = savePrototypeTodo(content, laneKey, todoId);
    const displayLead = projectTodoDisplayLead(todo.content);
    const row = document.createElement('a');
    row.className = 'work-row todo-filter-item';
    row.dataset.filterText = `${todo.content} ${laneKey}`.toLocaleLowerCase();
    row.dataset.stableId = todo.id;
    row.dataset.todoId = todo.id;
    row.href = todoDetailUrl(todo.content, laneKey, todo.id);
    row.innerHTML = `<span class="work-orbit ${visual.tone}"><span data-icon="${visual.icon}"></span></span><span class="work-copy"><strong></strong><span>${activity} just now</span></span><span data-icon="chevron"></span>`;
    row.querySelector('strong').textContent = displayLead;
    targetList.appendChild(row);
    renderIcons(row);
    window.syncPrototypeTodoFilter?.();
  };
  window.addPrototypeIdeaTodo = (content, todoId) => window.addPrototypeTodo(content, 'idea', 'Created', todoId);

  const todoPreviewItems = [...document.querySelectorAll('.page-todos [data-surface-panel="active"] .todo-filter-item')];
  if (todoPreviewItems.length) {
    let previewOrigin;
    document.body.insertAdjacentHTML('beforeend', `
      <button class="todo-preview-scrim" type="button" tabindex="-1" aria-hidden="true" data-todo-preview-close hidden></button>
      <aside class="todo-preview" role="dialog" aria-modal="true" aria-labelledby="todo-preview-heading" data-todo-preview hidden>
        <h2 class="sr-only" id="todo-preview-heading" tabindex="-1">Todo detail</h2>
        <header><span><i></i> Preview</span><button class="icon-button" type="button" aria-label="Close preview" data-todo-preview-close><span data-icon="close"></span></button></header>
        <div class="todo-preview-body"><h3 data-todo-preview-title></h3><p class="todo-preview-excerpt" data-todo-preview-copy></p><div class="todo-preview-meta"><div class="todo-preview-stage" data-todo-preview-stage><button class="todo-preview-stage-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="todo-preview-stage-options" data-todo-preview-stage-trigger><span>Stage:</span><strong data-todo-preview-stage-label>Idea</strong><span data-icon="down"></span></button><div class="todo-preview-stage-menu" id="todo-preview-stage-options" role="menu" aria-label="Todo stage" data-todo-preview-stage-menu hidden><button type="button" role="menuitemradio" aria-checked="true" data-todo-preview-stage-option="idea"><span class="work-orbit neutral"><span data-icon="spark"></span></span><span>Idea</span><span data-icon="check"></span></button><button type="button" role="menuitemradio" aria-checked="false" data-todo-preview-stage-option="ready"><span class="work-orbit ready"><span data-icon="play"></span></span><span>Ready</span><span data-icon="check" hidden></span></button><button type="button" role="menuitemradio" aria-checked="false" data-todo-preview-stage-option="in_progress"><span class="work-orbit progress"><span data-icon="activity"></span></span><span>In progress</span><span data-icon="check" hidden></span></button><button type="button" role="menuitemradio" aria-checked="false" data-todo-preview-stage-option="done"><span class="work-orbit done"><span data-icon="check"></span></span><span>Done</span><span data-icon="check" hidden></span></button></div><span class="sr-only" aria-live="polite" data-todo-preview-stage-status></span></div><span data-todo-preview-updated>Updated recently</span></div><section class="todo-preview-stage-confirm" aria-label="Confirm Todo stage change" data-todo-preview-stage-confirm hidden><strong>Linked work is still <span data-todo-preview-stage-confirm-state>running</span>.</strong><p>Moving this Todo to Done changes only its stage. It will not stop or resolve the linked Session.</p><div><button class="quiet-button" type="button" data-todo-preview-stage-cancel>Cancel</button><button class="secondary-button" type="button" data-todo-preview-stage-confirm-action>Move to Done</button></div></section><div class="todo-preview-operational" data-todo-preview-operational hidden><span class="section-kicker">Current activity</span><strong data-todo-preview-runtime></strong></div><section class="todo-preview-linked" data-todo-preview-linked hidden><span class="section-kicker">Linked work</span><a data-todo-preview-work><span class="work-orbit"><span data-icon="activity"></span></span><span><strong data-todo-preview-work-title></strong><small data-todo-preview-work-context></small></span><span class="status-label" data-todo-preview-work-status></span></a></section><p class="todo-preview-footnote">Content and context stay read-only here. Stage changes organize the Todo only. Open details for Markdown, references, Plan, Reject, Archive, and result.</p></div>
        <footer><button class="primary-button" type="button" data-todo-preview-action hidden></button><div class="todo-preview-secondary"><a class="quiet-button" data-todo-preview-details>Open details</a><button class="quiet-button" type="button" data-todo-preview-discussion hidden>Discussion</button></div></footer>
      </aside>`);
    const preview = document.querySelector('[data-todo-preview]');
    const previewScrim = document.querySelector('.todo-preview-scrim');
    const previewHeading = preview?.querySelector('#todo-preview-heading');
    const previewTitle = preview?.querySelector('[data-todo-preview-title]');
    const previewStage = preview?.querySelector('[data-todo-preview-stage]');
    const previewStageTrigger = preview?.querySelector('[data-todo-preview-stage-trigger]');
    const previewStageLabel = preview?.querySelector('[data-todo-preview-stage-label]');
    const previewStageMenu = preview?.querySelector('[data-todo-preview-stage-menu]');
    const previewStageOptions = [...(preview?.querySelectorAll('[data-todo-preview-stage-option]') || [])];
    const previewStageStatus = preview?.querySelector('[data-todo-preview-stage-status]');
    const previewStageConfirm = preview?.querySelector('[data-todo-preview-stage-confirm]');
    const previewStageConfirmState = preview?.querySelector('[data-todo-preview-stage-confirm-state]');
    const previewStageCancel = preview?.querySelector('[data-todo-preview-stage-cancel]');
    const previewStageConfirmAction = preview?.querySelector('[data-todo-preview-stage-confirm-action]');
    const previewUpdated = preview?.querySelector('[data-todo-preview-updated]');
    const previewRuntime = preview?.querySelector('[data-todo-preview-runtime]');
    const previewOperational = preview?.querySelector('[data-todo-preview-operational]');
    const previewLinked = preview?.querySelector('[data-todo-preview-linked]');
    const previewWork = preview?.querySelector('[data-todo-preview-work]');
    const previewWorkTitle = preview?.querySelector('[data-todo-preview-work-title]');
    const previewWorkContext = preview?.querySelector('[data-todo-preview-work-context]');
    const previewWorkStatus = preview?.querySelector('[data-todo-preview-work-status]');
    const previewCopy = preview?.querySelector('[data-todo-preview-copy]');
    const previewAction = preview?.querySelector('[data-todo-preview-action]');
    const previewDetails = preview?.querySelector('[data-todo-preview-details]');
    const previewDiscussion = preview?.querySelector('[data-todo-preview-discussion]');
    const previewLanePresentation = {
      idea: ['Idea', 'neutral'], ready: ['Ready', 'ready'], in_progress: ['In progress', 'progress'], done: ['Done', 'done'],
    };
    const previewCompactMedia = matchMedia('(max-width: 720px)');
    const previewExcerpts = {
      'Model profile defaults per project': 'Allow a project to specialize model selection without copying the full provider configuration or hiding invalid references.',
      'Choose the recovery policy for interrupted runs': 'Verify the stale worktree before moving it to Trash, without touching the project root or active Sessions.',
      'Review the Todo → Run handoff contract': 'Preserve the Discussion evidence and record a recommendation without starting implementation from the Discussion itself.',
      'Add a durable permission audit trail': 'Retain the request, decision, and resumed Execution relationship without inventing a second continuation run.',
    };
    const previewLinkedWork = {
      'Model profile defaults per project': { sample: 'running', title: 'Implementation · Project profile defaults', context: 'Work Session · codex/project-profile-defaults', status: 'Running', tone: 'live', kind: 'work' },
      'Choose the recovery policy for interrupted runs': { sample: 'permission', title: 'Recovery verification', context: 'Work Session · recovery-policy', status: 'Needs you', tone: 'attention', kind: 'work' },
      'Review the Todo → Run handoff contract': { sample: 'question', title: 'Handoff recommendation', context: 'Discussion · project root', status: 'Needs you', tone: 'attention', kind: 'discussion' },
      'Add a durable permission audit trail': { sample: 'ready', title: 'Audit trail implementation', context: 'Work Session · project root', status: 'Completed', tone: 'done', kind: 'work' },
      'Make tool output recovery inspectable': { sample: 'output-recovery-review', title: 'Output recovery verification', context: 'Work Session · output-recovery', status: 'Completed', tone: 'done', kind: 'work' },
      'Recover remote projects after cold start': { sample: 'remote-recovery-failed', title: 'Remote recovery verification', context: 'Work Session · remote-cold-start', status: 'Failed', tone: 'error', kind: 'work' },
    };
    let previewContext;
    let previewStagePending = false;
    let previewCloseAfterPending = false;
    let previewStageTimer;

    function previewLinkedWorkState(displayLead) {
      const linkedWork = previewLinkedWork[displayLead];
      if (!linkedWork || !['Running', 'Needs you'].includes(linkedWork.status)) return undefined;
      return linkedWork.status;
    }
    function syncPreviewStagePresentation(lane) {
      const [label, tone] = previewLanePresentation[lane] || previewLanePresentation.idea;
      if (previewStageLabel) previewStageLabel.textContent = label;
      if (previewStageTrigger) {
        previewStageTrigger.className = `todo-preview-stage-trigger ${tone}`;
        previewStageTrigger.setAttribute('aria-label', `Change Todo stage, current ${label}`);
      }
      previewStageOptions.forEach((option) => {
        const selected = option.dataset.todoPreviewStageOption === lane;
        option.setAttribute('aria-checked', String(selected));
        const check = option.querySelector(':scope > [data-icon="check"]');
        if (check) check.hidden = !selected;
      });
    }
    function setPreviewStagePending(pending) {
      previewStagePending = pending;
      if (previewStageTrigger) {
        previewStageTrigger.disabled = pending;
        previewStageTrigger.setAttribute('aria-busy', String(pending));
      }
      previewStageOptions.forEach((option) => { option.disabled = pending; });
      if (previewStageCancel) previewStageCancel.disabled = pending;
      if (previewStageConfirmAction) previewStageConfirmAction.disabled = pending;
      document.querySelectorAll('[data-todo-preview-close]').forEach((control) => { control.disabled = pending; });
      if (pending) {
        if (previewStageLabel) previewStageLabel.textContent = 'Updating…';
        if (previewStageStatus) previewStageStatus.textContent = 'Updating Todo stage.';
      }
      else if (previewContext) syncPreviewStagePresentation(previewContext.lane);
    }
    function closePreviewStageMenu({ restoreFocus = false } = {}) {
      if (previewStageMenu) previewStageMenu.hidden = true;
      previewStageTrigger?.setAttribute('aria-expanded', 'false');
      if (restoreFocus) previewStageTrigger?.focus();
    }
    function openPreviewStageMenu({ edge = 'selected' } = {}) {
      if (!previewStageMenu || !previewStageTrigger || previewStagePending) return;
      if (previewStageConfirm) previewStageConfirm.hidden = true;
      previewStageMenu.hidden = false;
      previewStageTrigger.setAttribute('aria-expanded', 'true');
      const selectedIndex = Math.max(0, previewStageOptions.findIndex((option) => option.getAttribute('aria-checked') === 'true'));
      const target = edge === 'first'
        ? previewStageOptions[0]
        : edge === 'last'
          ? previewStageOptions.at(-1)
          : previewStageOptions[selectedIndex];
      requestAnimationFrame(() => target?.focus());
    }
    function syncPreviewActions(displayLead, lane, todoId) {
      const linkedWork = previewLinkedWork[displayLead];
      const linkedSample = linkedWork?.sample;
      const hasWorkSession = linkedWork?.kind === 'work';
      const hasDiscussion = linkedWork?.kind === 'discussion';
      const todoRouteKey = todoId || knownTodoKeys.get(displayLead);
      const todoQuery = todoRouteKey ? `&todo=${encodeURIComponent(todoRouteKey)}` : '';
      let actionCopy = '';
      let actionHref = '';
      if (lane === 'idea') {
        actionCopy = hasDiscussion ? 'Continue discussion' : 'Start discussion';
        actionHref = hasDiscussion && linkedSample
          ? `./session.html?view=detail&sample=${linkedSample}`
          : `./session.html?view=detail&sample=discussion-new${todoQuery}&lane=idea`;
      } else if (lane === 'ready' || lane === 'in_progress') {
        actionCopy = hasWorkSession ? 'Continue work' : 'Start work';
        actionHref = hasWorkSession && linkedSample
          ? `./session.html?view=detail&sample=${linkedSample}`
          : `./session.html?view=detail&sample=work-new${todoQuery}&lane=in_progress`;
      }
      if (previewAction) {
        previewAction.hidden = !actionCopy || !actionHref;
        previewAction.textContent = actionCopy;
        previewAction.dataset.previewActionHref = actionHref;
      }
      if (previewDiscussion) {
        const showDiscussion = lane !== 'idea';
        previewDiscussion.hidden = !showDiscussion;
        previewDiscussion.textContent = hasDiscussion ? 'Continue discussion' : 'Discussion';
        previewDiscussion.dataset.previewDiscussionHref = hasDiscussion && linkedSample
          ? `./session.html?view=detail&sample=${linkedSample}`
          : `./session.html?view=detail&sample=discussion-new${todoQuery}&lane=${lane}`;
      }
    }
    function listGroupForStage(lane) {
      return document.querySelector(`.page-todos [data-view-panel="list"] .work-group[data-todo-stage="${lane}"]`);
    }
    function syncNavigatorLifecycleCounts() {
      const sections = [...document.querySelectorAll('.page-todos .todo-nav .nav-section')];
      for (const [label, stage] of [['Ready', 'ready'], ['In progress', 'in_progress']]) {
        const section = sections.find((candidate) => candidate.querySelector('.nav-section-title span')?.textContent.trim() === label);
        const count = section?.querySelector('.nav-section-title b');
        const group = listGroupForStage(stage);
        if (count && group) count.textContent = String(group.querySelectorAll('.todo-filter-item').length);
      }
    }
    function syncNavigatorLifecycle(displayLead, lane, operationalTone, href) {
      const sections = [...document.querySelectorAll('.page-todos .todo-nav .nav-section')];
      const sectionLabel = (section) => section.querySelector('.nav-section-title span')?.textContent.trim();
      const lifecycleSections = sections.filter((section) => ['In progress', 'Ready'].includes(sectionLabel(section)));
      const needsYouSection = sections.find((section) => sectionLabel(section) === 'Needs you');
      const needsYouRow = [...(needsYouSection?.querySelectorAll('.nav-row') || [])]
        .find((row) => row.querySelector('span:nth-child(2)')?.textContent.trim() === displayLead);
      let navRow = lifecycleSections
        .flatMap((section) => [...section.querySelectorAll('.nav-row')])
        .find((row) => row.querySelector('span:nth-child(2)')?.textContent.trim() === displayLead);
      const targetLabel = lane === 'ready' ? 'Ready' : lane === 'in_progress' ? 'In progress' : undefined;
      const targetSection = lifecycleSections.find((section) => sectionLabel(section) === targetLabel);
      if (needsYouRow) {
        if (href) needsYouRow.href = href;
        if (navRow) navRow.hidden = true;
        syncNavigatorLifecycleCounts();
        return;
      }
      if (targetSection && !navRow) {
        navRow = document.createElement('a');
        navRow.className = 'nav-row';
        navRow.innerHTML = '<span class="nav-status"></span><span></span>';
        navRow.querySelector('span:nth-child(2)').textContent = displayLead;
      }
      if (!targetSection) {
        if (navRow) navRow.hidden = true;
        syncNavigatorLifecycleCounts();
        return;
      }
      targetSection.appendChild(navRow);
      targetSection.hidden = false;
      navRow.hidden = false;
      if (href) navRow.href = href;
      const status = navRow.querySelector('.nav-status');
      if (status) {
        status.className = `nav-status ${operationalTone || (lane === 'ready' ? 'ready' : 'progress')}`;
      }
      syncNavigatorLifecycleCounts();
    }
    function previewRowOperationalTone(item) {
      if (item.querySelector('.attention-copy')) return 'attention';
      if (item.querySelector('.live-copy')) return 'live';
      if (item.querySelector('.review-copy')) return 'review';
      if (item.querySelector('.error-copy')) return 'error';
      return undefined;
    }
    function movePreviewTodoToLane(context, lane) {
      const targetGroup = listGroupForStage(lane);
      const targetList = targetGroup?.querySelector('.work-list');
      if (!targetList || !context.item) return false;
      targetList.insertBefore(context.item, targetList.querySelector(':scope > [data-group-empty]'));
      const secondary = context.item.querySelector('.work-copy > span')?.textContent.trim() || '';
      context.item.dataset.filterText = `${context.content} ${secondary} ${lane}`.toLocaleLowerCase();
      const link = context.item.matches('a') ? context.item : context.item.querySelector('a');
      if (link instanceof HTMLAnchorElement) link.href = todoDetailUrl(context.content, lane, context.todoId);
      if (context.todoId && prototypeTodoById(context.todoId)) updatePrototypeTodoLane(context.todoId, lane);
      const operationalTone = previewRowOperationalTone(context.item);
      if (!operationalTone) {
        const orbit = context.item.querySelector('.work-orbit');
        const visual = todoLaneVisuals[lane];
        if (orbit && visual) {
          orbit.className = `work-orbit ${visual.tone}`;
          orbit.innerHTML = `<span data-icon="${visual.icon}"></span>`;
          renderIcons(orbit);
        }
      }
      syncNavigatorLifecycle(context.displayLead, lane, operationalTone, link instanceof HTMLAnchorElement ? link.getAttribute('href') : undefined);
      window.syncPrototypeTodoFilter?.();
      return true;
    }
    function applyPreviewStageChange(lane) {
      const context = previewContext;
      if (!context || previewStagePending || context.lane === lane) {
        closePreviewStageMenu({ restoreFocus: true });
        return;
      }
      closePreviewStageMenu();
      if (previewStageConfirm) previewStageConfirm.hidden = true;
      previewHeading?.focus();
      setPreviewStagePending(true);
      window.clearTimeout(previewStageTimer);
      previewStageTimer = window.setTimeout(() => {
        const moved = movePreviewTodoToLane(context, lane);
        if (moved) {
          context.lane = lane;
          syncPreviewStagePresentation(lane);
          syncPreviewActions(context.displayLead, lane, context.todoId);
          if (previewDetails) previewDetails.href = todoDetailUrl(context.content, lane, context.todoId);
          const linkedState = previewLinkedWorkState(context.displayLead);
          if (previewStageStatus) previewStageStatus.textContent = `Todo stage updated to ${previewLanePresentation[lane][0]}.`;
          showToast(`Todo moved to ${previewLanePresentation[lane][0]}.${linkedState ? ` Linked work remains ${linkedState}.` : ''}`);
        }
        setPreviewStagePending(false);
        if (previewCloseAfterPending || previewCompactMedia.matches) {
          previewCloseAfterPending = false;
          closeTodoPreview();
        }
        else previewStageTrigger?.focus();
      }, 240);
    }
    function requestPreviewStageChange(lane) {
      if (!previewContext || lane === previewContext.lane) {
        closePreviewStageMenu({ restoreFocus: true });
        return;
      }
      const linkedState = previewLinkedWorkState(previewContext.displayLead);
      if (lane === 'done' && linkedState) {
        closePreviewStageMenu();
        if (previewStageConfirmState) previewStageConfirmState.textContent = linkedState;
        if (previewStageConfirm) previewStageConfirm.hidden = false;
        requestAnimationFrame(() => previewStageCancel?.focus());
        return;
      }
      applyPreviewStageChange(lane);
    }
    function syncTodoPreviewInset() {
      const command = document.querySelector('.page-todos .inventory-command');
      if (command) document.documentElement.style.setProperty('--todo-preview-top', `${Math.round(command.getBoundingClientRect().bottom)}px`);
    }
    new ResizeObserver(syncTodoPreviewInset).observe(document.querySelector('.page-todos .inventory-command'));
    window.addEventListener('resize', syncTodoPreviewInset);
    syncTodoPreviewInset();
    let previewCloseTimer;
    function clearTodoPreviewSelection() {
      document.querySelectorAll('.page-todos [data-surface-panel="active"] .todo-filter-item.is-selected').forEach((row) => {
        row.classList.remove('is-selected');
        row.removeAttribute('aria-current');
      });
    }
    function closeTodoPreview({ restoreFocus = true } = {}) {
      if (previewStagePending) return;
      clearTodoPreviewSelection();
      if (!preview || preview.hidden) return;
      closePreviewStageMenu();
      if (previewStageConfirm) previewStageConfirm.hidden = true;
      window.clearTimeout(previewCloseTimer);
      preview.classList.remove('preview-opening');
      preview.classList.add('preview-closing');
      preview.inert = true;
      if (previewScrim) {
        previewScrim.classList.add('preview-closing');
        previewScrim.disabled = true;
      }
      const origin = previewOrigin;
      previewOrigin = undefined;
      const visibleOrigin = origin && !origin.hidden && origin.getClientRects().length > 0 ? origin : undefined;
      if (restoreFocus) (visibleOrigin || todoFilterInput)?.focus();
      if (previewCompactMedia.matches) {
        preview.hidden = true;
        preview.classList.remove('preview-closing');
        if (previewScrim) {
          previewScrim.hidden = true;
          previewScrim.classList.remove('preview-closing');
          previewScrim.disabled = false;
        }
        return;
      }
      previewCloseTimer = window.setTimeout(() => {
        preview.hidden = true;
        preview.classList.remove('preview-closing');
        if (previewScrim) {
          previewScrim.hidden = true;
          previewScrim.classList.remove('preview-closing');
          previewScrim.disabled = false;
        }
      }, 180);
    }
    previewCompactMedia.addEventListener('change', (event) => {
      if (!event.matches || !preview || preview.hidden) return;
      if (previewStagePending) {
        previewCloseAfterPending = true;
        return;
      }
      closeTodoPreview();
    });
    function openTodoPreview(item) {
      const link = item.matches('a') ? item : item.querySelector('a');
      const linkUrl = link?.href ? new URL(link.href, location.href) : undefined;
      const todoId = item.dataset.todoId || linkUrl?.searchParams.get('todo');
      const storedTodo = prototypeTodoById(todoId);
      const displayLead = storedTodo
        ? projectTodoDisplayLead(storedTodo.content)
        : item.querySelector('strong')?.textContent.trim() || 'Todo';
      const group = item.closest('.work-group');
      const groupHeading = group?.querySelector('.group-heading span')?.textContent.trim().toLocaleLowerCase() || '';
      const lane = group?.dataset.todoStage || (groupHeading.startsWith('ready') ? 'ready' : groupHeading.startsWith('in progress') ? 'in_progress' : groupHeading.startsWith('done') ? 'done' : 'idea');
      previewOrigin = link || item;
      previewContext = {
        item,
        todoId,
        content: storedTodo?.content || displayLead,
        displayLead,
        lane,
      };
      previewCloseAfterPending = false;
      if (previewStageStatus) previewStageStatus.textContent = '';
      closePreviewStageMenu();
      if (previewStageConfirm) previewStageConfirm.hidden = true;
      setPreviewStagePending(false);
      syncPreviewStagePresentation(lane);
      clearTodoPreviewSelection();
      const itemStableId = item.dataset.stableId;
      document.querySelectorAll('.page-todos [data-surface-panel="active"] .todo-filter-item').forEach((candidate) => {
        const sameTodo = itemStableId
          ? candidate.dataset.stableId === itemStableId
          : candidate.querySelector('strong')?.textContent.trim() === displayLead;
        candidate.classList.toggle('is-selected', sameTodo);
        if (sameTodo) candidate.setAttribute('aria-current', 'true');
        else candidate.removeAttribute('aria-current');
      });
      if (previewTitle) previewTitle.textContent = displayLead;
      if (previewCopy) previewCopy.textContent = storedTodo
        ? projectTodoPreviewExcerpt(storedTodo.content)
        : previewExcerpts[displayLead] || 'Review the captured problem statement and acceptance boundary before changing this Todo. Open details for the complete canonical content.';
      const secondary = (item.querySelector('small') || item.querySelector('.work-copy > span'))?.textContent.trim() || '';
      const hasOperationalSignal = Boolean(item.querySelector('.attention-copy,.live-copy,.review-copy,.error-copy'));
      if (previewUpdated) previewUpdated.textContent = hasOperationalSignal ? 'Updated recently' : secondary || 'Updated recently';
      if (previewRuntime) previewRuntime.textContent = secondary;
      if (previewOperational) previewOperational.hidden = !hasOperationalSignal;
      if (previewDetails) previewDetails.href = link?.href || todoDetailUrl(storedTodo?.content || displayLead, lane, todoId);
      syncPreviewActions(displayLead, lane, todoId);
      const linkedWork = previewLinkedWork[displayLead];
      if (previewLinked) previewLinked.hidden = !linkedWork;
      if (linkedWork) {
        if (previewWork) previewWork.href = `./session.html?view=detail&sample=${linkedWork.sample}`;
        if (previewWorkTitle) previewWorkTitle.textContent = linkedWork.title;
        if (previewWorkContext) previewWorkContext.textContent = linkedWork.context;
        if (previewWorkStatus) { previewWorkStatus.textContent = linkedWork.status; previewWorkStatus.className = `status-label ${linkedWork.tone}`; }
      }
      window.clearTimeout(previewCloseTimer);
      if (preview) {
        preview.hidden = false;
        preview.inert = false;
        preview.classList.remove('preview-closing', 'preview-opening');
        requestAnimationFrame(() => preview.classList.add('preview-opening'));
      }
      if (previewScrim) {
        previewScrim.hidden = false;
        previewScrim.disabled = false;
        previewScrim.classList.remove('preview-closing', 'preview-opening');
        requestAnimationFrame(() => previewScrim.classList.add('preview-opening'));
      }
      renderIcons(preview);
      requestAnimationFrame(() => document.querySelector('#todo-preview-heading')?.focus());
    }
    document.querySelector('#todo-active-layout')?.addEventListener('click', (event) => {
      const item = event.target.closest('.todo-filter-item');
      if (!item || matchMedia('(max-width: 720px)').matches) return;
      event.preventDefault();
      openTodoPreview(item);
    });
    window.closePrototypeTodoPreview = closeTodoPreview;
    document.querySelectorAll('[data-todo-preview-close]').forEach((button) => button.addEventListener('click', closeTodoPreview));
    previewStageTrigger?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (previewStageMenu?.hidden) openPreviewStageMenu();
      else closePreviewStageMenu({ restoreFocus: true });
    });
    previewStageTrigger?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openPreviewStageMenu({ edge: event.key === 'ArrowUp' ? 'last' : 'selected' });
      } else if (event.key === 'Escape' && previewStageMenu && !previewStageMenu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        closePreviewStageMenu({ restoreFocus: true });
      }
    });
    previewStageOptions.forEach((option) => {
      option.addEventListener('click', () => requestPreviewStageChange(option.dataset.todoPreviewStageOption));
      option.addEventListener('keydown', (event) => {
        const index = previewStageOptions.indexOf(option);
        const targetIndex = event.key === 'ArrowDown'
          ? (index + 1) % previewStageOptions.length
          : event.key === 'ArrowUp'
            ? (index - 1 + previewStageOptions.length) % previewStageOptions.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? previewStageOptions.length - 1
                : null;
        if (targetIndex !== null) {
          event.preventDefault();
          previewStageOptions[targetIndex]?.focus();
        } else if (event.key === 'Tab') {
          event.preventDefault();
          closePreviewStageMenu();
          const focusable = [...preview.querySelectorAll('button:not([hidden]):not(:disabled),a[href]:not([hidden]),[tabindex="0"]')]
            .filter((element) => !element.closest('[hidden]') && element.getClientRects().length > 0);
          const triggerIndex = focusable.indexOf(previewStageTrigger);
          const target = event.shiftKey
            ? focusable[triggerIndex - 1] || focusable.at(-1)
            : focusable[triggerIndex + 1] || focusable[0];
          target?.focus();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closePreviewStageMenu({ restoreFocus: true });
        }
      });
    });
    previewStageCancel?.addEventListener('click', () => {
      if (previewStageConfirm) previewStageConfirm.hidden = true;
      previewStageTrigger?.focus();
    });
    previewStageConfirmAction?.addEventListener('click', () => applyPreviewStageChange('done'));
    previewStage?.addEventListener('focusout', () => {
      requestAnimationFrame(() => {
        if (!previewStage.contains(document.activeElement)) closePreviewStageMenu();
      });
    });
    previewAction?.addEventListener('click', () => {
      if (previewAction.dataset.previewActionHref) location.href = previewAction.dataset.previewActionHref;
    });
    previewDiscussion?.addEventListener('click', () => {
      if (previewDiscussion.dataset.previewDiscussionHref) location.href = previewDiscussion.dataset.previewDiscussionHref;
    });
    preview?.addEventListener('click', (event) => {
      if (!event.target.closest('[data-todo-preview-stage]')) closePreviewStageMenu();
    });
    preview?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (previewStageMenu && !previewStageMenu.hidden) {
          closePreviewStageMenu({ restoreFocus: true });
          return;
        }
        if (previewStageConfirm && !previewStageConfirm.hidden) {
          previewStageConfirm.hidden = true;
          previewStageTrigger?.focus();
          return;
        }
        closeTodoPreview();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...preview.querySelectorAll('button:not([hidden]):not(:disabled),a[href]:not([hidden]),[tabindex="0"]')]
        .filter((element) => !element.closest('[hidden]') && element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === previewHeading)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  document.querySelectorAll('[data-notification-toggle]').forEach((button) => {
    const setNotificationOpen = (popover, open, restoreFocus = false) => {
      if (!popover) return;
      popover.classList.toggle('open', open);
      popover.toggleAttribute('inert', !open);
      popover.setAttribute('aria-hidden', String(!open));
      button.setAttribute('aria-expanded', String(open));
      if (open) requestAnimationFrame(() => popover.querySelector('[data-notification-close]')?.focus());
      else if (restoreFocus) button.focus();
    };
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      document.querySelector('.toast')?.classList.remove('show');
      let popover = document.querySelector('#notification-popover');
      if (!popover) {
        popover = document.createElement('section');
        popover.id = 'notification-popover';
        popover.className = 'notification-popover';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', 'Work that needs you');
        popover.setAttribute('aria-hidden', 'true');
        popover.inert = true;
        popover.innerHTML = `
          <div class="notification-head"><div><span class="section-kicker attention">Needs you</span><h2>Work that needs you</h2></div><button class="icon-button" data-notification-close aria-label="Close"><span data-icon="close"></span></button></div>
          <a class="notification-item" href="./session.html?view=detail&amp;sample=permission"><span class="work-orbit attention"><span data-icon="pause"></span></span><span><strong>Recovery policy</strong><small>Permission waiting · ArchCode</small></span><span data-icon="chevron"></span></a>
          <a class="notification-item" href="./session.html?view=detail&amp;sample=question"><span class="work-orbit attention"><span data-icon="pause"></span></span><span><strong>Todo handoff review</strong><small>Question waiting · ArchCode</small></span><span data-icon="chevron"></span></a>`;
        document.body.appendChild(popover);
        renderIcons(popover);
        popover.querySelector('[data-notification-close]')?.addEventListener('click', () => {
          setNotificationOpen(popover, false, true);
        });
      }
      const open = !popover.classList.contains('open');
      document.querySelectorAll('.notification-popover').forEach((item) => {
        if (item !== popover) {
          item.classList.remove('open');
          item.inert = true;
          item.setAttribute('aria-hidden', 'true');
        }
      });
      setNotificationOpen(popover, open);
    });
    document.addEventListener('keydown', (event) => {
      const popover = document.querySelector('#notification-popover.open');
      if (event.key !== 'Escape' || !popover) return;
      event.preventDefault();
      setNotificationOpen(popover, false, true);
    });
  });

  const workSearchDialog = document.querySelector('[data-work-search-dialog]');
  const workSearchInput = document.querySelector('[data-work-search-input]');
  const workSearchTriggers = [...document.querySelectorAll('[data-open-global-search]')];
  let workSearchOrigin;
  const searchIdentityByTitle = new Map([
    ['Recovery policy', '3ae77f76-0a63-42f4-85db-53ec65c02cec'],
    ['Model profile defaults per project', '4e8b1d3a-2f9c-4a67-a1cd-825da20d2e6b'],
    ['Profile validation sweep', '5ed67823-cf0e-4690-a7c4-f4c7bd53e5e9'],
  ]);
  document.querySelectorAll('[data-work-search-text]').forEach((row) => {
    const stableId = searchIdentityByTitle.get(row.querySelector('strong')?.textContent.trim());
    if (stableId && !row.dataset.workSearchText.includes(stableId)) row.dataset.workSearchText += ` ${stableId}`;
  });
  const workSearchProjectGroup = [...document.querySelectorAll('[data-work-search-group]')].find((group) => group.querySelector('h3')?.textContent.trim() === 'ArchCode');
  if (workSearchProjectGroup && !workSearchProjectGroup.querySelector('[href*="direct-completed"]')) {
    workSearchProjectGroup.insertAdjacentHTML('beforeend', '<a class="work-search-row" href="./session.html?view=detail&amp;sample=direct-completed" data-work-search-text="preserve approval state restart direct completed 7c6cc655-1d3e-4c4f-9368-9014460322df"><span class="search-result-dot done"></span><span><strong>Preserve approval state after restart</strong><small>Direct Session · Lead</small></span><b>Completed</b></a>');
  }
  const workSearchRows = [...document.querySelectorAll('[data-work-search-text]')];
  function filterWorkSearch() {
    const query = workSearchInput?.value.trim().toLowerCase() || '';
    const hasQuery = query.length > 0;
    workSearchRows.forEach((row) => { row.hidden = !hasQuery || !row.dataset.workSearchText.includes(query); });
    document.querySelectorAll('[data-work-search-group]').forEach((group) => { group.hidden = !group.querySelector('[data-work-search-text]:not([hidden])'); });
    const empty = document.querySelector('[data-work-search-empty]');
    if (empty) {
      empty.textContent = hasQuery ? 'No matching work.' : 'Search by content, stable ID, or source.';
      empty.hidden = hasQuery && workSearchRows.some((row) => !row.hidden);
    }
  }
  workSearchTriggers.forEach((trigger) => trigger.addEventListener('click', () => {
    workSearchOrigin = trigger;
    workSearchDialog?.showModal();
    trigger.setAttribute('aria-expanded', 'true');
    filterWorkSearch();
    requestAnimationFrame(() => workSearchInput?.focus());
  }));
  document.querySelector('[data-work-search-close]')?.addEventListener('click', () => workSearchDialog?.close());
  workSearchDialog?.addEventListener('click', (event) => { if (event.target === workSearchDialog) workSearchDialog.close(); });
  workSearchDialog?.addEventListener('close', () => {
    workSearchTriggers.forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'));
    workSearchOrigin?.focus();
  });
  workSearchInput?.addEventListener('input', filterWorkSearch);

  const projectDialog = document.querySelector('[data-project-dialog]');
  const projectPathInput = projectDialog?.querySelector('[data-project-path]');
  const projectOpenButton = projectDialog?.querySelector('[data-project-open]');
  const settingsDialog = document.querySelector('[data-settings-dialog]');
  let projectDialogOrigin;
  document.querySelectorAll('[data-open-project]').forEach((button) => button.addEventListener('click', () => {
    projectDialogOrigin = button;
    if (projectPathInput) projectPathInput.value = '';
    if (projectOpenButton) projectOpenButton.disabled = true;
    projectDialog?.showModal();
    requestAnimationFrame(() => projectPathInput?.focus());
  }));
  projectDialog?.addEventListener('close', () => {
    projectDialogOrigin?.focus();
  });
  document.querySelectorAll('[data-project-dialog-close]').forEach((button) => button.addEventListener('click', () => projectDialog?.close()));
  projectDialog?.addEventListener('click', (event) => { if (event.target === projectDialog) projectDialog.close(); });
  projectPathInput?.addEventListener('input', () => {
    if (projectOpenButton) projectOpenButton.disabled = !projectPathInput.value.trim();
  });
  projectOpenButton?.addEventListener('click', () => {
    const path = projectPathInput?.value.trim();
    if (!path) return projectPathInput?.focus();
    projectDialog?.close();
    if (document.body.classList.contains('page-project-empty')) {
      location.href = './todos.html';
      return;
    }
    showToast('Project registration previewed.');
  });
  const settingsPanel = settingsDialog?.querySelector('[data-settings-panel]');
  const settingsFooter = settingsDialog?.querySelector('[data-settings-footer]');
  const settingsNotice = settingsDialog?.querySelector('[data-settings-notice]');
  const settingsConfirmDialog = document.querySelector('[data-settings-confirm-dialog]');
  let settingsOrigin;
  let settingsPendingConfirmation;
  let settingsConfirmationOrigin;
  const createSettingsState = () => ({
    section: 'models',
    dirtySections: new Set(),
    notice: '',
    providerName: 'OpenAI',
    providerPackage: '@ai-sdk/openai-compatible',
    providerBaseUrl: 'https://api.openai.com/v1',
    modelName: 'GPT-5.6 Luna',
    contextLimit: '200000',
    outputLimit: '64000',
    inputText: true,
    inputImage: true,
    outputText: true,
    modelOptions: { temperature: 0.2 },
    modelVariants: {
      deep: { maxOutputTokens: 64000, temperature: 0.25 },
      fast: { maxOutputTokens: 16000, temperature: 0.1 },
    },
    jsonErrors: {},
    providerRemoved: false,
    extraProvider: false,
    extraModel: false,
    profiles: {
      principal: { model: 'openai:gpt-5.6-luna', variant: 'deep', options: { temperature: 0.25 } },
      deep: { model: 'openai:gpt-5.6-luna', variant: 'deep', options: { temperature: 0.3 } },
      fast: { model: 'openai:gpt-5.6-luna', variant: 'fast', options: { temperature: 0.1 } },
    },
    autoReview: true,
    loginEnabled: false,
    passwordMutationPending: undefined,
    securityCurrentPassword: '',
    securityPassword: '',
    securityConfirmation: '',
    securityAttempted: false,
    securityMessage: '',
    runtimeSelected: false,
    runtimeDeleted: false,
    runtimeMessage: '',
    context7Enabled: true,
    customMcp: true,
    extraMcp: false,
    mcpUrl: 'http://127.0.0.1:7337/mcp',
    mcpMessage: '',
    useMemory: true,
    autoLearning: true,
    personalMemory: 'Prefer evidence-backed diagnosis and narrow, reversible changes.',
    memoryMessage: '',
    topicMessage: '',
    topicName: 'ui-decisions',
    topicTitle: 'UI decisions',
    topicContent: 'Todo is the primary object. Sessions remain durable execution records.',
    topicIsNew: false,
    githubEnabled: false,
    githubTokenEnv: 'GITHUB_TOKEN',
    githubOwner: '',
    githubRepo: '',
    updatePhase: 'current',
  });
  let settingsState = createSettingsState();
  const settingsConfigKeys = ['providerName', 'providerPackage', 'providerBaseUrl', 'modelName', 'contextLimit', 'outputLimit', 'inputText', 'inputImage', 'outputText', 'modelOptions', 'modelVariants', 'providerRemoved', 'extraProvider', 'extraModel', 'profiles', 'context7Enabled', 'customMcp', 'extraMcp', 'mcpUrl', 'useMemory', 'autoLearning', 'githubEnabled', 'githubTokenEnv', 'githubOwner', 'githubRepo', 'autoReview'];
  const captureSettingsConfig = () => Object.fromEntries(settingsConfigKeys.map((key) => [key, structuredClone(settingsState[key])]));
  const captureSettingsMemory = () => structuredClone({ personalMemory: settingsState.personalMemory, topicName: settingsState.topicName, topicTitle: settingsState.topicTitle, topicContent: settingsState.topicContent, topicIsNew: settingsState.topicIsNew });
  let savedSettingsConfig = captureSettingsConfig();
  let savedSettingsMemory = captureSettingsMemory();
  const settingsConfigSections = new Set(['models', 'profiles', 'security', 'mcp', 'memory', 'github']);
  const settingsHeading = (kicker, title, description) => `<header class="settings-panel-head"><span class="section-kicker">${kicker}</span><h3 tabindex="-1">${title}</h3><p>${description}</p></header>`;
  const settingsField = (label, control, hint = '') => `<label class="settings-field"><span>${label}</span>${control}${hint ? `<small>${hint}</small>` : ''}</label>`;
  const settingsToggle = (binding, checked, label, description) => `<label class="settings-toggle"><span><strong>${label}</strong><small>${description}</small></span><input type="checkbox" role="switch" data-settings-bind="${binding}" ${checked ? 'checked' : ''}><i aria-hidden="true"></i></label>`;
  const settingsText = (binding, value, options = '') => `<input ${options} value="${escapePrototypeHtml(value)}" data-settings-bind="${binding}">`;
  const settingsStatus = (label, tone = 'neutral') => `<span class="status-label ${tone}">${label}</span>`;
  const settingsJsonText = (value) => value === undefined ? '' : JSON.stringify(value, null, 2);
  const settingsJsonField = (label, binding, value, hint = '') => {
    const error = settingsState.jsonErrors[binding] || '';
    return `<label class="settings-field settings-json-field"><span>${label}</span><textarea rows="5" spellcheck="false" data-settings-json="${binding}" ${error ? 'aria-invalid="true"' : ''} placeholder="{ }">${escapePrototypeHtml(settingsJsonText(value))}</textarea><small class="settings-json-hint" ${hint ? '' : 'hidden'}>${escapePrototypeHtml(hint)}</small><small class="settings-json-error" role="alert" data-settings-json-error="${binding}" ${error ? '' : 'hidden'}>${escapePrototypeHtml(error)}</small></label>`;
  };
  const settingsModelExists = (model) => !settingsState.providerRemoved && (model === 'openai:gpt-5.6-luna' || (model === 'openai:model-2' && settingsState.extraModel));
  const settingsVariantKeysForModel = (model) => model === 'openai:gpt-5.6-luna' ? Object.keys(settingsState.modelVariants || {}) : [];
  const settingsMissingVariantCount = () => Object.values(settingsState.profiles).filter((profile) => settingsModelExists(profile.model) && profile.variant && !settingsVariantKeysForModel(profile.model).includes(profile.variant)).length;
  let settingsPasswordTimer;
  const settingsPasswordBytes = (value) => new TextEncoder().encode(value).byteLength;
  const resetSettingsPasswordDraft = () => {
    settingsState.securityCurrentPassword = '';
    settingsState.securityPassword = '';
    settingsState.securityConfirmation = '';
    settingsState.securityAttempted = false;
  };
  const settingsPasswordError = () => {
    const current = settingsState.securityCurrentPassword;
    const password = settingsState.securityPassword;
    const confirmation = settingsState.securityConfirmation;
    if (settingsPasswordBytes(current) > 1024) return 'Current password exceeds 1024 UTF-8 bytes.';
    if (settingsPasswordBytes(password) > 1024) return 'Password must not exceed 1024 UTF-8 bytes.';
    if (password && password.length < 10) return 'Use at least 10 characters.';
    if (password && password !== confirmation) return 'Passwords do not match.';
    if (settingsState.loginEnabled && settingsState.securityAttempted && !current) return 'Enter the current password.';
    return '';
  };
  const settingsPasswordValid = () => {
    const current = settingsState.securityCurrentPassword;
    const password = settingsState.securityPassword;
    return Boolean(password)
      && password.length >= 10
      && Boolean(current || !settingsState.loginEnabled)
      && !settingsPasswordError();
  };

  function renderSettingsModels() {
    const providerCard = settingsState.providerRemoved ? '' : `<article class="settings-block">
        <header class="settings-block-head"><div><span>Provider</span><strong>openai</strong><small>${escapePrototypeHtml(settingsState.providerPackage)}</small></div>${settingsStatus('Configured', 'done')}</header>
        <div class="settings-block-body">
          <div class="settings-form-grid">
            ${settingsField('Display name', settingsText('providerName', settingsState.providerName))}
            ${settingsField('Provider package', `<select data-settings-bind="providerPackage"><option ${settingsState.providerPackage.includes('openai-compatible') ? 'selected' : ''}>@ai-sdk/openai-compatible</option><option ${settingsState.providerPackage === '@ai-sdk/anthropic' ? 'selected' : ''}>@ai-sdk/anthropic</option></select>`)}
            ${settingsField('Base URL', settingsText('providerBaseUrl', settingsState.providerBaseUrl, 'type="url"'))}
            ${settingsField('API key', '<div class="settings-secret"><code>••••••••••••</code><button class="quiet-button" type="button" data-settings-action="replace-secret">Replace</button></div>', 'The saved secret remains preserved until replaced.')}
          </div>
          <div class="settings-subsection-head"><div><strong>Models</strong><small>${settingsState.extraModel ? '2 configured models' : '1 configured model'}</small></div><button class="quiet-button" type="button" data-settings-action="add-model"><span data-icon="plus"></span>Add model</button></div>
          <details class="settings-disclosure" open><summary><span data-icon="chevron"></span><strong>gpt-5.6-luna</strong><small>${escapePrototypeHtml(settingsState.modelName)}</small></summary><div class="settings-disclosure-body"><div class="settings-form-grid">
            ${settingsField('Name', settingsText('modelName', settingsState.modelName))}
            ${settingsField('Context limit', settingsText('contextLimit', settingsState.contextLimit, 'type="number" min="1"'))}
            ${settingsField('Output limit', settingsText('outputLimit', settingsState.outputLimit, 'type="number" min="1"'))}
            ${settingsField('Input modalities', `<div class="settings-checks"><label><input type="checkbox" data-settings-bind="inputText" ${settingsState.inputText ? 'checked' : ''}>Text</label><label><input type="checkbox" data-settings-bind="inputImage" ${settingsState.inputImage ? 'checked' : ''}>Image</label></div>`)}
            ${settingsField('Output modalities', `<div class="settings-checks"><label><input type="checkbox" data-settings-bind="outputText" ${settingsState.outputText ? 'checked' : ''}>Text</label></div>`)}
          </div><div class="settings-json-grid">${settingsJsonField('Default options JSON', 'modelOptions', settingsState.modelOptions, 'Base AI SDK call options for this model.')}${settingsJsonField('Variants JSON', 'modelVariants', settingsState.modelVariants, 'Free-form Variant names mapped to model-call option objects.')}</div></div></details>
          ${settingsState.extraModel ? '<div class="settings-compact-row"><span><strong>model-2</strong><small>New model · 128k context</small></span><button class="quiet-button" type="button" data-settings-action="remove-extra-model">Remove</button></div>' : ''}
          <details class="settings-danger-disclosure"><summary>Provider actions</summary><div><p>Removing a provider also removes its configured models. Profile references must be repaired before saving.</p><button class="danger-button" type="button" data-settings-action="remove-provider"><span data-icon="trash"></span>Remove provider</button></div></details>
        </div>
      </article>`;
    return `${settingsHeading('Models', 'Providers and models', 'Configure provider adapters, credentials, model limits, modalities, and variants.')}
      ${providerCard}
      ${settingsState.providerRemoved && !settingsState.extraProvider ? '<div class="settings-empty-state"><strong>No providers configured</strong><p>Add a provider before binding required Profiles.</p></div>' : ''}
      ${settingsState.extraProvider ? '<article class="settings-block settings-compact-block"><div><span>Provider</span><strong>provider-2</strong><small>@ai-sdk/openai-compatible · no models</small></div><button class="quiet-button" type="button" data-settings-action="remove-extra-provider">Remove</button></article>' : ''}
      <button class="settings-add-row" type="button" data-settings-action="add-provider"><span data-icon="plus"></span>Add provider</button>`;
  }

  function renderSettingsProfiles() {
    const renderProfile = (name, description) => {
      const profile = settingsState.profiles[name];
      const modelMissing = settingsState.providerRemoved || (profile.model === 'openai:model-2' && !settingsState.extraModel);
      const variantKeys = settingsVariantKeysForModel(profile.model);
      const variantMissing = !modelMissing && Boolean(profile.variant) && !variantKeys.includes(profile.variant);
      const modelOptions = modelMissing
        ? `<option selected value="${escapePrototypeHtml(profile.model)}">Missing · ${escapePrototypeHtml(profile.model)}</option>`
        : `<option ${profile.model === 'openai:gpt-5.6-luna' ? 'selected' : ''}>openai:gpt-5.6-luna</option>${settingsState.extraModel ? `<option ${profile.model === 'openai:model-2' ? 'selected' : ''}>openai:model-2</option>` : ''}`;
      const variantOptions = `<option value="">Default</option>${variantMissing ? `<option selected disabled value="${escapePrototypeHtml(profile.variant)}">${escapePrototypeHtml(profile.variant)} (missing)</option>` : ''}${variantKeys.map((variant) => `<option ${profile.variant === variant ? 'selected' : ''} value="${escapePrototypeHtml(variant)}">${escapePrototypeHtml(variant)}</option>`).join('')}`;
      const attention = modelMissing || variantMissing;
      return `<details class="settings-profile-disclosure${attention ? ' attention' : ''}"><summary aria-label="${variantMissing ? `${name}, ${profile.model}, variant ${profile.variant} is missing; using model default` : `${name}, ${profile.model}${profile.variant ? `, ${profile.variant}` : ', Default'}`}"><span data-icon="chevron"></span><span class="settings-profile-identity">${attention ? '<i aria-hidden="true"></i>' : ''}<code>${name}</code></span><small>${escapePrototypeHtml(profile.model)}${profile.variant ? ` · ${escapePrototypeHtml(profile.variant)}` : ' · Default'}</small></summary><div class="settings-profile-body"><p>${description}</p><div class="settings-profile-controls"><label><span>Model</span><select data-settings-bind="profiles.${name}.model">${modelOptions}</select></label><label><span>Variant</span><select data-settings-bind="profiles.${name}.variant" ${variantMissing ? 'aria-invalid="true"' : ''}>${variantOptions}</select>${variantMissing ? `<small role="alert">Variant “${escapePrototypeHtml(profile.variant)}” no longer exists. This Profile is using the model default.</small>` : ''}</label></div>${settingsJsonField('Overrides JSON', `profiles.${name}.options`, profile.options, 'Profile options override the selected Model and Variant as one shallow layer.')}</div></details>`;
    };
    return `${settingsHeading('Profiles', 'Execution defaults', 'Principal, deep, and fast bindings are shared by the fixed Agent catalog.')}
      <div class="settings-stack">${renderProfile('principal', 'Root Lead and Discussion default')}${renderProfile('deep', 'Deep delegated analysis and build work')}${renderProfile('fast', 'Fast exploration and library research')}</div>
      <p class="settings-footnote"><span data-icon="alert"></span>A missing variant stays visible as an attention state and falls back to the model default.</p>`;
  }

  function renderSettingsSecurity() {
    const hasLogin = settingsState.loginEnabled;
    const dirty = settingsState.dirtySections.size > 0;
    const pending = Boolean(settingsState.passwordMutationPending);
    const passwordError = settingsPasswordError();
    const current = hasLogin ? '<label class="settings-field"><span>Current password</span><input type="password" autocomplete="current-password" data-settings-security="current"></label>' : '';
    const primaryLabel = pending ? (settingsState.passwordMutationPending === 'remove' ? 'Removing…' : 'Saving…') : hasLogin ? 'Change password' : 'Enable login';
    const dirtyDescription = dirty ? ' aria-describedby="security-password-dirty-hint"' : '';
    return `${settingsHeading('Server settings', 'Security', 'Manage the one password that protects this ArchCode server.')}
      <div class="settings-page-security-review"><label><input type="checkbox" aria-label="AI approval review" data-settings-bind="autoReview" ${settingsState.autoReview ? 'checked' : ''}><span><strong>AI approval review</strong><small>Fast model only approves a single action when it clearly fits the current task; if it is uncertain or fails, you’ll still be asked.</small></span></label></div>
      <div class="settings-page-security-card settings-page-security-status ${hasLogin ? 'attention' : 'error'}" data-settings-page-login-status>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6Z"></path><path d="m9 12 2 2 4-4"></path></svg>
        <div><strong>${hasLogin ? 'Login is required' : 'Login is disabled'}</strong><p>${hasLogin ? 'Changing or removing the password signs every existing browser session out.' : 'Anyone who can reach this server can control ArchCode.'}</p></div>
      </div>
      <div class="settings-page-security-card">
        <h4>Server password</h4><p>${hasLogin ? 'Use the current password to change or remove login.' : 'Set a password to require login for every browser session.'}</p>
        <div class="settings-form-grid security-grid">${current}<label class="settings-field"><span>${hasLogin ? 'New password' : 'Password'}</span><input type="password" minlength="10" autocomplete="new-password" data-settings-security="password"><small>Use at least 10 characters.</small></label><label class="settings-field"><span>Confirm password</span><input type="password" minlength="10" autocomplete="new-password" data-settings-security="confirmation"></label></div>
        <p class="settings-page-security-lock" id="security-password-dirty-hint" role="status" data-settings-security-dirty-hint ${dirty ? '' : 'hidden'}><span>Save or Reload your Config draft before changing the server password.</span></p>
        <p class="settings-page-security-lock" role="status" data-settings-security-pending-hint ${pending ? '' : 'hidden'}><span>Password request is pending. Settings controls are locked until it completes.</span></p>
        <p class="settings-page-security-message" role="status" aria-live="polite" data-settings-inline-message ${settingsState.securityMessage ? '' : 'hidden'}>${escapePrototypeHtml(settingsState.securityMessage)}</p>
        <p class="settings-page-security-error" role="alert" data-settings-security-error ${passwordError ? '' : 'hidden'}>${escapePrototypeHtml(passwordError)}</p>
        <div class="settings-page-security-actions"><button class="primary-button" type="button"${dirtyDescription} data-settings-action="save-password" data-settings-security-primary disabled>${primaryLabel}</button>${hasLogin ? `<button class="danger-button" type="button"${dirtyDescription} data-settings-action="remove-password" data-settings-security-remove disabled>Remove password</button>` : ''}</div>
        <p class="settings-page-security-note">Password changes are independent from Config Save and sign out existing browser sessions.</p>
      </div>`;
  }

  function renderSettingsRuntimeData() {
    return `${settingsHeading('Server settings', 'Runtime Data', 'Inspect system-managed project state and recover a Runtime that cannot start safely.')}
      <div class="settings-status-card ${settingsState.runtimeDeleted ? 'neutral' : 'done'}"><span data-icon="activity"></span><div><strong>${settingsState.runtimeDeleted ? 'Runtime data removed' : 'Runtime ready'}</strong><p>${settingsState.runtimeDeleted ? 'The project source and Git repository remain unchanged.' : 'The current Runtime loaded all registered project state.'}</p></div>${settingsStatus(settingsState.runtimeDeleted ? 'Empty' : 'Ready', settingsState.runtimeDeleted ? 'neutral' : 'done')}</div>
      <article class="settings-runtime-card ${settingsState.runtimeDeleted ? 'is-disabled' : ''}"><label><input type="checkbox" data-settings-runtime-select ${settingsState.runtimeSelected ? 'checked' : ''} ${settingsState.runtimeDeleted ? 'disabled' : ''}><span><strong>ArchCode</strong><small>~/Developer/AI/archcode/.archcode/runtime</small></span></label><dl><div><dt>Files</dt><dd>${settingsState.runtimeDeleted ? '0' : '148'}</dd></div><div><dt>Size</dt><dd>${settingsState.runtimeDeleted ? '0 B' : '18.4 MB'}</dd></div><div><dt>Inspection</dt><dd>${settingsState.runtimeDeleted ? 'No data' : '1 recoverable issue'}</dd></div></dl>${settingsState.runtimeDeleted ? '' : '<p><span data-icon="alert"></span><strong>sessions/4e8b…/session.json</strong> Interrupted execution recovery is pending.</p>'}</article>
      <p class="settings-inline-message" role="status" ${settingsState.runtimeMessage ? '' : 'hidden'}>${escapePrototypeHtml(settingsState.runtimeMessage)}</p>
      <div class="settings-section-actions split"><button class="quiet-button" type="button" data-settings-action="retry-runtime"><span data-icon="refresh"></span>Retry Runtime</button><button class="danger-button" type="button" data-settings-action="delete-runtime" ${!settingsState.runtimeSelected || settingsState.runtimeDeleted ? 'disabled' : ''}><span data-icon="trash"></span>Delete runtime data</button></div>`;
  }

  function renderSettingsMcp() {
    return `${settingsHeading('MCP', 'MCP servers', 'Configuration, discovery status, tools, testing, and reconnect actions stay together.')}
      <article class="settings-block settings-server-card"><header class="settings-block-head"><div><strong>context7</strong><small>Built-in · 2 tools available</small></div>${settingsStatus(settingsState.context7Enabled ? 'Ready' : 'Disabled', settingsState.context7Enabled ? 'done' : 'neutral')}</header><div class="settings-block-body">${settingsToggle('context7Enabled', settingsState.context7Enabled, 'Enable context7', 'Expose this built-in server to the live MCP runtime.')}<div class="settings-inline-actions"><button class="quiet-button" type="button" data-settings-action="test-mcp">Test draft</button><button class="quiet-button" type="button" data-settings-action="reconnect-mcp" ${settingsState.context7Enabled ? '' : 'disabled'}><span data-icon="refresh"></span>Reconnect</button><span role="status" aria-live="polite" data-settings-mcp-message>${escapePrototypeHtml(settingsState.mcpMessage)}</span></div><details class="settings-tool-list"><summary>Available tools · 2</summary><div><code>resolve-library-id</code><code>query-docs</code></div></details></div></article>
      ${settingsState.customMcp ? `<article class="settings-block settings-server-card"><header class="settings-block-head"><div><strong>local-tools</strong><small>HTTP · Custom server</small></div>${settingsStatus('Ready', 'done')}</header><div class="settings-block-body"><div class="settings-form-grid">${settingsField('HTTP URL', settingsText('mcpUrl', settingsState.mcpUrl, 'type="url"'))}${settingsField('Connection', '<div class="settings-code-field"><code>10s connect</code><code>30s discovery</code></div>')}</div><div class="settings-inline-actions"><button class="quiet-button" type="button" data-settings-action="test-mcp">Test draft</button><button class="danger-link" type="button" data-settings-action="remove-mcp">Delete server</button></div></div></article>` : ''}
      ${settingsState.extraMcp ? '<article class="settings-block settings-compact-block"><div><span>Custom server</span><strong>server-2</strong><small>HTTP · Enabled · not saved</small></div><button class="quiet-button" type="button" data-settings-action="remove-extra-mcp">Remove</button></article>' : ''}
      <button class="settings-add-row" type="button" data-settings-action="add-mcp"><span data-icon="plus"></span>Add MCP server</button>`;
  }

  function renderSettingsSkills() {
    return `${settingsHeading('Project diagnostics', 'Project Skills', 'Inspect precedence, package diagnostics, and the bounded Skill directory projected into the Prompt.')}
      <div class="settings-metric-strip"><div><span>Resolved</span><strong>7</strong></div><div><span>Prompt included</span><strong>5</strong></div><div><span>Omitted</span><strong>2</strong></div></div>
      <ul class="settings-skill-list" aria-label="Project Skill packages"><li><div><strong>ui-ux-pro-max</strong><small>UI/UX design intelligence with searchable database</small></div><span>Project .codex</span>${settingsStatus('Winner', 'done')}</li><li><div><strong>ui-ux-pro-max</strong><small>Lower-precedence package is not loaded</small></div><span>User .codex</span>${settingsStatus('Shadowed', 'neutral')}</li><li><div><strong>orchestrate-work</strong><small>Root Lead orchestration lifecycle</small></div><span>Built-in</span>${settingsStatus('Valid', 'done')}</li><li><div><strong>legacy-review</strong><small>Missing required SKILL.md frontmatter</small></div><span>Project .agents</span>${settingsStatus('Invalid', 'error')}</li></ul>
      <p class="settings-footnote"><span data-icon="eye"></span>Skills are read-only diagnostics here. This surface never enables, disables, or grants Agent permissions.</p>`;
  }

  function renderSettingsMemory() {
    return `${settingsHeading('Memory', 'Durable project context', 'Configure prompt injection and manage explicit project Memory without hiding conflicts.')}
      <div class="settings-toggle-card">${settingsToggle('useMemory', settingsState.useMemory, 'Use Memory', 'Inject complete preferences and the current project index into new Execution prompts.')}${settingsToggle('autoLearning', settingsState.autoLearning, 'Auto learning', 'After successful root work is idle for 10 minutes, extract durable Memory in the background.')}</div>
      <article class="settings-editor-card"><header><div><strong>Personal Memory</strong><small>preferences.md · 86 / 8192 bytes</small></div><button class="danger-link" type="button" data-settings-action="clear-memory">Clear</button></header><textarea rows="3" aria-label="Personal Memory" data-settings-memory="personal">${escapePrototypeHtml(settingsState.personalMemory)}</textarea><div class="settings-inline-actions"><button class="quiet-button" type="button" data-settings-action="save-memory">Save Personal Memory</button><button class="quiet-button" type="button" data-settings-action="reload-memory">Reload</button><span role="status" aria-live="polite">${escapePrototypeHtml(settingsState.memoryMessage)}</span></div></article>
      <article class="settings-editor-card"><header><div><strong>Project knowledge</strong><small>1 / 200 topics</small></div><button class="quiet-button" type="button" data-settings-action="new-memory-topic"><span data-icon="plus"></span>New topic</button></header><div class="settings-form-grid">${settingsField('Topic name', `<input value="${escapePrototypeHtml(settingsState.topicName)}" pattern="[a-z0-9-]+" data-settings-memory-topic="topicName">`)}${settingsField('Title', `<input value="${escapePrototypeHtml(settingsState.topicTitle)}" data-settings-memory-topic="topicTitle">`)}</div><label class="settings-field"><span>Content</span><textarea rows="3" data-settings-memory-topic="topicContent">${escapePrototypeHtml(settingsState.topicContent)}</textarea></label><div class="settings-inline-actions"><button class="quiet-button" type="button" data-settings-action="save-memory-topic">Save topic</button><button class="quiet-button" type="button" data-settings-action="reload-memory-topic">Reload</button>${settingsState.topicIsNew ? '' : '<button class="danger-link" type="button" data-settings-action="delete-memory-topic">Delete topic</button>'}<span role="status" aria-live="polite">${escapePrototypeHtml(settingsState.topicMessage)}</span></div></article>`;
  }

  function renderSettingsGithub() {
    return `${settingsHeading('Integrations', 'GitHub', 'Optional GitHub integration settings for repository operations.')}
      <div class="settings-toggle-card">${settingsToggle('githubEnabled', settingsState.githubEnabled, 'GitHub integration', 'Expose configured GitHub repository operations to supported Agents.')}</div>
      <div class="settings-block-body settings-plain-card"><div class="settings-form-grid">${settingsField('Token environment variable', settingsText('githubTokenEnv', settingsState.githubTokenEnv))}${settingsField('Default owner', settingsText('githubOwner', settingsState.githubOwner, 'placeholder="openai"'))}${settingsField('Default repository', settingsText('githubRepo', settingsState.githubRepo, 'placeholder="archcode"'))}</div><p class="settings-footnote"><span data-icon="shield"></span>The token value stays in the server environment; Settings stores only the variable name.</p></div>`;
  }

  function renderSettingsUpdates() {
    const available = settingsState.updatePhase === 'available';
    const installed = settingsState.updatePhase === 'installed';
    const restarting = settingsState.updatePhase === 'restarting';
    return `${settingsHeading('Application', 'About & Updates', 'Inspect the installed build and apply a verified managed update.')}
      <div class="settings-status-card done"><span data-icon="check"></span><div><strong>ArchCode v0.0.5</strong><p>Managed installation · Stable channel · Verification ready</p></div>${settingsStatus(restarting ? 'Restart queued' : installed ? 'Installed' : available ? 'Update available' : 'Up to date', restarting || installed || available ? 'attention' : 'done')}</div>
      <dl class="settings-about-list"><div><dt>Executable</dt><dd>~/.local/bin/archcode</dd></div><div><dt>Release channel</dt><dd>Stable</dd></div><div><dt>Update integrity</dt><dd>Manifest v3 · Sigstore attestation</dd></div></dl>
      <div class="settings-update-callout"><div><strong>${available || installed || restarting ? 'ArchCode v0.0.6' : 'No update available'}</strong><p>${available ? 'The signed release is ready to download and install.' : installed ? 'Installation completed. Restart to run the new build.' : restarting ? 'The server will restart after active requests settle.' : 'You are running the latest verified stable release.'}</p></div><div>${available ? '<button class="primary-button" type="button" data-settings-action="install-update">Install update</button>' : installed ? '<button class="primary-button" type="button" data-settings-action="restart-update">Restart now</button>' : restarting ? '' : '<button class="quiet-button" type="button" data-settings-action="check-update"><span data-icon="refresh"></span>Check now</button>'}</div></div>`;
  }

  const settingsRenderers = {
    models: renderSettingsModels,
    profiles: renderSettingsProfiles,
    security: renderSettingsSecurity,
    'runtime-data': renderSettingsRuntimeData,
    mcp: renderSettingsMcp,
    skills: renderSettingsSkills,
    memory: renderSettingsMemory,
    github: renderSettingsGithub,
    updates: renderSettingsUpdates,
  };

  function updateSettingsBinding(path, value) {
    const parts = path.split('.');
    let target = settingsState;
    while (parts.length > 1) target = target[parts.shift()];
    target[parts[0]] = value;
    const section = settingsState.section;
    if (settingsConfigSections.has(section)) settingsState.dirtySections.add(section);
    settingsState.notice = '';
    syncSettingsFooter();
  }

  function syncSettingsFooter() {
    if (!settingsFooter) return;
    const independent = settingsState.section === 'runtime-data' || settingsState.section === 'updates';
    settingsFooter.hidden = independent;
    if (independent) return;
    const dirty = settingsState.dirtySections.size > 0;
    const pending = Boolean(settingsState.passwordMutationPending);
    const invalidJson = Object.values(settingsState.jsonErrors).some(Boolean);
    const invalidProfiles = Object.values(settingsState.profiles).some((profile) => settingsState.providerRemoved
      || (profile.model === 'openai:model-2' && !settingsState.extraModel)
      || !['openai:gpt-5.6-luna', 'openai:model-2'].includes(profile.model));
    const status = settingsFooter.querySelector('[data-settings-save-state]');
    const save = settingsFooter.querySelector('[data-settings-action="save"]');
    if (status) {
      status.textContent = invalidJson ? 'Fix JSON errors' : invalidProfiles ? 'Repair Profile bindings' : dirty ? 'Unsaved changes' : 'All changes saved';
      status.classList.toggle('attention', dirty && !invalidProfiles && !invalidJson);
      status.classList.toggle('error', invalidProfiles || invalidJson);
    }
    if (save) save.disabled = pending || !dirty || invalidProfiles || invalidJson;
    const reload = settingsFooter.querySelector('[data-settings-action="reload"]');
    if (reload) reload.disabled = pending;
  }

  function syncSettingsInteractionLock() {
    if (!settingsDialog) return;
    const locked = Boolean(settingsState.passwordMutationPending);
    settingsDialog.querySelectorAll('[data-settings-section], [data-settings-panel] input, [data-settings-panel] select, [data-settings-panel] textarea, [data-settings-panel] button, [data-settings-footer] button').forEach((control) => {
      if (!locked) {
        if (control.dataset.settingsLockDisabled !== undefined) {
          control.disabled = control.dataset.settingsLockDisabled === 'true';
          delete control.dataset.settingsLockDisabled;
        }
        return;
      }
      if (control.dataset.settingsLockDisabled === undefined) control.dataset.settingsLockDisabled = String(control.disabled);
      control.disabled = true;
    });
  }

  function syncSettingsProfileAttention() {
    const button = settingsDialog?.querySelector('[data-settings-section="profiles"]');
    if (!button) return;
    const count = settingsMissingVariantCount();
    button.toggleAttribute('data-invalid-count', count > 0);
    if (count > 0) {
      button.dataset.invalidCount = String(count);
      button.setAttribute('aria-label', `Profiles, ${count} variant ${count === 1 ? 'reference needs' : 'references need'} attention`);
    } else {
      button.removeAttribute('data-invalid-count');
      button.removeAttribute('aria-label');
    }
  }

  function renderSettings() {
    if (!settingsPanel) return;
    settingsDialog.querySelectorAll('[data-settings-section]').forEach((button) => {
      const selected = button.dataset.settingsSection === settingsState.section;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    settingsPanel.innerHTML = (settingsRenderers[settingsState.section] || renderSettingsModels)();
    settingsNotice.hidden = !settingsState.notice;
    settingsNotice.textContent = settingsState.notice;
    settingsNotice.className = `settings-apply-notice${settingsState.notice.includes('failed') ? ' error' : ''}`;
    syncSettingsFooter();
    syncSettingsProfileAttention();
    renderIcons(settingsPanel);
    syncSettingsInteractionLock();
    syncSettingsSecurityControls();
  }

  function syncSettingsSecurityControls() {
    if (settingsState.section !== 'security' || !settingsPanel) return;
    const currentInput = settingsPanel.querySelector('[data-settings-security="current"]');
    const passwordInput = settingsPanel.querySelector('[data-settings-security="password"]');
    const confirmationInput = settingsPanel.querySelector('[data-settings-security="confirmation"]');
    const current = settingsState.securityCurrentPassword;
    const password = settingsState.securityPassword;
    const confirmation = settingsState.securityConfirmation;
    if (currentInput && currentInput.value !== current) currentInput.value = current;
    if (passwordInput && passwordInput.value !== password) passwordInput.value = password;
    if (confirmationInput && confirmationInput.value !== confirmation) confirmationInput.value = confirmation;
    const message = settingsPanel.querySelector('[data-settings-inline-message]');
    const dirtyHint = settingsPanel.querySelector('[data-settings-security-dirty-hint]');
    const pendingHint = settingsPanel.querySelector('[data-settings-security-pending-hint]');
    const errorNode = settingsPanel.querySelector('[data-settings-security-error]');
    const primary = settingsPanel.querySelector('[data-settings-security-primary]');
    const remove = settingsPanel.querySelector('[data-settings-security-remove]');
    const passwordError = settingsPasswordError();
    const currentTooLong = settingsPasswordBytes(current) > 1024;
    const dirty = settingsState.dirtySections.size > 0;
    const pending = Boolean(settingsState.passwordMutationPending);
    if (dirtyHint) dirtyHint.hidden = !dirty || pending;
    if (pendingHint) pendingHint.hidden = !pending;
    if (message) {
      message.textContent = settingsState.securityMessage;
      message.hidden = !settingsState.securityMessage || Boolean(passwordError);
    }
    if (errorNode) {
      errorNode.textContent = passwordError;
      errorNode.hidden = !passwordError;
    }
    if (primary) {
      primary.disabled = pending || dirty || !settingsPasswordValid();
      primary.textContent = pending ? (settingsState.passwordMutationPending === 'remove' ? 'Removing…' : 'Saving…') : settingsState.loginEnabled ? 'Change password' : 'Enable login';
    }
    if (remove) {
      remove.disabled = pending || dirty || !current || currentTooLong;
      remove.textContent = pending && settingsState.passwordMutationPending === 'remove' ? 'Removing…' : 'Remove password';
    }
    syncSettingsInteractionLock();
    syncSettingsFooter();
  }

  function startSettingsPasswordMutation(action) {
    window.clearTimeout(settingsPasswordTimer);
    settingsState.passwordMutationPending = action;
    settingsState.securityAttempted = false;
    settingsState.securityMessage = '';
    renderSettings();
    settingsPasswordTimer = window.setTimeout(() => {
      settingsPasswordTimer = undefined;
      settingsState.passwordMutationPending = undefined;
      settingsState.loginEnabled = action !== 'remove';
      resetSettingsPasswordDraft();
      settingsState.securityMessage = settingsDialog?.open === false ? '' : action === 'remove'
        ? 'Login removed. Anyone who can reach the server can now control ArchCode.'
        : action === 'set'
          ? 'Login enabled. A password is now required.'
          : 'Password changed. Existing browser sessions were signed out.';
      renderSettings();
    }, 450);
  }

  function markSettingsDirty(section = settingsState.section) {
    if (settingsConfigSections.has(section)) settingsState.dirtySections.add(section);
    settingsState.notice = '';
    syncSettingsFooter();
  }

  function restoreSettingsDraft({ announce = false, memory = false } = {}) {
    Object.assign(settingsState, structuredClone(savedSettingsConfig));
    settingsState.jsonErrors = {};
    if (memory) Object.assign(settingsState, structuredClone(savedSettingsMemory));
    settingsState.dirtySections.clear();
    settingsState.memoryMessage = '';
    settingsState.topicMessage = '';
    settingsState.notice = announce ? 'Latest server configuration reloaded.' : '';
  }

  function openSettingsConfirmation(action, title, copy, body, label) {
    settingsPendingConfirmation = action;
    settingsConfirmationOrigin = document.activeElement;
    settingsConfirmDialog.querySelector('[data-settings-confirm-title]').textContent = title;
    settingsConfirmDialog.querySelector('[data-settings-confirm-copy]').textContent = copy;
    settingsConfirmDialog.querySelector('[data-settings-confirm-body]').innerHTML = body;
    settingsConfirmDialog.querySelector('[data-settings-confirm-accept]').textContent = label;
    settingsConfirmDialog.showModal();
  }

  settingsDialog?.addEventListener('click', (event) => {
    if (event.target === settingsDialog) return settingsDialog.close();
    const sectionButton = event.target.closest('[data-settings-section]');
    if (sectionButton) {
      if (settingsState.passwordMutationPending) return;
      settingsState.section = sectionButton.dataset.settingsSection;
      renderSettings();
      settingsPanel.scrollTop = 0;
      requestAnimationFrame(() => settingsPanel.querySelector('h3')?.focus());
      return;
    }
    const actionButton = event.target.closest('[data-settings-action]');
    if (!actionButton || actionButton.disabled) return;
    const action = actionButton.dataset.settingsAction;
    if (action === 'add-provider') {
      if (settingsState.providerRemoved) settingsState.providerRemoved = false;
      else settingsState.extraProvider = true;
      markSettingsDirty('models');
      renderSettings();
    }
    if (action === 'remove-extra-provider') { settingsState.extraProvider = false; markSettingsDirty('models'); renderSettings(); }
    if (action === 'add-model') { settingsState.extraModel = true; markSettingsDirty('models'); renderSettings(); }
    if (action === 'remove-extra-model') { settingsState.extraModel = false; markSettingsDirty('models'); renderSettings(); }
    if (action === 'replace-secret') { actionButton.closest('.settings-secret').innerHTML = '<input type="password" aria-label="Replacement API key" placeholder="Enter replacement secret" data-settings-bind="replacementSecret">'; markSettingsDirty('models'); }
    if (action === 'remove-provider') openSettingsConfirmation('remove-provider', 'Remove provider?', 'Profile bindings may need repair before the configuration can be saved.', '<p><strong>openai</strong> and its configured models will be removed from this draft.</p>', 'Remove provider');
    if (action === 'save-password') {
      if (settingsState.dirtySections.size > 0 || settingsState.passwordMutationPending) return;
      if (!settingsPasswordValid()) {
        settingsState.securityAttempted = true;
        syncSettingsSecurityControls();
        return;
      }
      startSettingsPasswordMutation(settingsState.loginEnabled ? 'change' : 'set');
    }
    if (action === 'remove-password') {
      if (settingsState.dirtySections.size > 0 || settingsState.passwordMutationPending) return;
      if (!settingsState.securityCurrentPassword || settingsPasswordBytes(settingsState.securityCurrentPassword) > 1024) {
        settingsState.securityAttempted = true;
        syncSettingsSecurityControls();
        return;
      }
      startSettingsPasswordMutation('remove');
    }
    if (action === 'retry-runtime') { settingsState.runtimeMessage = settingsState.runtimeDeleted ? 'Runtime has no project state to load.' : 'Runtime retry completed. The current state is ready.'; renderSettings(); }
    if (action === 'delete-runtime') openSettingsConfirmation('delete-runtime', 'Delete selected Runtime data?', 'This action is permanent and affects only the selected project Runtime directories.', '<ul><li><strong>ArchCode</strong> · ~/Developer/AI/archcode/.archcode/runtime</li></ul><p>Sessions, Todos, Automations, HITL requests, permissions, attachments, and project Memory will be removed. Source files, .git, plans, Skills, project registration, and global Config remain.</p>', 'Delete runtime data');
    if (action === 'test-mcp') { settingsState.mcpMessage = 'Draft test passed · 2 tools'; renderSettings(); }
    if (action === 'reconnect-mcp') { settingsState.mcpMessage = 'Reconnected · inventory refreshed'; renderSettings(); }
    if (action === 'add-mcp') {
      if (settingsState.customMcp) settingsState.extraMcp = true; else settingsState.customMcp = true;
      markSettingsDirty('mcp');
      renderSettings();
    }
    if (action === 'remove-mcp') { settingsState.customMcp = false; markSettingsDirty('mcp'); renderSettings(); }
    if (action === 'remove-extra-mcp') { settingsState.extraMcp = false; markSettingsDirty('mcp'); renderSettings(); }
    if (action === 'save-memory') { settingsState.personalMemory = settingsPanel.querySelector('[data-settings-memory="personal"]')?.value || ''; savedSettingsMemory = captureSettingsMemory(); settingsState.memoryMessage = 'Personal Memory saved.'; renderSettings(); }
    if (action === 'reload-memory') { settingsState.personalMemory = savedSettingsMemory.personalMemory; settingsState.memoryMessage = 'Personal Memory reloaded.'; renderSettings(); }
    if (action === 'clear-memory') openSettingsConfirmation('clear-memory', 'Clear Personal Memory?', 'The preferences document will be permanently deleted.', '<p>This does not remove project knowledge topics or disable Memory.</p>', 'Clear Personal Memory');
    if (action === 'new-memory-topic') { settingsState.topicName = ''; settingsState.topicTitle = ''; settingsState.topicContent = ''; settingsState.topicMessage = ''; settingsState.topicIsNew = true; renderSettings(); }
    if (action === 'save-memory-topic') {
      const validName = /^[a-z0-9-]+$/.test(settingsState.topicName);
      settingsState.topicMessage = validName ? 'Project topic saved.' : 'Use a lowercase topic name with letters, numbers, and hyphens.';
      if (validName) { settingsState.topicIsNew = false; savedSettingsMemory = captureSettingsMemory(); }
      renderSettings();
    }
    if (action === 'reload-memory-topic') {
      settingsState.topicName = savedSettingsMemory.topicName;
      settingsState.topicTitle = savedSettingsMemory.topicTitle;
      settingsState.topicContent = savedSettingsMemory.topicContent;
      settingsState.topicIsNew = savedSettingsMemory.topicIsNew;
      settingsState.topicMessage = 'Project topic reloaded.';
      renderSettings();
    }
    if (action === 'delete-memory-topic') openSettingsConfirmation('delete-memory-topic', 'Delete project topic?', 'This topic will be permanently removed from project Memory.', `<p><strong>${escapePrototypeHtml(settingsState.topicName)}</strong> cannot be recovered.</p>`, 'Delete topic');
    if (action === 'check-update') { settingsState.updatePhase = 'available'; renderSettings(); }
    if (action === 'install-update') { settingsState.updatePhase = 'installed'; renderSettings(); }
    if (action === 'restart-update') { settingsState.updatePhase = 'restarting'; renderSettings(); }
    if (action === 'reload') {
      restoreSettingsDraft({ announce: true });
      renderSettings();
    }
    if (action === 'save') {
      const changed = new Set(settingsState.dirtySections);
      settingsState.dirtySections.clear();
      const messages = [];
      if (changed.has('models') || changed.has('profiles')) messages.push('Model and Profile changes applied live.');
      if (changed.has('security')) messages.push('AI approval review saved and will apply live.');
      if (changed.has('github')) messages.push('Restart required for: GitHub.');
      if (changed.has('mcp')) messages.push('Configuration saved; MCP draft applied to the live Runtime.');
      if (changed.has('memory')) messages.push('Memory configuration saved.');
      savedSettingsConfig = captureSettingsConfig();
      settingsState.notice = messages.join(' ') || 'Configuration saved.';
      renderSettings();
    }
  });
  settingsDialog?.addEventListener('input', (event) => {
    const jsonControl = event.target.closest('[data-settings-json]');
    if (jsonControl) {
      const binding = jsonControl.dataset.settingsJson;
      const raw = jsonControl.value;
      let error = '';
      let parsed;
      if (raw.trim()) {
        try {
          parsed = JSON.parse(raw);
          if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Must be a JSON object.');
          if (binding === 'modelVariants' && Object.values(parsed).some((value) => !value || Array.isArray(value) || typeof value !== 'object')) throw new Error('Each Variant must map to an options object.');
        } catch (cause) {
          error = cause instanceof Error ? cause.message : 'Must be a JSON object.';
        }
      }
      settingsState.jsonErrors[binding] = error;
      const errorNode = jsonControl.closest('.settings-json-field')?.querySelector('[data-settings-json-error]');
      if (errorNode) {
        errorNode.textContent = error;
        errorNode.hidden = !error;
      }
      jsonControl.toggleAttribute('aria-invalid', Boolean(error));
      if (error) {
        settingsState.dirtySections.add(settingsState.section);
        settingsState.notice = '';
        syncSettingsFooter();
        return;
      }
      updateSettingsBinding(binding, raw.trim() ? parsed : undefined);
      if (binding === 'modelVariants') syncSettingsProfileAttention();
      return;
    }
    const securityControl = event.target.closest('[data-settings-security]');
    if (securityControl) {
      const binding = securityControl.dataset.settingsSecurity;
      const stateKey = binding === 'current' ? 'securityCurrentPassword' : binding === 'password' ? 'securityPassword' : binding === 'confirmation' ? 'securityConfirmation' : undefined;
      if (stateKey) settingsState[stateKey] = securityControl.value;
      settingsState.securityAttempted = false;
      settingsState.securityMessage = '';
      syncSettingsSecurityControls();
      return;
    }
    const topicControl = event.target.closest('[data-settings-memory-topic]');
    if (topicControl) {
      settingsState[topicControl.dataset.settingsMemoryTopic] = topicControl.value;
      return;
    }
    const control = event.target.closest('[data-settings-bind]');
    if (!control) return;
    const value = control.type === 'checkbox' ? control.checked : control.value;
    const profileBinding = control.dataset.settingsBind.match(/^profiles\.(principal|deep|fast)\.(model|variant)$/);
    if (profileBinding) {
      const [, profileName, field] = profileBinding;
      updateSettingsBinding(control.dataset.settingsBind, field === 'variant' ? value || undefined : value);
      const profile = settingsState.profiles[profileName];
      const disclosure = control.closest('.settings-profile-disclosure');
      if (field === 'model') {
        profile.variant = undefined;
        const variantSelect = disclosure?.querySelector(`[data-settings-bind="profiles.${profileName}.variant"]`);
        if (variantSelect) {
          variantSelect.innerHTML = `<option value="">Default</option>${settingsVariantKeysForModel(value).map((variant) => `<option value="${escapePrototypeHtml(variant)}">${escapePrototypeHtml(variant)}</option>`).join('')}`;
          variantSelect.value = '';
          variantSelect.removeAttribute('aria-invalid');
          variantSelect.parentElement?.querySelector('small[role="alert"]')?.remove();
        }
      }
      const modelMissing = settingsState.providerRemoved || (profile.model === 'openai:model-2' && !settingsState.extraModel);
      const variantMissing = !modelMissing && Boolean(profile.variant) && !settingsVariantKeysForModel(profile.model).includes(profile.variant);
      disclosure?.classList.toggle('attention', modelMissing || variantMissing);
      const summary = disclosure?.querySelector('summary');
      const summaryCopy = summary?.querySelector(':scope > small');
      if (summaryCopy) summaryCopy.textContent = `${profile.model} · ${profile.variant || 'Default'}`;
      if (summary) summary.setAttribute('aria-label', `${profileName}, ${profile.model}${profile.variant ? `, ${profile.variant}` : ', Default'}`);
      syncSettingsProfileAttention();
      syncSettingsFooter();
      return;
    }
    updateSettingsBinding(control.dataset.settingsBind, value);
    if (control.dataset.settingsBind === 'providerPackage') {
      const summary = control.closest('.settings-block')?.querySelector('.settings-block-head small');
      if (summary) summary.textContent = value;
    }
    if (control.dataset.settingsBind === 'modelName') {
      const summary = control.closest('.settings-disclosure')?.querySelector('summary small');
      if (summary) summary.textContent = value;
    }
    if (control.type === 'checkbox') renderSettings();
  });
  settingsDialog?.addEventListener('change', (event) => {
    const runtime = event.target.closest('[data-settings-runtime-select]');
    if (!runtime) return;
    settingsState.runtimeSelected = runtime.checked;
    renderSettings();
  });
  settingsConfirmDialog?.querySelectorAll('[data-settings-confirm-cancel]').forEach((button) => button.addEventListener('click', () => settingsConfirmDialog.close()));
  settingsConfirmDialog?.addEventListener('click', (event) => { if (event.target === settingsConfirmDialog) settingsConfirmDialog.close(); });
  settingsConfirmDialog?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    settingsConfirmDialog.close();
  });
  settingsConfirmDialog?.addEventListener('close', () => {
    settingsConfirmationOrigin?.focus();
    settingsConfirmationOrigin = undefined;
  });
  settingsConfirmDialog?.querySelector('[data-settings-confirm-accept]')?.addEventListener('click', () => {
    if (settingsPendingConfirmation === 'delete-runtime') {
      settingsState.runtimeDeleted = true;
      settingsState.runtimeSelected = false;
      settingsState.runtimeMessage = 'Selected Runtime data was deleted. Source files and Git data were preserved.';
    }
    if (settingsPendingConfirmation === 'clear-memory') {
      settingsState.personalMemory = '';
      settingsState.memoryMessage = 'Personal Memory cleared.';
      savedSettingsMemory = captureSettingsMemory();
    }
    if (settingsPendingConfirmation === 'delete-memory-topic') {
      settingsState.topicName = '';
      settingsState.topicTitle = '';
      settingsState.topicContent = '';
      settingsState.topicIsNew = true;
      settingsState.topicMessage = 'Project topic deleted.';
      savedSettingsMemory = captureSettingsMemory();
    }
    if (settingsPendingConfirmation === 'remove-provider') {
      settingsState.providerRemoved = true;
      settingsState.extraModel = false;
      markSettingsDirty('models');
      settingsState.notice = 'Provider removed from the draft. Repair Profile bindings before saving.';
    }
    settingsPendingConfirmation = undefined;
    settingsConfirmDialog.close();
    renderSettings();
  });
  const openSettingsButtons = [...document.querySelectorAll('[data-open-settings]')];
  openSettingsButtons.forEach((button) => button.addEventListener('click', () => {
    settingsOrigin = button;
    resetSettingsPasswordDraft();
    settingsState.securityMessage = '';
    settingsState.section = 'models';
    renderSettings();
    settingsPanel.scrollTop = 0;
    settingsDialog?.showModal();
    requestAnimationFrame(() => settingsPanel?.querySelector('h3')?.focus());
  }));
  document.querySelectorAll('[data-settings-dialog-close]').forEach((button) => button.addEventListener('click', () => settingsDialog?.close()));
  settingsDialog?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || settingsConfirmDialog?.open) return;
    event.preventDefault();
    settingsDialog.close();
  });
  settingsDialog?.addEventListener('close', () => {
    restoreSettingsDraft({ memory: true });
    resetSettingsPasswordDraft();
    settingsState.securityMessage = '';
    settingsState.section = 'models';
    settingsOrigin?.focus();
  });
  renderSettings();
  document.addEventListener('click', (event) => {
    if (event.target.closest('.notification-popover')) return;
    document.querySelectorAll('.notification-popover.open').forEach((popover) => {
      popover.classList.remove('open');
      popover.inert = true;
      popover.setAttribute('aria-hidden', 'true');
    });
    document.querySelectorAll('[data-notification-toggle]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  });

  document.querySelectorAll('[data-panel-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.panelTarget;
      const controlScope = button.closest('[data-panel-scope]') || document;
      const panelScope = controlScope.classList?.contains('workspace-subnav')
        ? document.querySelector('.workbench')
        : controlScope;
      controlScope.querySelectorAll('[data-panel-target]').forEach((item) => {
        const selected = item === button;
        item.classList.toggle('active', selected);
        if (item.getAttribute('role') === 'tab') {
          item.setAttribute('aria-selected', String(selected));
          item.tabIndex = selected ? 0 : -1;
        }
      });
      panelScope?.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== value; });
    });
  });

  const todoActiveLayout = document.querySelector('#todo-active-layout');
  const prototypeStableIds = new Map([
    ['Model profile defaults per project', '4e8b1d3a-2f9c-4a67-a1cd-825da20d2e6b'],
    ['Add a durable permission audit trail', '71d9e732-30fe-45be-b6d0-b3d63f4b4f1a'],
    ['Choose the recovery policy for interrupted runs', '5fb385a9-bf5a-47fe-875e-6be0a3ae15cc'],
    ['Review the Todo → Run handoff contract', 'a35b55dc-acde-46bb-9c1d-99adbe3c674b'],
    ['Compare memory snapshots between runs', 'c12a874a-3314-42ea-9bf0-8ad11c97b8aa'],
    ['Export a Todo with its complete run history', '540260e8-b2b7-43c4-a3dd-09f8dc3053c3'],
    ['Show project registry drift before open', 'd1be27aa-6870-4980-ae48-6a55e81aa0d0'],
    ['Expose workspace health before bootstrap', '4ee07de6-3f09-4c11-8877-89ef20f2be31'],
    ['Make tool output recovery inspectable', '9fc4e658-4919-4993-9382-b3ad5594b10e'],
    ['Recover remote projects after cold start', '01eac930-5138-4aa2-868e-40e6c72665c7'],
    ['Recover interrupted Sessions after restart', '1cbdaeca-d8a0-4748-b801-c39b87d60e10'],
    ['Bind Automation invocations to durable Sessions', 'b62bc183-acde-43ba-9b0e-588fabf09148'],
    ['Recovery verification', '3ae77f76-0a63-42f4-85db-53ec65c02cec'],
    ['Handoff recommendation', '5fc7c775-82fa-4ca3-b17e-c8dd8d25bd1d'],
    ['Preserve approval state after restart', '7c6cc655-1d3e-4c4f-9368-9014460322df'],
    ['Audit trail implementation', 'aa791c87-edc8-47a7-b64c-bd68215f148d'],
    ['Profile validation sweep', '5ed67823-cf0e-4690-a7c4-f4c7bd53e5e9'],
    ['Weekly memory quality review', 'd36a4b01-1903-48b5-91d0-11b75743e480'],
    ['Release readiness sweep', '9e4a9d62-ee8b-4c3d-bc9c-520c0b53986e'],
    ['Nightly UI snapshot review', '483de6f3-bad5-477e-9a77-ed08dd82b0f4'],
    ['Dependency license scan', '14ef653e-3b1e-4b07-a4b4-2a1cb71bcbb2'],
    ['Legacy provider compatibility check', '72166b7f-e65a-49da-aeb2-0b16c347c791'],
  ]);
  document.querySelectorAll('.todo-filter-item,.run-filter-item,.schedule-filter-item').forEach((row) => {
    const title = row.querySelector('strong')?.textContent.trim();
    if (title && prototypeStableIds.has(title)) row.dataset.stableId = prototypeStableIds.get(title);
  });
  const todoFilterInput = document.querySelector('.page-todos [data-filter-input]');
  const todoFixtureSample = new URLSearchParams(location.search).get('sample');
  const todoFirstUse = document.querySelector('[data-todo-first-use]');
  const todoFilterEmpty = document.querySelector('[data-todo-filter-empty]');
  const todoLifecycleLabel = (container) => {
    return container.querySelector('.group-heading span')?.textContent.trim() || 'this group';
  };
  todoActiveLayout?.querySelectorAll('[data-view-panel="list"] .work-group').forEach((container) => {
    const host = container.querySelector('.work-list');
    if (!host || host.querySelector(':scope > [data-group-empty]')) return;
    const empty = document.createElement('p');
    empty.className = 'group-empty';
    empty.dataset.groupEmpty = '';
    empty.hidden = true;
    host.appendChild(empty);
  });
  const todoRowSuppressedByFixture = (row) => {
    if (todoFixtureSample === 'first-use') return true;
    if (todoFixtureSample !== 'group-empty') return false;
    return row.closest('.work-group')?.dataset.todoStage === 'ready';
  };
  const todoCanonicalRows = () => [
    ...document.querySelectorAll('.page-todos [data-surface-panel="active"] [data-view-panel="list"] .todo-filter-item'),
    ...document.querySelectorAll('.page-todos [data-surface-panel="rejected"] .todo-filter-item,.page-todos [data-surface-panel="archived"] .todo-filter-item'),
  ].filter((row) => !todoRowSuppressedByFixture(row));
  function syncTodoFilterProjection() {
    if (!todoActiveLayout) return;
    const query = todoFilterInput?.value.trim().toLocaleLowerCase() || '';
    document.querySelectorAll('.page-todos .todo-filter-item').forEach((row) => {
      const searchText = `${row.dataset.filterText || ''} ${row.dataset.stableId || ''} ${row.textContent}`.toLocaleLowerCase();
      row.hidden = todoRowSuppressedByFixture(row) || Boolean(query && !searchText.includes(query));
    });
    const canonicalRows = todoCanonicalRows();
    const firstUse = canonicalRows.length === 0;
    const activeCanonicalCount = [...document.querySelectorAll('.page-todos [data-surface-panel="active"] [data-view-panel="list"] .todo-filter-item')]
      .filter((row) => !todoRowSuppressedByFixture(row)).length;
    const canvasCount = document.querySelector('.page-todos .object-title .count-pill');
    const navigatorCount = document.querySelector('.page-todos .nav-row[href="./todos.html"] b');
    if (canvasCount) canvasCount.textContent = String(activeCanonicalCount);
    if (navigatorCount) navigatorCount.textContent = String(activeCanonicalCount);
    document.querySelectorAll('.page-todos .todo-nav .nav-section').forEach((section) => {
      const label = section.querySelector('.nav-section-title span')?.textContent.trim();
      const lifecycleSection = ['Needs you', 'In progress', 'Ready'].includes(label);
      section.hidden = lifecycleSection && (firstUse || (todoFixtureSample === 'group-empty' && label === 'Ready'));
    });
    const selectedSurface = document.querySelector('.page-todos [data-surface].active')?.dataset.surface || 'active';
    const activeList = todoActiveLayout.querySelector('[data-view-panel="list"]');
    const activeVisibleCount = activeList?.querySelectorAll('.todo-filter-item:not([hidden])').length || 0;
    const activeFilterNoResults = selectedSurface === 'active' && !firstUse && Boolean(query) && activeVisibleCount === 0;
    if (todoFirstUse) todoFirstUse.hidden = !(selectedSurface === 'active' && firstUse);
    if (todoFilterEmpty) {
      todoFilterEmpty.hidden = !activeFilterNoResults;
      const reason = todoFilterEmpty.querySelector('[data-todo-filter-reason]');
      if (reason) reason.textContent = `No Todos match “${todoFilterInput.value.trim()}”. Try another phrase or stable ID.`;
    }
    if (activeList) activeList.hidden = firstUse || activeFilterNoResults;
    todoActiveLayout.querySelectorAll('[data-view-panel="list"] .work-group').forEach((group) => {
      const visibleCount = group.querySelectorAll('.todo-filter-item:not([hidden])').length;
      const canonicalCount = [...group.querySelectorAll('.todo-filter-item')].filter((row) => !todoRowSuppressedByFixture(row)).length;
      group.hidden = firstUse || activeFilterNoResults;
      const count = group.querySelector('.group-heading b');
      if (count) count.textContent = String(visibleCount);
      const empty = group.querySelector('[data-group-empty]');
      if (empty) {
        empty.hidden = firstUse || activeFilterNoResults || visibleCount > 0;
        empty.textContent = query && canonicalCount > 0
          ? `No matching Todos in ${todoLifecycleLabel(group)}.`
          : `No Todos in ${todoLifecycleLabel(group)}.`;
      }
    });
    document.querySelectorAll('.page-todos [data-surface-panel="rejected"],.page-todos [data-surface-panel="archived"]').forEach((panel) => {
      const empty = panel.querySelector('[data-surface-filter-empty]');
      const rows = [...panel.querySelectorAll('.todo-filter-item')].filter((row) => !todoRowSuppressedByFixture(row));
      const visibleCount = panel.querySelectorAll('.todo-filter-item:not([hidden])').length;
      const noResults = Boolean(query) && visibleCount === 0;
      const group = panel.querySelector('.work-group');
      if (group) group.hidden = rows.length === 0 || noResults;
      if (!empty) return;
      empty.hidden = panel.hidden || (rows.length > 0 && !noResults);
      const surface = panel.dataset.surfacePanel;
      const title = empty.querySelector('strong');
      const reason = empty.querySelector('[data-todo-filter-reason]');
      const reset = empty.querySelector('[data-todo-filter-reset]');
      if (noResults) {
        if (title) title.textContent = 'No matching Todos';
        if (reason) reason.textContent = `No ${surface} Todos match “${todoFilterInput.value.trim()}”.`;
        if (reset) reset.hidden = false;
      } else {
        if (title) title.textContent = `No ${surface} Todos`;
        if (reason) reason.textContent = `${surface[0].toUpperCase() + surface.slice(1)} Todos remain available here when present.`;
        if (reset) reset.hidden = true;
      }
    });
  }
  window.syncPrototypeTodoFilter = syncTodoFilterProjection;

  document.querySelectorAll('[data-filter-input]').forEach((input) => {
    input.addEventListener('input', syncTodoFilterProjection);
  });
  document.querySelectorAll('[data-todo-filter-reset]').forEach((button) => button.addEventListener('click', () => {
    if (todoFilterInput) todoFilterInput.value = '';
    syncTodoFilterProjection();
    todoFilterInput?.focus();
  }));
  if (todoFilterInput && todoFixtureSample === 'filter-empty') todoFilterInput.value = 'no matching stable id';
  syncTodoFilterProjection();

  const runFilter = document.querySelector('[data-run-filter]');
  const sourceFilter = document.querySelector('[data-source-filter]');
  const sourceFilterShell = document.querySelector('[data-source-filter-shell]');
  const sourceFilterMenu = document.querySelector('[data-source-filter-menu]');
  const sourceFilterLabel = document.querySelector('[data-source-filter-label]');
  const sourceOptions = [...document.querySelectorAll('[data-source-option]')];
  const runFixtureSample = new URLSearchParams(location.search).get('sample');
  function closeSourceFilter({ restoreFocus = false } = {}) {
    if (!sourceFilterMenu || !sourceFilter) return;
    sourceFilterMenu.hidden = true;
    sourceFilter.setAttribute('aria-expanded', 'false');
    if (restoreFocus) sourceFilter.focus();
  }
  function openSourceFilter({ edge = 'selected' } = {}) {
    if (!sourceFilterMenu || !sourceFilter || sourceOptions.length === 0) return;
    sourceFilterMenu.hidden = false;
    sourceFilter.setAttribute('aria-expanded', 'true');
    const selectedIndex = Math.max(0, sourceOptions.findIndex((option) => option.getAttribute('aria-selected') === 'true'));
    const target = edge === 'first'
      ? sourceOptions[0]
      : edge === 'last'
        ? sourceOptions.at(-1)
        : sourceOptions[selectedIndex];
    requestAnimationFrame(() => target?.focus());
  }
  function setSourceFilter(value, { sync = true, restoreFocus = true } = {}) {
    if (!sourceFilter) return;
    const selected = sourceOptions.find((option) => option.dataset.sourceOption === value) || sourceOptions[0];
    const selectedValue = selected?.dataset.sourceOption || 'all';
    const selectedLabel = selected?.querySelector('[data-source-option-label]')?.textContent.trim() || 'All sources';
    sourceFilter.dataset.sourceValue = selectedValue;
    sourceFilter.setAttribute('aria-label', `Session source: ${selectedLabel}`);
    if (sourceFilterLabel) sourceFilterLabel.textContent = selectedLabel;
    sourceOptions.forEach((option) => {
      const isSelected = option === selected;
      option.setAttribute('aria-selected', String(isSelected));
      const check = option.querySelector('[data-icon="check"]');
      if (check) check.hidden = !isSelected;
    });
    closeSourceFilter({ restoreFocus });
    if (sync) syncRunFilters();
  }
  function syncRunFilters() {
    const query = runFilter?.value.trim().toLocaleLowerCase() || '';
    const source = sourceFilter?.dataset.sourceValue || 'all';
    const canonicalRows = [...document.querySelectorAll('.run-filter-item')];
    const firstUse = canonicalRows.length === 0 || runFixtureSample === 'first-use';
    canonicalRows.forEach((row) => {
      const searchText = `${row.dataset.filterText || ''} ${row.dataset.stableId || ''} ${row.textContent}`;
      row.hidden = firstUse
        || Boolean(query && !searchText.toLocaleLowerCase().includes(query))
        || Boolean(source !== 'all' && row.dataset.source !== source);
    });
    document.querySelectorAll('.page-runs .work-group').forEach((group) => {
      const visibleCount = group.querySelectorAll('.run-filter-item:not([hidden])').length;
      group.hidden = visibleCount === 0;
      const count = group.querySelector('.group-heading > b');
      if (count) count.textContent = String(visibleCount);
    });
    const firstUseState = document.querySelector('[data-run-first-use]');
    if (firstUseState) firstUseState.hidden = !firstUse;
    const activeCount = document.querySelector('[data-run-active-count]');
    const navCount = document.querySelector('[data-run-count]');
    if (firstUse) {
      if (activeCount) activeCount.textContent = '0 active';
      if (navCount) navCount.textContent = '0';
    }
    const empty = document.querySelector('[data-run-filter-empty]');
    if (empty) {
      const hasVisibleRows = Boolean(document.querySelector('.page-runs .run-filter-item:not([hidden])'));
      empty.hidden = firstUse || hasVisibleRows;
      const title = empty.querySelector('[data-run-filter-empty-title]');
      const reason = empty.querySelector('[data-run-filter-empty-reason]');
      const reset = empty.querySelector('[data-run-filter-reset]');
      if (title) title.textContent = query && source !== 'all'
        ? 'No Sessions match these filters'
        : query
          ? `No Sessions match “${runFilter.value.trim()}”`
          : 'No Sessions match this source';
      if (reason) reason.textContent = query && source !== 'all'
        ? 'Try another title or stable ID, or restore All sources.'
        : query
          ? 'Try another Session title or stable ID.'
          : 'Choose All sources to restore the complete Session inventory.';
      if (reset) reset.textContent = query && source !== 'all' ? 'Reset filters' : query ? 'Clear filter' : 'Show all';
    }
  }
  runFilter?.addEventListener('input', syncRunFilters);
  sourceFilter?.addEventListener('click', () => {
    if (sourceFilter.getAttribute('aria-expanded') === 'true') closeSourceFilter();
    else openSourceFilter();
  });
  sourceFilter?.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openSourceFilter({ edge: event.key === 'ArrowUp' ? 'last' : 'selected' });
  });
  sourceOptions.forEach((option) => option.addEventListener('click', () => {
    setSourceFilter(option.dataset.sourceOption);
  }));
  sourceFilterMenu?.addEventListener('keydown', (event) => {
    const currentIndex = sourceOptions.indexOf(document.activeElement);
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const current = sourceOptions[currentIndex];
      if (current) setSourceFilter(current.dataset.sourceOption);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSourceFilter({ restoreFocus: true });
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      closeSourceFilter();
      if (event.shiftKey) runFilter?.focus();
      else document.querySelector('[data-new-session]')?.focus();
      return;
    }
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? sourceOptions.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + sourceOptions.length) % sourceOptions.length
          : event.key === 'ArrowUp'
            ? (currentIndex - 1 + sourceOptions.length) % sourceOptions.length
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    sourceOptions[nextIndex]?.focus();
  });
  sourceFilterShell?.addEventListener('focusout', (event) => {
    if (!sourceFilterShell.contains(event.relatedTarget)) closeSourceFilter();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!sourceFilterShell?.contains(event.target)) closeSourceFilter();
  });
  document.querySelector('[data-run-filter-reset]')?.addEventListener('click', () => {
    if (runFilter) runFilter.value = '';
    setSourceFilter('all', { sync: false, restoreFocus: false });
    syncRunFilters();
    runFilter?.focus();
  });
  setSourceFilter(sourceFilter?.dataset.sourceValue || 'all', { sync: false, restoreFocus: false });
  syncRunFilters();
  document.querySelector('[data-new-session]')?.addEventListener('click', () => {
    location.href = './session.html?view=detail&sample=direct-ready';
  });

  const scheduleFilter = document.querySelector('[data-schedule-filter]');
  const scheduleViewButtons = [...document.querySelectorAll('[data-schedule-view]')];
  let scheduleView = 'all';
  function replaceScheduleLocation(automationKey) {
    const url = new URL(location.href);
    if (automationKey) url.searchParams.set('automation', automationKey);
    else url.searchParams.delete('automation');
    const filterValue = scheduleFilter?.value.trim();
    if (filterValue) url.searchParams.set('filter', filterValue);
    else url.searchParams.delete('filter');
    history.replaceState(null, '', `${url.pathname.split('/').pop()}${url.search}`);
  }
  function syncScheduleFilters() {
    const query = scheduleFilter?.value.trim().toLocaleLowerCase() || '';
    document.querySelectorAll('.schedule-group').forEach((group) => {
      const statusMatches = scheduleView === 'all' || group.dataset.scheduleStatus === scheduleView;
      group.querySelectorAll('.schedule-filter-item').forEach((row) => {
        const searchText = `${row.dataset.filterText || ''} ${row.dataset.stableId || ''} ${row.textContent}`;
        row.hidden = !row.dataset.scheduleItem || !statusMatches || Boolean(query && !searchText.toLocaleLowerCase().includes(query));
      });
      const visibleCount = group.querySelectorAll('.schedule-filter-item:not([hidden])').length;
      group.hidden = visibleCount === 0;
      const count = group.querySelector('.group-heading b');
      if (count) count.textContent = String(visibleCount);
    });
    const definitions = [...document.querySelectorAll('[data-schedule-item]')];
    const visibleRows = definitions.filter((row) => !row.hidden);
    const firstUse = definitions.length === 0;
    const firstUseState = document.querySelector('[data-schedule-first-use]');
    const workspace = document.querySelector('[data-schedule-workspace]');
    const detail = document.querySelector('.page-schedules .detail-panel');
    if (firstUseState) firstUseState.hidden = !firstUse;
    if (workspace) workspace.hidden = firstUse;
    document.querySelectorAll('[data-schedule-count]').forEach((count) => { count.textContent = String(definitions.length); });
    document.body.classList.toggle('schedule-no-results', !firstUse && visibleRows.length === 0);
    const empty = document.querySelector('[data-schedule-filter-empty]');
    if (empty) {
      empty.hidden = firstUse || visibleRows.length > 0;
      const reason = empty.querySelector('[data-schedule-filter-reason]');
      const detailCopy = reason?.nextElementSibling;
      const reset = empty.querySelector('[data-schedule-filter-reset]');
      if (reason) reason.textContent = query && scheduleView !== 'all'
        ? 'No Automations match these filters'
        : query
          ? `No Automations match “${scheduleFilter.value.trim()}”`
          : 'No Automations match this status';
      if (detailCopy) detailCopy.textContent = query && scheduleView !== 'all'
        ? 'Clear the query and restore All statuses to recover the inventory.'
        : query
          ? 'Try another Automation name, instruction, or stable ID.'
          : 'Restore All statuses to see every Automation definition.';
      if (reset) reset.textContent = query && scheduleView !== 'all' ? 'Reset filters' : query ? 'Clear filter' : 'Show all';
    }
    if (detail) detail.hidden = firstUse || visibleRows.length === 0;
    if (firstUse || visibleRows.length === 0) {
      document.body.classList.remove('schedule-detail-open');
      definitions.forEach((row) => {
        row.classList.remove('featured');
        row.removeAttribute('aria-current');
      });
      replaceScheduleLocation(null);
    } else {
      const selectedRow = document.querySelector(`[data-schedule-item="${selectedAutomationKey || ''}"]`);
      const selectedStillVisible = selectedRow && !selectedRow.hidden;
      const selectedIsPresented = selectedStillVisible && selectedRow.classList.contains('featured');
      const desktopSchedule = matchMedia('(min-width: 841px)').matches;
      if (desktopSchedule && !selectedIsPresented) {
        const nextRow = selectedStillVisible ? selectedRow : visibleRows[0];
        renderAutomationDetail(nextRow.dataset.scheduleItem, { openMobile: false, writeUrl: true });
      } else if (!desktopSchedule && !selectedIsPresented) {
        document.body.classList.remove('schedule-detail-open');
        definitions.forEach((row) => {
          row.classList.remove('featured');
          row.removeAttribute('aria-current');
        });
        replaceScheduleLocation(null);
      } else {
        replaceScheduleLocation(selectedAutomationKey);
      }
    }
    if (firstUse) {
      selectedAutomationKey = undefined;
    }
  }
  scheduleFilter?.addEventListener('input', syncScheduleFilters);
  scheduleViewButtons.forEach((button) => button.addEventListener('click', () => {
    scheduleView = button.dataset.scheduleView || 'all';
    scheduleViewButtons.forEach((item) => {
      const selected = item === button;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    syncScheduleFilters();
  }));
  document.querySelector('[data-schedule-filter-reset]')?.addEventListener('click', () => {
    if (scheduleFilter) scheduleFilter.value = '';
    scheduleView = 'all';
    scheduleViewButtons.forEach((item) => {
      const selected = item.dataset.scheduleView === 'all';
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    syncScheduleFilters();
    scheduleFilter?.focus();
  });

  const automationSamples = {
    license: {
      title: 'Dependency license scan', status: 'Failed · Updated 18m ago', tone: 'error', origin: 'direct', definitionState: 'active', presentationState: 'failed',
      trigger: 'Daily · 08:30 · Asia/Shanghai', triggerType: 'cron', cron: '30 8 * * *', next: 'Tomorrow, 08:30', action: 'Start new Lead Session', actionType: 'start_session', location: 'Project checkout', locationType: 'project', binding: 'Lead · principal', id: '14ef653e-3b1e-4b07-a4b4-2a1cb71bcbb2', runHref: './session.html?view=detail&sample=automation-license-live&invocation=4ad25f0c-239a-4b9b-a52c-5b772993ee17', runPresentation: { href: './session.html?view=detail&sample=automation-license-failed&invocation=9782da2f-5cde-4076-a40f-0813b44c8875', title: 'Today, 08:30', detail: 'Failed · Registry response was incomplete', time: '18m', tone: 'error' },
      message: 'Scan dependency licenses, preserve the exact package evidence, and report any unresolved policy conflict.',
    },
    dependency: {
      title: 'Profile validation sweep', status: 'Scheduled · Updated 2h ago', tone: 'neutral', origin: 'todo', definitionState: 'active', todo: 'Model profile defaults per project', todoHref: './session.html?view=todo&sample=running',
      trigger: 'Weekdays · 09:00 · Asia/Shanghai', triggerType: 'cron', cron: '0 9 * * 1-5', next: 'Tomorrow, 09:00', action: 'Start new Lead Session', actionType: 'start_session', location: 'Managed worktree', locationType: 'worktree', binding: 'Lead · principal', id: '5ed67823-cf0e-4690-a7c4-f4c7bd53e5e9', runHref: './session.html?view=detail&sample=automation-live&invocation=33d412c7-ad65-4382-a1a7-0f7bece7fe84', runPresentation: { href: './session.html?view=detail&sample=automation-review&invocation=6c5b6294-b1da-4f8a-a5d2-7c10227546f8', title: 'Monday, 09:00', detail: 'Completed · No profile regression · 2m 04s', time: 'Mon', tone: 'done' },
      message: 'Re-run the profile-resolution contract checks and report only regressions against the approved Plan.',
    },
    memory: {
      title: 'Weekly memory quality review', status: 'Scheduled · Updated yesterday', tone: 'neutral', origin: 'direct', definitionState: 'active',
      trigger: 'Mondays · 10:00 · Asia/Shanghai', triggerType: 'cron', cron: '0 10 * * 1', next: 'Monday, 10:00', action: 'Start new Lead Session', actionType: 'start_session', location: 'Project checkout', locationType: 'project', binding: 'Lead · principal', id: 'd36a4b01-1903-48b5-91d0-11b75743e480', runHref: './session.html?view=detail&sample=automation-memory-live&invocation=8e85953d-a296-4107-a732-0a63b71786d8', runPresentation: null,
      message: 'Audit durable memory for stale claims and return only actionable corrections.',
    },
    release: {
      title: 'Release readiness sweep', status: 'Scheduled · Updated 3d ago', tone: 'neutral', origin: 'session', definitionState: 'active', originCopy: 'Session · Preserve approval state after restart', originHref: './session.html?view=detail&sample=direct-completed',
      trigger: 'Fridays · 17:30 · Asia/Shanghai', triggerType: 'cron', cron: '30 17 * * 5', next: 'Friday, 17:30', action: 'Send message', actionType: 'send_message', location: 'Existing Session', binding: 'Existing Session', targetSessionId: '7c6cc655-1d3e-4c4f-9368-9014460322df', id: '9e4a9d62-ee8b-4c3d-bc9c-520c0b53986e', runHref: './session.html?view=detail&sample=direct-release-live&session=7c6cc655-1d3e-4c4f-9368-9014460322df&invocation=47a55fe0-5965-4f02-a598-7ecf17f46ca0', runPresentation: null,
      message: 'Re-run the release readiness checks and summarize only new blockers.',
    },
    snapshot: {
      title: 'Nightly UI snapshot review', status: 'Paused · Updated 4d ago', tone: 'neutral', origin: 'direct', definitionState: 'paused',
      trigger: 'Daily · 23:30 · Asia/Shanghai', triggerType: 'cron', cron: '30 23 * * *', next: 'Paused', action: 'Start new Lead Session', actionType: 'start_session', location: 'Managed worktree', locationType: 'worktree', binding: 'Lead · principal', id: '483de6f3-bad5-477e-9a77-ed08dd82b0f4', runHref: './session.html?view=detail&sample=automation-snapshot-live&invocation=a33d9511-f96e-4544-807c-cfab2ce9f508', runPresentation: null,
      message: 'Capture the current UI surfaces and report visual regressions against the approved baseline.',
    },
    retired: {
      title: 'Legacy provider compatibility check', status: 'Inactive · Updated 12d ago', tone: 'neutral', origin: 'direct', definitionState: 'disabled',
      trigger: 'Monthly · 09:00 · Asia/Shanghai', triggerType: 'cron', cron: '0 9 1 * *', next: 'Inactive', action: 'Start new Lead Session', actionType: 'start_session', location: 'Project checkout', locationType: 'project', binding: 'Lead · principal', id: '72166b7f-e65a-49da-aeb2-0b16c347c791', runHref: './session.html?view=detail&sample=automation-retired-live&invocation=f3cf21ac-eab4-4a8b-a192-fce797c744ef', runPresentation: null,
      message: 'Verify whether the retired provider adapter is still required before re-enabling compatibility checks.',
    },
  };
  let selectedAutomationKey = 'license';
  function syncScheduleGroupCounts() {
    document.querySelectorAll('.schedule-group').forEach((group) => {
      const rows = [...group.querySelectorAll('[data-schedule-item]')];
      const count = group.querySelector('.group-heading b');
      if (count) count.textContent = String(rows.length);
      group.hidden = rows.length === 0;
    });
    syncScheduleFilters();
  }
  function projectAutomationRowState(key) {
    const sample = automationSamples[key];
    const row = document.querySelector(`[data-schedule-item="${key}"]`);
    if (!sample || !row) return;
    row.querySelector('.work-copy strong').textContent = sample.title;
    const summary = row.querySelector('.work-copy > span');
    if (summary) {
      const sourceLabel = sample.origin === 'todo' ? 'TODO' : sample.origin === 'session' ? 'SESSION' : 'DIRECT';
      summary.replaceChildren();
      const source = document.createElement('b');
      source.textContent = sourceLabel;
      summary.append(source, document.createTextNode(` · ${sample.trigger}`));
    }
    const paused = sample.definitionState === 'paused';
    const inactive = sample.definitionState === 'disabled';
    const decisionGroup = sample.presentationState === 'failed'
      ? 'needs-you'
      : inactive
        ? 'inactive'
        : paused
          ? 'paused'
          : 'scheduled';
    const targetGroup = document.querySelector(`.schedule-group[data-schedule-group="${decisionGroup}"] .work-list`);
    if (targetGroup && row.parentElement !== targetGroup) targetGroup.appendChild(row);
    const state = row.querySelector('.status-label');
    const rowState = sample.presentationState === 'failed'
      ? ['Failed', 'error']
      : sample.presentationState === 'running'
        ? ['Running', 'live']
      : inactive
        ? ['Inactive', 'neutral']
        : paused
          ? ['Paused', 'neutral']
          : [sample.next, 'neutral'];
    if (state) { state.textContent = rowState[0]; state.className = `status-label ${rowState[1]}`; }
    const orbit = row.querySelector('.work-orbit');
    if (orbit) {
      orbit.className = `work-orbit ${sample.presentationState === 'failed' ? 'error' : sample.presentationState === 'running' ? 'live running' : 'neutral'}`;
      orbit.innerHTML = `<span data-icon="${sample.presentationState === 'failed' ? 'alert' : inactive ? 'stop' : paused ? 'pause' : 'repeat'}"></span>`;
      renderIcons(orbit);
    }
    syncScheduleGroupCounts();
  }
  function renderAutomationDetail(key, { openMobile = true, writeUrl = true, focus = false } = {}) {
    const sample = automationSamples[key];
    if (!sample) return;
    selectedAutomationKey = key;
    document.querySelectorAll('[data-schedule-item]').forEach((row) => {
      const selected = row.dataset.scheduleItem === key;
      row.classList.toggle('featured', selected);
      if (selected) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    });
    const status = document.querySelector('[data-automation-detail-status]');
    if (status) { status.textContent = sample.status; status.className = `section-kicker ${sample.tone}`; }
    const values = {
      '[data-automation-detail-title]': sample.title,
      '[data-automation-trigger]': sample.trigger,
      '[data-automation-next]': sample.next,
      '[data-automation-action]': sample.action,
      '[data-automation-location]': sample.location,
      '[data-automation-binding]': sample.binding,
      '[data-automation-id]': sample.id,
      '[data-automation-message]': sample.message,
    };
    Object.entries(values).forEach(([selector, value]) => { const node = document.querySelector(selector); if (node) node.textContent = value; });
    const nextDot = document.querySelector('[data-automation-next-dot]');
    if (nextDot) { nextDot.hidden = ['Paused', 'Inactive'].includes(sample.next); nextDot.className = 'signal-dot'; }
    const linkedTodo = document.querySelector('[data-automation-linked-todo]');
    if (linkedTodo) {
      linkedTodo.hidden = sample.origin !== 'todo';
      if (sample.todoHref) linkedTodo.href = sample.todoHref;
    }
    const todoCopy = document.querySelector('[data-automation-todo-copy]');
    if (todoCopy && sample.todo) todoCopy.textContent = sample.todo;
    const origin = document.querySelector('[data-automation-origin]');
    const originCopy = document.querySelector('[data-automation-origin-copy]');
    const originLink = document.querySelector('[data-automation-origin-link]');
    if (origin) origin.hidden = sample.origin === 'todo';
    if (originCopy) originCopy.hidden = sample.origin === 'session';
    if (originLink) {
      originLink.hidden = sample.origin !== 'session';
      if (sample.originCopy) originLink.textContent = sample.originCopy;
      if (sample.originHref) originLink.href = sample.originHref;
    }
    const runRow = document.querySelector('[data-automation-run-row]');
    const runEmpty = document.querySelector('[data-automation-run-empty]');
    if (runRow) {
      const run = sample.runPresentation;
      runRow.hidden = !run;
      if (run) {
        runRow.href = run.href;
        const glyph = runRow.querySelector('.run-glyph');
        if (glyph) {
          glyph.className = `run-glyph ${run.tone}`;
          glyph.innerHTML = run.tone === 'live'
            ? '<span class="pulse-dot"></span>'
            : `<span data-icon="${run.tone === 'error' ? 'alert' : 'check'}"></span>`;
          renderIcons(glyph);
        }
        const title = runRow.querySelector('strong');
        const detail = runRow.querySelector('small');
        const time = runRow.querySelector('time');
        if (title) title.textContent = run.title;
        if (detail) detail.textContent = run.detail;
        if (time) time.textContent = run.time;
      }
    }
    if (runEmpty) runEmpty.hidden = Boolean(sample.runPresentation);
    const runNow = document.querySelector('[data-automation-run-now]');
    if (runNow) {
      runNow.disabled = sample.definitionState === 'disabled';
      runNow.title = sample.definitionState === 'disabled' ? 'Enable this Automation before running it' : 'Run this Automation now';
    }
    document.body.classList.toggle('schedule-detail-open', openMobile);
    if (writeUrl) replaceScheduleLocation(key);
    if (focus) requestAnimationFrame(() => document.querySelector('[data-automation-detail-title]')?.focus());
  }
  document.querySelectorAll('[data-schedule-item]').forEach((row) => row.addEventListener('click', () => renderAutomationDetail(row.dataset.scheduleItem, { focus: matchMedia('(max-width: 840px)').matches })));
  document.querySelector('[data-schedule-detail-back]')?.addEventListener('click', () => {
    document.body.classList.remove('schedule-detail-open');
    replaceScheduleLocation(null);
    document.querySelector(`[data-schedule-item="${selectedAutomationKey}"]`)?.focus();
  });
  if (document.querySelector('[data-schedule-item]')) {
    const requestedAutomation = new URLSearchParams(location.search).get('automation');
    const validAutomation = requestedAutomation && automationSamples[requestedAutomation] ? requestedAutomation : null;
    const mobileSchedule = matchMedia('(max-width: 840px)').matches;
    if (validAutomation) {
      renderAutomationDetail(validAutomation, { openMobile: mobileSchedule, writeUrl: true });
    } else if (!mobileSchedule) {
      renderAutomationDetail('license', { openMobile: false, writeUrl: true });
    } else {
      document.body.classList.remove('schedule-detail-open');
      document.querySelectorAll('[data-schedule-item]').forEach((row) => {
        row.classList.remove('featured');
        row.removeAttribute('aria-current');
      });
      if (requestedAutomation) history.replaceState(null, '', './automations.html');
    }
  }
  syncScheduleFilters();

  const automationDialog = document.querySelector('[data-automation-dialog]');
  const automationForm = document.querySelector('[data-automation-form]');
  const automationNameInput = document.querySelector('[data-automation-name]');
  const automationMessageInput = document.querySelector('#automation-message');
  const automationSessionIdInput = document.querySelector('[data-action-panel="send_message"] input');
  const automationDialogTitle = document.querySelector('[data-automation-title]');
  const automationSave = document.querySelector('[data-automation-save]');
  const definitionControls = document.querySelector('[data-definition-controls]');
  const definitionStatus = document.querySelector('[data-definition-status]');
  const automationLifecycle = document.querySelector('[data-automation-lifecycle]');
  const deleteConfirmation = document.querySelector('[data-automation-delete-confirmation]');
  let automationEditorMode = 'create';
  function syncAutomationChoices(name, panelPrefix) {
    const checked = document.querySelector(`input[name="${name}"]:checked`)?.value;
    document.querySelectorAll(`input[name="${name}"]`).forEach((input) => input.closest('.choice-card')?.classList.toggle('selected', input.checked));
    if (panelPrefix) document.querySelectorAll(`[data-${panelPrefix}-panel]`).forEach((panel) => { panel.hidden = panel.dataset[`${panelPrefix}Panel`] !== checked; });
  }
  document.querySelectorAll('input[name="automation-trigger"]').forEach((input) => input.addEventListener('change', () => syncAutomationChoices('automation-trigger', 'trigger')));
  document.querySelectorAll('input[name="automation-action"]').forEach((input) => input.addEventListener('change', () => syncAutomationChoices('automation-action', 'action')));
  document.querySelectorAll('input[name="automation-location"]').forEach((input) => input.addEventListener('change', () => syncAutomationChoices('automation-location')));
  const automationIntervalAmount = document.querySelector('[data-automation-interval-amount]');
  const automationIntervalUnit = document.querySelector('[data-automation-interval-unit]');
  function syncAutomationIntervalMinimum() {
    if (!automationIntervalAmount || !automationIntervalUnit) return;
    const minimum = automationIntervalUnit.value === 'Seconds' ? 30 : 1;
    automationIntervalAmount.min = String(minimum);
    if (Number(automationIntervalAmount.value) < minimum) automationIntervalAmount.value = String(minimum);
  }
  automationIntervalUnit?.addEventListener('change', syncAutomationIntervalMinimum);
  automationIntervalAmount?.addEventListener('change', syncAutomationIntervalMinimum);
  syncAutomationIntervalMinimum();
  document.querySelectorAll('[data-automation-open]').forEach((button) => button.addEventListener('click', () => {
    automationEditorMode = button.dataset.automationOpen || 'create';
    const sample = automationSamples[selectedAutomationKey];
    if (automationDialogTitle) automationDialogTitle.textContent = automationEditorMode === 'edit' ? 'Edit Automation' : 'New Automation';
    if (automationSave) automationSave.textContent = automationEditorMode === 'edit' ? 'Update Automation' : 'Save Automation';
    if (automationNameInput) automationNameInput.value = automationEditorMode === 'edit' ? sample.title : '';
    if (automationMessageInput) automationMessageInput.value = automationEditorMode === 'edit' ? sample.message : '';
    const actionType = automationEditorMode === 'edit' ? sample.actionType : 'start_session';
    const locationType = automationEditorMode === 'edit' ? (sample.locationType || 'project') : 'project';
    const triggerType = automationEditorMode === 'edit' ? (sample.triggerType || 'interval') : 'interval';
    document.querySelectorAll('input[name="automation-action"]').forEach((input) => { input.checked = input.value === actionType; });
    document.querySelectorAll('input[name="automation-location"]').forEach((input) => { input.checked = input.value === locationType; });
    document.querySelectorAll('input[name="automation-trigger"]').forEach((input) => { input.checked = input.value === triggerType; });
    if (automationSessionIdInput) automationSessionIdInput.value = automationEditorMode === 'edit' ? (sample.targetSessionId || '') : '';
    const cronInput = document.querySelector('[data-trigger-panel="cron"] input');
    if (cronInput && automationEditorMode === 'edit' && sample.cron) cronInput.value = sample.cron;
    syncAutomationChoices('automation-action', 'action');
    syncAutomationChoices('automation-location');
    syncAutomationChoices('automation-trigger', 'trigger');
    if (definitionControls) definitionControls.hidden = automationEditorMode !== 'edit';
    const definitionState = sample?.definitionState || 'active';
    if (definitionStatus) definitionStatus.textContent = definitionState === 'disabled' ? 'Inactive' : definitionState === 'paused' ? 'Paused' : 'Scheduled';
    if (automationLifecycle) automationLifecycle.textContent = definitionState === 'disabled' ? 'Enable Automation' : definitionState === 'paused' ? 'Resume Automation' : 'Pause Automation';
    if (deleteConfirmation) deleteConfirmation.hidden = true;
    automationDialog?.showModal();
    requestAnimationFrame(() => automationNameInput?.focus());
  }));
  document.querySelectorAll('[data-automation-close]').forEach((button) => button.addEventListener('click', () => automationDialog?.close()));
  automationDialog?.addEventListener('click', (event) => { if (event.target === automationDialog) automationDialog.close(); });
  automationLifecycle?.addEventListener('click', () => {
    const activating = automationLifecycle.textContent.includes('Resume') || automationLifecycle.textContent.includes('Enable');
    const sample = automationSamples[selectedAutomationKey];
    automationLifecycle.textContent = activating ? 'Pause Automation' : 'Resume Automation';
    if (definitionStatus) definitionStatus.textContent = activating ? 'Scheduled' : 'Paused';
    if (sample) {
      if (!activating && sample.next !== 'Inactive') sample.scheduledNext = sample.next;
      sample.definitionState = activating ? 'active' : 'paused';
      sample.status = `${activating ? 'Scheduled' : 'Paused'} · Updated just now`;
      sample.tone = 'neutral';
      sample.presentationState = undefined;
      sample.next = activating ? (sample.scheduledNext || 'Next scheduled time') : 'Paused';
      projectAutomationRowState(selectedAutomationKey);
      renderAutomationDetail(selectedAutomationKey, { writeUrl: false, openMobile: document.body.classList.contains('schedule-detail-open') });
    }
    showToast(activating ? 'Automation activated.' : 'Automation paused.');
  });
  const automationDeleteButton = document.querySelector('[data-automation-delete]');
  automationDeleteButton?.addEventListener('click', () => {
    if (deleteConfirmation) deleteConfirmation.hidden = false;
    requestAnimationFrame(() => document.querySelector('[data-automation-delete-cancel]')?.focus());
  });
  document.querySelector('[data-automation-delete-cancel]')?.addEventListener('click', () => {
    if (deleteConfirmation) deleteConfirmation.hidden = true;
    automationDeleteButton?.focus();
  });
  document.querySelector('[data-automation-delete-confirm]')?.addEventListener('click', () => {
    const removedKey = selectedAutomationKey;
    document.querySelector(`[data-schedule-item="${removedKey}"]`)?.remove();
    delete automationSamples[removedKey];
    syncScheduleGroupCounts();
    automationDialog?.close();
    const nextRow = document.querySelector('[data-schedule-item]');
    if (nextRow) renderAutomationDetail(nextRow.dataset.scheduleItem, { openMobile: false, writeUrl: true });
    else syncScheduleFilters();
    showToast('Automation deleted; durable Sessions were preserved.');
  });
  automationForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!automationNameInput?.value.trim() || !automationMessageInput?.value.trim()) return (automationNameInput?.value.trim() ? automationMessageInput : automationNameInput)?.focus();
    const submittedActionType = document.querySelector('input[name="automation-action"]:checked')?.value || 'start_session';
    if (submittedActionType === 'send_message' && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(automationSessionIdInput?.value.trim() || '')) {
      automationSessionIdInput?.focus();
      showToast('Enter the exact target Session UUID.');
      return;
    }
    if (automationEditorMode === 'edit') {
      const sample = automationSamples[selectedAutomationKey];
      if (sample) {
        sample.title = automationNameInput.value.trim();
        sample.message = automationMessageInput.value.trim();
        sample.actionType = submittedActionType;
        sample.action = sample.actionType === 'send_message' ? 'Send message' : 'Start new Lead Session';
        sample.targetSessionId = sample.actionType === 'send_message' ? automationSessionIdInput?.value.trim() : undefined;
        sample.locationType = document.querySelector('input[name="automation-location"]:checked')?.value || sample.locationType;
        sample.location = sample.actionType === 'send_message' ? 'Existing Session' : sample.locationType === 'worktree' ? 'Managed worktree' : 'Project checkout';
        sample.binding = sample.actionType === 'send_message' ? 'Existing Session' : 'Lead · principal';
        sample.triggerType = document.querySelector('input[name="automation-trigger"]:checked')?.value || sample.triggerType;
        if (sample.triggerType === 'cron') {
          const cronInputs = document.querySelectorAll('[data-trigger-panel="cron"] input');
          sample.cron = cronInputs[0]?.value.trim() || sample.cron;
          const timezone = cronInputs[1]?.value.trim() || 'Local timezone';
          sample.trigger = `${sample.cron} · ${timezone}`;
          sample.next = 'Next scheduled time';
        } else if (sample.triggerType === 'interval') {
          const amount = Math.max(Number(automationIntervalAmount?.value) || 1, Number(automationIntervalAmount?.min) || 1);
          const unit = automationIntervalUnit?.value || 'Minutes';
          sample.trigger = `Every ${amount} ${unit.toLocaleLowerCase()}`;
          sample.next = `In ${amount} ${unit.toLocaleLowerCase()}`;
        } else {
          const runAt = document.querySelector('[data-trigger-panel="once"] input')?.value;
          sample.trigger = runAt ? `Once · ${runAt.replace('T', ' ')}` : 'Once · scheduled time';
          sample.next = runAt ? runAt.replace('T', ' ') : 'Scheduled time';
        }
        if (sample.actionType === 'send_message') {
          sample.runHref = `./session.html?view=detail&sample=direct-release-live&session=${encodeURIComponent(sample.targetSessionId)}&invocation=${crypto.randomUUID()}`;
        } else {
          const startSessionSamples = { license: 'automation-license-live', dependency: 'automation-live', memory: 'automation-memory-live', release: 'automation-memory-live', snapshot: 'automation-snapshot-live', retired: 'automation-retired-live' };
          const startSample = startSessionSamples[selectedAutomationKey] || 'automation-memory-live';
          sample.runHref = `./session.html?view=detail&sample=${startSample}&invocation=${crypto.randomUUID()}`;
        }
        projectAutomationRowState(selectedAutomationKey);
        renderAutomationDetail(selectedAutomationKey, { writeUrl: false, openMobile: document.body.classList.contains('schedule-detail-open') });
      }
    }
    automationDialog?.close();
    showToast(automationEditorMode === 'edit' ? 'Automation updated.' : 'Automation created.');
  });
  document.querySelector('[data-automation-run-now]')?.addEventListener('click', () => {
    const sample = automationSamples[selectedAutomationKey];
    const runRow = document.querySelector('[data-automation-run-row]');
    const runEmpty = document.querySelector('[data-automation-run-empty]');
    if (!sample || !runRow) return;
    const runUrl = new URL(sample.runHref, location.href);
    runUrl.searchParams.set('invocation', crypto.randomUUID());
    sample.runHref = `${runUrl.pathname.split('/').pop()}${runUrl.search}`;
    sample.runPresentation = { href: sample.runHref, title: 'Just now', detail: 'Running · Session dispatched', time: 'Now', tone: 'live' };
    sample.presentationState = 'running';
    sample.status = 'Running · Just now';
    sample.tone = 'live';
    projectAutomationRowState(selectedAutomationKey);
    renderAutomationDetail(selectedAutomationKey, { writeUrl: false, openMobile: document.body.classList.contains('schedule-detail-open') });
    showToast(sample.actionType === 'send_message' ? 'Invocation dispatched to the exact target Session.' : 'Invocation dispatched to its new Session.');
  });

  const newTodoDialog = document.querySelector('[data-new-todo-dialog]');
  const newTodoInput = newTodoDialog?.querySelector('#new-todo-content');
  const newTodoError = newTodoDialog?.querySelector('[data-new-todo-error]');
  const newTodoForm = newTodoDialog?.querySelector('form');
  let newTodoPending = false;
  let newTodoPendingStatus;
  if (newTodoDialog) {
    newTodoPendingStatus = document.createElement('p');
    newTodoPendingStatus.className = 'modal-hint';
    newTodoPendingStatus.dataset.newTodoPending = '';
    newTodoPendingStatus.setAttribute('role', 'status');
    newTodoPendingStatus.setAttribute('aria-live', 'polite');
    newTodoPendingStatus.hidden = true;
    newTodoDialog.querySelector('.modal-body')?.appendChild(newTodoPendingStatus);
  }
  function setNewTodoPending(pending, label = '') {
    newTodoPending = pending;
    newTodoForm?.setAttribute('aria-busy', String(pending));
    newTodoDialog?.querySelectorAll('button').forEach((button) => { button.disabled = pending; });
    if (newTodoInput) newTodoInput.readOnly = pending;
    if (newTodoPendingStatus) {
      newTodoPendingStatus.textContent = label;
      newTodoPendingStatus.hidden = !pending;
    }
  }
  let newTodoTrigger;
  document.querySelectorAll('[data-new-todo]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!newTodoDialog) return;
      newTodoTrigger = button;
      if (newTodoError) newTodoError.hidden = true;
      newTodoDialog.showModal();
      requestAnimationFrame(() => newTodoInput?.focus());
    });
  });
  document.querySelectorAll('[data-dialog-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = button.closest('dialog');
      if (dialog === newTodoDialog && newTodoPending) return;
      dialog?.close();
    });
  });
  newTodoDialog?.addEventListener('click', (event) => {
    if (event.target === newTodoDialog && !newTodoPending) newTodoDialog.close();
  });
  newTodoDialog?.addEventListener('cancel', (event) => {
    if (newTodoPending) event.preventDefault();
  });
  newTodoDialog?.addEventListener('close', () => {
    setNewTodoPending(false);
    if (newTodoInput) newTodoInput.value = '';
    if (newTodoError) newTodoError.hidden = true;
    requestAnimationFrame(() => newTodoTrigger?.focus());
  });
  newTodoInput?.addEventListener('input', () => {
    if (newTodoError) newTodoError.hidden = true;
  });

  const toast = document.querySelector('.toast');
  toast?.setAttribute('role', 'status');
  toast?.setAttribute('aria-live', 'polite');
  toast?.setAttribute('aria-atomic', 'true');
  let toastTimer;
  function showToast(message) {
    if (!toast) return;
    const copy = toast.querySelector('[data-toast-copy]');
    if (copy) copy.textContent = message;
    else toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }
  document.querySelectorAll('[data-toast-action]').forEach((button) => {
    button.addEventListener('click', () => showToast(button.dataset.toastAction || 'Saved'));
  });
  document.querySelectorAll('button[data-toast]').forEach((button) => {
    if (button.matches('[data-session-terminal-action]')) return;
    button.addEventListener('click', () => showToast(button.dataset.toast || 'Saved'));
  });
  const modelTrigger = document.querySelector('[data-composer-model-trigger]');
  const modelMenu = document.querySelector('[data-composer-model-menu]');
  const modelLabel = document.querySelector('[data-composer-model-label]');
  const variantLabel = document.querySelector('[data-composer-variant-label]');
  const modelMenuOptions = [...document.querySelectorAll('[data-model-option], [data-effort-option]')];
  const selectedModelIndex = () => modelMenuOptions.findIndex((option) => option.matches('[data-model-option].active'));
  function setModelMenuOpen(open, focusIndex) {
    if (modelMenu) modelMenu.hidden = !open;
    modelTrigger?.setAttribute('aria-expanded', String(open));
    if (open && Number.isInteger(focusIndex)) requestAnimationFrame(() => modelMenuOptions.at(focusIndex)?.focus());
  }
  modelTrigger?.addEventListener('click', () => {
    const open = modelMenu?.hidden ?? true;
    setModelMenuOpen(open);
  });
  modelTrigger?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modelTrigger.getAttribute('aria-expanded') === 'true') {
      event.preventDefault();
      setModelMenuOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const selectedIndex = selectedModelIndex();
    setModelMenuOpen(true, selectedIndex >= 0 ? selectedIndex : event.key === 'ArrowDown' ? 0 : -1);
  });
  modelMenu?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setModelMenuOpen(false);
      modelTrigger?.focus();
      return;
    }
    const current = modelMenuOptions.indexOf(document.activeElement);
    const target = event.key === 'ArrowDown'
      ? current + 1
      : event.key === 'ArrowUp'
        ? current - 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? modelMenuOptions.length - 1
            : null;
    if (target === null) return;
    event.preventDefault();
    modelMenuOptions[(target + modelMenuOptions.length) % modelMenuOptions.length]?.focus();
  });
  document.querySelectorAll('[data-model-option]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-model-option]').forEach((item) => item.classList.toggle('active', item === button));
      if (modelLabel) modelLabel.textContent = button.dataset.modelOption;
      modelTrigger?.setAttribute('title', `${button.dataset.modelOption} · ${variantLabel?.textContent || 'Default'}`);
      showToast('Model selection applies to the next execution.');
    });
  });
  document.querySelectorAll('[data-effort-option]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-effort-option]').forEach((item) => item.classList.toggle('active', item === button));
      if (variantLabel) variantLabel.textContent = button.dataset.effortOption;
      modelTrigger?.setAttribute('title', `${modelLabel?.textContent || 'Model'} · ${button.dataset.effortOption}`);
      showToast('Effort selection applies to the next execution.');
    });
  });
  document.addEventListener('click', (event) => {
    if (!modelMenu || modelMenu.hidden || event.target.closest('.composer-model-picker')) return;
    modelMenu.hidden = true;
    modelTrigger?.setAttribute('aria-expanded', 'false');
  });
  const composerFileInput = document.querySelector('[data-composer-file-input]');
  const composerAttachments = document.querySelector('[data-composer-attachments]');
  const composerDrafts = new Map();
  let currentComposerDraftSample;
  function bindComposerAttachment(item) {
    item.querySelector('button')?.addEventListener('click', () => {
      item.remove();
      syncComposerAttachments();
      syncTerminalAction();
    });
  }
  composerAttachments?.querySelectorAll('.composer-attachment').forEach(bindComposerAttachment);
  document.querySelector('[data-composer-attach]')?.addEventListener('click', () => composerFileInput?.click());
  composerFileInput?.addEventListener('change', () => {
    if (!composerAttachments || !composerFileInput.files?.length) return;
    composerAttachments.hidden = false;
    [...composerFileInput.files].forEach((file) => {
      const item = document.createElement('li');
      item.className = 'composer-attachment';
      item.dataset.attachmentOwner = document.body.dataset.sessionSample || 'running';
      item.innerHTML = `<span data-icon="file"></span><strong>${file.name.replace(/[<>&]/g, '')}</strong><button type="button" aria-label="Remove ${file.name.replace(/[<>&\"]/g, '')}" data-icon="close"></button>`;
      composerAttachments.appendChild(item);
      renderIcons(item);
      bindComposerAttachment(item);
    });
    composerFileInput.value = '';
    syncTerminalAction();
  });

  const todoFixtures = {
    profile: {
      status: 'In progress', tone: 'progress', lane: 'in_progress', workCount: 5, plan: 'present',
      contentHtml: '<h3>Model profile defaults per project</h3><p>Allow a project to specialize model selection without copying the full provider configuration or hiding invalid references.</p><h4>Problem</h4><p>Every project currently inherits all three global profiles. A full configuration copy would drift and make validation ambiguous.</p><h4>Acceptance criteria</h4><ul><li>Override principal, deep, or fast independently.</li><li>Missing keys inherit the matching global profile.</li><li>Unknown models and variants fail before work starts.</li><li>The resolved profile is recorded on each Execution.</li></ul>',
      markdown: '# Model profile defaults per project\n\nAllow a project to specialize model selection without copying the full provider configuration or hiding invalid references.\n\n## Problem\n\nEvery project currently inherits all three global profiles. A full configuration copy would drift and make validation ambiguous.\n\n## Acceptance criteria\n\n- Override principal, deep, or fast independently.\n- Missing keys inherit the matching global profile.\n- Unknown models and variants fail before work starts.\n- The resolved profile is recorded on each Execution.',
      references: [['profile-precedence.md', '6.2 KB · text/markdown'], ['config-resolution.png', '184 KB · image/png']],
    },
    recovery: {
      status: 'In progress', tone: 'progress', lane: 'in_progress', workCount: 1, plan: 'absent',
      contentHtml: '<h3>Choose the recovery policy for interrupted runs</h3><p>Verify the stale worktree before moving it to Trash, without touching the project root or active Sessions.</p><h4>Acceptance criteria</h4><ul><li>Run the focused recovery verification first.</li><li>Require an explicit permission for the destructive boundary.</li><li>Preserve the exact recovery location in the final report.</li></ul>',
      markdown: '# Choose the recovery policy for interrupted runs\n\nVerify the stale worktree before moving it to Trash, without touching the project root or active Sessions.\n\n## Acceptance criteria\n\n- Run the focused recovery verification first.\n- Require an explicit permission for the destructive boundary.\n- Preserve the exact recovery location in the final report.',
      references: [['recovery-policy.md', '4.8 KB · text/markdown'], ['worktree-inventory.txt', '2.1 KB · text/plain']],
    },
    handoff: {
      status: 'Idea', tone: 'neutral', lane: 'idea', workCount: 1, plan: 'absent',
      contentHtml: '<h3>Review the Todo → Run handoff contract</h3><p>Preserve the Discussion evidence and record a recommendation without starting implementation from the Discussion itself.</p><h4>Decision boundary</h4><ul><li>Continue shaping if acceptance boundaries remain unclear.</li><li>Recommend Start Work only when a separate Lead Session can begin safely.</li></ul>',
      markdown: '# Review the Todo → Run handoff contract\n\nPreserve the Discussion evidence and record a recommendation without starting implementation from the Discussion itself.\n\n## Decision boundary\n\n- Continue shaping if acceptance boundaries remain unclear.\n- Recommend Start Work only when a separate Lead Session can begin safely.',
      references: [['handoff-evidence.md', '3.4 KB · text/markdown']],
    },
    audit: {
      status: 'Ready', tone: 'ready', lane: 'ready', workCount: 1, plan: 'absent', result: 'Permission requests, decisions, and the resumed same-Execution outcome are now recorded together without a fabricated continuation run.',
      contentHtml: '<h3>Add a durable permission audit trail</h3><p>Retain the request, decision, and resumed Execution relationship without inventing a second continuation run.</p><h4>Acceptance criteria</h4><ul><li>Bind each response to its exact original request.</li><li>Show the resulting terminal state on the same Session.</li></ul>',
      markdown: '# Add a durable permission audit trail\n\nRetain the request, decision, and resumed Execution relationship without inventing a second continuation run.\n\n## Acceptance criteria\n\n- Bind each response to its exact original request.\n- Show the resulting terminal state on the same Session.',
      references: [['permission-contract.md', '5.1 KB · text/markdown']],
    },
    outputRecovery: {
      status: 'In progress', tone: 'progress', lane: 'in_progress', workCount: 1, plan: 'absent',
      contentHtml: '<h3>Make tool output recovery inspectable</h3><p>Keep large finalized tool output recoverable through bounded, authorized reads without exposing an unbounded escape hatch.</p><h4>Acceptance criteria</h4><ul><li>Preserve redaction before artifact persistence.</li><li>Expose bounded read and search operations.</li><li>Keep the exact Session relationship visible.</li></ul>',
      markdown: '# Make tool output recovery inspectable\n\nKeep large finalized tool output recoverable through bounded, authorized reads without exposing an unbounded escape hatch.\n\n## Acceptance criteria\n\n- Preserve redaction before artifact persistence.\n- Expose bounded read and search operations.\n- Keep the exact Session relationship visible.',
      references: [['tool-output-contract.md', '7.4 KB · text/markdown']],
    },
    remoteRecovery: {
      status: 'In progress', tone: 'progress', lane: 'in_progress', workCount: 1, plan: 'absent',
      contentHtml: '<h3>Recover remote projects after cold start</h3><p>Restore registered project runtime context after a remote host restart without treating a listening port as runtime readiness.</p><h4>Acceptance criteria</h4><ul><li>Validate project registry and runtime data.</li><li>Preserve durable Session recovery.</li><li>Report the exact failed prerequisite.</li></ul>',
      markdown: '# Recover remote projects after cold start\n\nRestore registered project runtime context after a remote host restart without treating a listening port as runtime readiness.\n\n## Acceptance criteria\n\n- Validate project registry and runtime data.\n- Preserve durable Session recovery.\n- Report the exact failed prerequisite.',
      references: [['cold-start-checklist.md', '4.1 KB · text/markdown']],
    },
    workspaceHealth: {
      status: 'Ready', tone: 'ready', lane: 'ready', workCount: 0, plan: 'absent',
      contentHtml: '<h3>Expose workspace health before bootstrap</h3><p>Show whether the registered project and its Runtime data are actually ready before offering work actions.</p><h4>Acceptance criteria</h4><ul><li>Separate listener health from Runtime readiness.</li><li>Identify the exact failing prerequisite.</li><li>Keep recovery actions inside their existing authority boundaries.</li></ul>',
      markdown: '# Expose workspace health before bootstrap\n\nShow whether the registered project and its Runtime data are actually ready before offering work actions.\n\n## Acceptance criteria\n\n- Separate listener health from Runtime readiness.\n- Identify the exact failing prerequisite.\n- Keep recovery actions inside their existing authority boundaries.',
      references: [],
    },
  };
  const sessionSamples = {
    running: {
      todo: 'profile', sourceLabel: 'Todo · Work', title: 'Implementation · Project profile defaults', eyebrow: 'WORK SESSION', status: 'Running', tone: 'live', composer: 'Running', composerTone: 'running', runStatus: 'Active', agentStatus: 'Running', agentTone: 'live',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Orchestrating and reviewing', children: true,
      queue: 'After typecheck, summarize Profile precedence and remaining risk.', checkout: 'Current checkout: codex/project-profile-defaults', cwd: 'codex/project-profile-defaults', agentCount: 3, changeCount: 3, tools: '18 tools', tokens: '76k tokens', contextTokens: '76,000', execution: 'Running',
    },
    permission: {
      todo: 'recovery', sourceLabel: 'Todo · Work', title: 'Recovery verification', eyebrow: 'WORK SESSION', status: 'Needs you', tone: 'attention', composer: 'Needs you', composerTone: 'attention', runStatus: 'Needs you', agentStatus: 'Permission', agentTone: 'attention',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Verifying safe recovery', children: false,
      queue: 'After permission resolves, summarize the recovery guarantees and remaining risk.', attachments: ['recovery-policy.diff', 'recovery-policy.test.ts'], checkout: 'Current checkout: recovery-policy', cwd: 'recovery-policy', agentCount: 1, changeCount: 0, tools: '8 tools', tokens: '18k tokens', contextTokens: '18,000', execution: 'Suspended · Permission',
    },
    'output-recovery-review': {
      todo: 'outputRecovery', sourceLabel: 'Todo · Work', title: 'Output recovery verification', eyebrow: 'WORK SESSION', status: 'Completed', tone: 'done', composer: 'Ready', composerTone: 'idle', runStatus: 'Completed', agentStatus: 'Completed', agentTone: 'done', idle: true,
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Bounded output recovery verified', children: false,
      queue: '', checkout: 'Current checkout: output-recovery', cwd: 'output-recovery', agentCount: 1, changeCount: 0, tools: '11 tools', tokens: '34k tokens', contextTokens: '34,000', execution: 'Completed',
    },
    'remote-recovery-failed': {
      todo: 'remoteRecovery', sourceLabel: 'Todo · Work', title: 'Remote recovery verification', eyebrow: 'WORK SESSION', status: 'Failed', tone: 'error', composer: 'Failed', composerTone: 'error', runStatus: 'Failed', agentStatus: 'Failed', agentTone: 'error', idle: true,
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Checking remote cold-start recovery', children: false,
      queue: '', checkout: 'Current checkout: remote-cold-start', cwd: 'remote-cold-start', agentCount: 1, changeCount: 0, tools: '10 tools', tokens: '29k tokens', contextTokens: '29,000', execution: 'Failed',
    },
    question: {
      todo: 'handoff', sourceLabel: 'Todo · Discussion', title: 'Handoff recommendation', eyebrow: 'DISCUSSION', status: 'Needs you', tone: 'attention', composer: 'Needs you', composerTone: 'attention', runStatus: 'Needs you', agentStatus: 'Question', agentTone: 'attention',
      rootRole: 'Discussion', rootMark: 'DI', rootClass: 'discussion', rootProfile: 'principal', rootObjective: 'Shaping Todo and Plan', children: false,
      queue: 'After I answer, update the Todo content and preserve the decision.', attachments: ['handoff-evidence.md', 'decision-matrix.md'], checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '4 tools', tokens: '12k tokens', contextTokens: '12,000', execution: 'Suspended · Question',
    },
    ready: {
      todo: 'audit', sourceLabel: 'Todo · Work', title: 'Audit trail implementation', eyebrow: 'WORK SESSION', status: 'Completed', tone: 'done', composer: 'Ready', composerTone: 'idle', runStatus: 'Completed', agentStatus: 'Completed', agentTone: 'done',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Permission audit completed', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '6 tools', tokens: '28k tokens', contextTokens: '28,000', execution: 'Completed', idle: true,
    },
    'plan-review': {
      todo: 'profile', sourceLabel: 'Todo · Discussion', title: 'Plan review', eyebrow: 'DISCUSSION', status: 'Completed', tone: 'done', composer: 'Ready', composerTone: 'idle', runStatus: 'Completed', agentStatus: 'Completed', agentTone: 'done',
      rootRole: 'Discussion', rootMark: 'DI', rootClass: 'discussion', rootProfile: 'principal', rootObjective: 'Plan review completed', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '5 tools', tokens: '24k tokens', contextTokens: '24,000', execution: 'Completed', idle: true,
    },
    exploration: {
      todo: 'profile', sourceLabel: 'Todo · Work', title: 'Explore configuration boundaries', eyebrow: 'WORK SESSION', status: 'Stopped', tone: 'neutral', composer: 'Ready', composerTone: 'idle', runStatus: 'Stopped', agentStatus: 'Stopped', agentTone: 'neutral',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Exploration stopped', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '9 tools', tokens: '17k tokens', contextTokens: '17,000', execution: 'Stopped', idle: true,
    },
    'initial-discussion': {
      todo: 'profile', sourceLabel: 'Todo · Discussion', title: 'Initial shaping', eyebrow: 'DISCUSSION', status: 'Completed', tone: 'done', composer: 'Ready', composerTone: 'idle', runStatus: 'Completed', agentStatus: 'Completed', agentTone: 'done',
      rootRole: 'Discussion', rootMark: 'DI', rootClass: 'discussion', rootProfile: 'principal', rootObjective: 'Todo shaping completed', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '4 tools', tokens: '15k tokens', contextTokens: '15,000', execution: 'Completed', idle: true,
    },
    'automation-review': {
      todo: 'profile', sourceLabel: 'Automation', title: 'Profile validation sweep', eyebrow: 'AUTOMATION SESSION', status: 'Completed', tone: 'done', composer: 'Ready', composerTone: 'idle', runStatus: 'Completed', agentStatus: 'Completed', agentTone: 'done',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Scheduled verification completed', children: false,
      queue: '', checkout: 'Managed worktree: profile-validation-sweep', cwd: 'profile-validation-sweep', agentCount: 1, changeCount: 0, tools: '7 tools', tokens: '21k tokens', contextTokens: '21,000', execution: 'Completed', idle: true,
    },
    'automation-live': {
      todo: 'profile', sourceLabel: 'Automation', title: 'Profile validation sweep', eyebrow: 'AUTOMATION SESSION', status: 'Running', tone: 'live', composer: 'Running', composerTone: 'running', runStatus: 'Active', agentStatus: 'Running', agentTone: 'live',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Running scheduled profile verification', children: false,
      queue: '', checkout: 'Managed worktree: profile-validation-sweep', cwd: 'profile-validation-sweep', agentCount: 1, changeCount: 0, tools: '7 tools', tokens: '1k tokens', contextTokens: '1,000', execution: 'Running',
    },
    'automation-memory-live': {
      todo: null, sourceLabel: 'Automation', backLabel: 'Schedules', backHref: './automations.html?automation=memory', title: 'Weekly memory quality review', eyebrow: 'AUTOMATION SESSION', status: 'Running', tone: 'live', composer: 'Running', composerTone: 'running', runStatus: 'Active', agentStatus: 'Running', agentTone: 'live',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Auditing durable memory', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '7 tools', tokens: '1k tokens', contextTokens: '1,000', execution: 'Running',
    },
    'automation-snapshot-live': {
      todo: null, sourceLabel: 'Automation', backLabel: 'Schedules', backHref: './automations.html?automation=snapshot', title: 'Nightly UI snapshot review', eyebrow: 'AUTOMATION SESSION', status: 'Running', tone: 'live', composer: 'Running', composerTone: 'running', runStatus: 'Active', agentStatus: 'Running', agentTone: 'live',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Reviewing scheduled UI snapshots', children: false,
      queue: '', checkout: 'Managed worktree: nightly-ui-snapshot-review', cwd: 'nightly-ui-snapshot-review', agentCount: 1, changeCount: 0, tools: '7 tools', tokens: '1k tokens', contextTokens: '1,000', execution: 'Running',
    },
    'automation-license-failed': {
      todo: null, sourceLabel: 'Automation', backLabel: 'Schedules', backHref: './automations.html?automation=license', title: 'Dependency license scan', eyebrow: 'AUTOMATION SESSION', status: 'Failed', tone: 'error', composer: 'Failed', composerTone: 'error', runStatus: 'Failed', agentStatus: 'Failed', agentTone: 'error', idle: true,
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Reporting the failed dependency scan', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '6 tools', tokens: '9k tokens', contextTokens: '9,000', execution: 'Failed',
    },
    'automation-license-live': {
      todo: null, sourceLabel: 'Automation', backLabel: 'Schedules', backHref: './automations.html?automation=license', title: 'Dependency license scan', eyebrow: 'AUTOMATION SESSION', status: 'Running', tone: 'live', composer: 'Running', composerTone: 'running', runStatus: 'Active', agentStatus: 'Running', agentTone: 'live',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Re-running the dependency license scan', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '6 tools', tokens: '1k tokens', contextTokens: '1,000', execution: 'Running',
    },
    'automation-retired-live': {
      todo: null, sourceLabel: 'Automation', backLabel: 'Schedules', backHref: './automations.html?automation=retired', title: 'Legacy provider compatibility check', eyebrow: 'AUTOMATION SESSION', status: 'Running', tone: 'live', composer: 'Running', composerTone: 'running', runStatus: 'Active', agentStatus: 'Running', agentTone: 'live',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Verifying the legacy provider boundary', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '5 tools', tokens: '1k tokens', contextTokens: '1,000', execution: 'Running',
    },
    'direct-release-live': {
      todo: null, sourceLabel: 'Direct', backLabel: 'Schedules', backHref: './automations.html?automation=release', title: 'Preserve approval state after restart', eyebrow: 'DIRECT SESSION', status: 'Running', tone: 'live', composer: 'Running', composerTone: 'running', runStatus: 'Active', agentStatus: 'Running', agentTone: 'live',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Rechecking release readiness', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '9 tools', tokens: '18k tokens', contextTokens: '18,000', execution: 'Running',
    },
    'direct-ready': {
      todo: null, sourceLabel: 'Direct', backLabel: 'Runs', backHref: './sessions.html', title: 'Untitled Session', eyebrow: 'DIRECT SESSION', status: 'Ready', tone: 'neutral', composer: 'Ready', composerTone: 'idle', runStatus: 'Ready', agentStatus: 'Ready', agentTone: 'neutral',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Waiting for the first message', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '12 tools', tokens: '0 tokens', contextTokens: '0', execution: 'Idle', idle: true,
    },
    'discussion-new': {
      todo: 'profile', dynamicTodo: true, sourceLabel: 'Todo · Discussion', title: 'Discussion · Model profile defaults', eyebrow: 'DISCUSSION', status: 'Running', tone: 'live', composer: 'Running', composerTone: 'running', runStatus: 'Active', agentStatus: 'Running', agentTone: 'live',
      rootRole: 'Discussion', rootMark: 'DI', rootClass: 'discussion', rootProfile: 'principal', rootObjective: 'Shaping the bound Todo', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '5 tools', tokens: '1k tokens', contextTokens: '1,000', execution: 'Running',
    },
    'automation-setup': {
      todo: 'profile', sourceLabel: 'Todo · Automation setup', title: 'Automation setup · Model profile defaults', eyebrow: 'AUTOMATION SETUP', status: 'Running', tone: 'live', composer: 'Running', composerTone: 'running', runStatus: 'Active', agentStatus: 'Running', agentTone: 'live',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Creating an Automation from the Todo', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '9 tools', tokens: '1k tokens', contextTokens: '1,000', execution: 'Running',
    },
    'work-new': {
      todo: 'profile', dynamicTodo: true, sourceLabel: 'Todo · Work', title: 'Work · Model profile defaults', eyebrow: 'WORK SESSION', status: 'Running', tone: 'live', composer: 'Running', composerTone: 'running', runStatus: 'Active', agentStatus: 'Running', agentTone: 'live',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Starting work from the bound Todo', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 1, changeCount: 0, tools: '12 tools', tokens: '1k tokens', contextTokens: '1,000', execution: 'Running',
    },
    'direct-completed': {
      todo: null, sourceLabel: 'Direct', backLabel: 'Runs', backHref: './sessions.html', title: 'Preserve approval state after restart', eyebrow: 'DIRECT SESSION', status: 'Completed', tone: 'done', composer: 'Ready', composerTone: 'idle', runStatus: 'Completed', agentStatus: 'Completed', agentTone: 'done',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Recovery verification completed', children: true,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 3, changeCount: 3, tools: '9 tools', tokens: '17k tokens', contextTokens: '17,000', execution: 'Completed', idle: true,
    },
    'automation-run': {
      todo: null, sourceLabel: 'Automation', backLabel: 'Schedules', backHref: './automations.html', title: 'Dependency health patrol', eyebrow: 'AUTOMATION SESSION', status: 'Completed', tone: 'done', composer: 'Ready', composerTone: 'idle', runStatus: 'Completed', agentStatus: 'Completed', agentTone: 'done',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'Dependency review completed', children: true,
      queue: '', checkout: 'Managed worktree: dependency-health-patrol', cwd: 'dependency-health-patrol', agentCount: 3, changeCount: 3, tools: '7 tools', tokens: '14k tokens', contextTokens: '14,000', execution: 'Completed', idle: true,
    },
    'todo-shell': {
      todo: 'dynamic', shellOnly: true, sourceLabel: 'Todo', title: 'Todo', eyebrow: 'TODO', status: 'Ready', tone: 'neutral', composer: 'Ready', composerTone: 'idle', runStatus: 'Ready', agentStatus: 'Ready', agentTone: 'neutral',
      rootRole: 'Lead', rootMark: 'LE', rootClass: 'lead', rootProfile: 'principal', rootObjective: 'No linked Session selected', children: false,
      queue: '', checkout: 'Current checkout: project root', cwd: 'project root', agentCount: 0, changeCount: 0, tools: '0 tools', tokens: '0 tokens', contextTokens: '0', execution: 'Idle', idle: true,
    },
  };
  const normalizeSessionSample = (name) => (sessionSamples[name] ? name : 'running');
  window.normalizePrototypeSessionSample = normalizeSessionSample;
  const workLists = {
    active: document.querySelector('[aria-labelledby="active-work-heading"] .work-session-list'),
    history: document.querySelector('[aria-labelledby="history-work-heading"] .work-session-list'),
  };
  document.querySelectorAll('[data-work-session-open]').forEach((row) => { row.dataset.workTodo = 'profile'; });
  const crossTodoRows = [
    ['active', 'permission', 'recovery', 'shield', 'Recovery verification', 'Work Session', 'recovery-policy', 'Needs you', 'attention', 'waiting now'],
    ['active', 'question', 'handoff', 'message', 'Handoff recommendation', 'Discussion', 'project root', 'Needs you', 'attention', 'waiting now'],
    ['history', 'output-recovery-review', 'outputRecovery', 'check', 'Output recovery verification', 'Work Session', 'output-recovery', 'Completed', 'done', '3m ago'],
    ['history', 'remote-recovery-failed', 'remoteRecovery', 'alert', 'Remote recovery verification', 'Work Session', 'remote-cold-start', 'Failed', 'error', '12:08'],
    ['history', 'ready', 'audit', 'check', 'Audit trail implementation', 'Work Session', 'project root', 'Completed', 'done', 'Yesterday'],
  ];
  crossTodoRows.forEach(([section, sample, todo, icon, title, type, checkout, status, tone, time]) => {
    if (!workLists[section] || document.querySelector(`[data-work-session-sample="${sample}"]`)) return;
    const row = document.createElement('button');
    row.className = 'work-session-row';
    row.type = 'button';
    row.dataset.workSessionOpen = '';
    row.dataset.workSessionSample = sample;
    row.dataset.workTodo = todo;
    row.dataset.workType = type === 'Discussion' ? 'discussion' : 'session';
    row.innerHTML = `<span class="work-session-icon"><span data-icon="${icon}"></span></span><span class="work-session-copy"><strong></strong><small><span></span><span></span></small></span><span class="work-session-state"><span class="status-label ${tone}"></span><small></small></span><span data-icon="chevron"></span>`;
    row.querySelector('.work-session-copy strong').textContent = title;
    const metadata = row.querySelectorAll('.work-session-copy small span');
    metadata[0].textContent = type;
    metadata[1].textContent = checkout;
    row.querySelector('.status-label').textContent = status;
    row.querySelector('.work-session-state small').textContent = time;
    workLists[section].appendChild(row);
    renderIcons(row);
  });
  const sessionSampleLinks = [...document.querySelectorAll('[data-session-sample]')];
  const todoLead = document.querySelector('[data-todo-lead]');
  const todoStatus = document.querySelector('[data-todo-status]');
  const todoWorkCount = document.querySelector('[data-work-count]');
  const todoContentView = document.querySelector('[data-todo-content-view]');
  const todoContentInput = document.querySelector('[data-todo-content-input]');
  const todoReferenceRows = [...document.querySelectorAll('[data-todo-reference-list] li')];
  const todoLifecycleButtons = [...document.querySelectorAll('[data-todo-lifecycle]')];
  const todoActions = document.querySelector('[data-todo-actions]');
  const todoActionsToggle = document.querySelector('[data-todo-actions-toggle]');
  const todoActionsMenu = document.querySelector('[data-todo-actions-menu]');
  const todoRejectButton = document.querySelector('[data-todo-reject]');
  const todoArchiveButton = document.querySelector('[data-todo-archive]');
  const todoRestoreButton = document.querySelector('[data-todo-restore]');
  const todoRejectEditor = document.querySelector('[data-todo-reject-editor]');
  const todoResult = document.querySelector('[data-todo-result]');
  const todoResultHeading = document.querySelector('[data-todo-result-heading]');
  const todoResultCopy = document.querySelector('[data-todo-result-copy]');
  const demoAttachmentRows = [...document.querySelectorAll('[data-demo-attachment]')];
  const sessionTitle = document.querySelector('[data-session-title]');
  const sessionEyebrow = document.querySelector('[data-session-eyebrow]');
  const sessionStatus = document.querySelector('[data-session-status]');
  const sessionStatusCopy = document.querySelector('[data-session-status-copy]');
  const sessionCheckout = document.querySelector('[data-session-checkout]');
  const sessionSource = document.querySelector('[data-session-source]');
  const sessionBackLabel = document.querySelector('[data-work-back-label]');
  const sessionBackButton = document.querySelector('[data-work-back]');
  const todoShellHeader = document.querySelector('.todo-shell-header');
  const sessionTools = document.querySelector('[data-session-tools]');
  const sessionTokens = document.querySelector('[data-session-tokens]');
  const sessionAgentCount = document.querySelector('[data-session-agent-count]');
  const sessionChangeCount = document.querySelector('[data-session-change-count]');
  const sessionChangePresent = document.querySelector('[data-session-change-present]');
  const sessionChangeEmpty = document.querySelector('[data-session-change-empty]');
  const sessionFullDiffAction = document.querySelector('[data-open-work-diff]');
  const composerState = document.querySelector('[data-composer-state]');
  const composerStateCopy = document.querySelector('[data-composer-state-copy]');
  const composerHint = document.querySelector('[data-composer-hint]');
  const queuePrimaryCopy = document.querySelector('[data-queue-primary-copy]');
  const inspectorAgentStatus = document.querySelector('[data-inspector-agent-status]');
  const inspectorRootMark = document.querySelector('[data-inspector-root-mark]');
  const inspectorRootRole = document.querySelector('[data-inspector-root-role]');
  const inspectorRootProfile = document.querySelector('[data-inspector-root-profile]');
  const inspectorRootObjective = document.querySelector('[data-inspector-root-objective]');
  const inspectorChildBranch = document.querySelector('[data-inspector-child-branch]');
  const contextExecution = document.querySelector('[data-context-execution]');
  const contextModel = document.querySelector('[data-context-model]');
  const contextTokens = document.querySelector('[data-context-tokens]');
  const contextCwd = document.querySelector('[data-context-cwd]');
  const sessionQueue = document.querySelector('[data-session-queue]');
  const composerInput = document.querySelector('[data-session-composer-input]');
  const terminalAction = document.querySelector('[data-session-terminal-action]');
  const slashMenu = document.querySelector('[data-composer-slash-menu]');
  const todoDiscussionActions = [...document.querySelectorAll('[data-create-todo-session="discussion-new"], [data-todo-plan-action], [data-todo-discuss]')];
  const todoExecutionActions = [...document.querySelectorAll('[data-create-todo-session="work-new"], [data-create-todo-session="automation-setup"], [data-todo-primary-work]')];
  let currentTodoLifecycle = 'idea';
  let lastActiveTodoLane = 'idea';
  let archivedTodoLifecycle;
  const resolvedHitlSamples = new Set();

  function setTodoActionsMenu(open, restoreFocus = false) {
    if (!todoActionsMenu || !todoActionsToggle) return;
    todoActionsMenu.hidden = !open;
    todoActionsToggle.setAttribute('aria-expanded', String(open));
    if (open) requestAnimationFrame(() => todoActionsMenu.querySelector('[role="menuitem"]')?.focus());
    else if (restoreFocus) todoActionsToggle.focus();
  }

  function syncTodoExceptionalActions(state = 'active') {
    const recovery = state === 'rejected' || state === 'archived';
    if (todoActions) todoActions.hidden = recovery;
    if (todoRestoreButton) {
      todoRestoreButton.hidden = !recovery;
      todoRestoreButton.textContent = state === 'rejected' ? 'Restore to Idea' : 'Restore';
    }
    if (recovery) setTodoActionsMenu(false);
  }

  todoActionsToggle?.addEventListener('click', (event) => {
    event.stopPropagation();
    setTodoActionsMenu(todoActionsMenu?.hidden ?? true);
  });
  todoActionsToggle?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && todoActionsMenu?.hidden) {
      event.preventDefault();
      setTodoActionsMenu(true);
    } else if (event.key === 'Escape' && !todoActionsMenu?.hidden) {
      event.preventDefault();
      setTodoActionsMenu(false, true);
    }
  });
  todoActionsMenu?.addEventListener('keydown', (event) => {
    const items = [...todoActionsMenu.querySelectorAll('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement);
    const nextIndex = event.key === 'ArrowDown'
      ? (index + 1) % items.length
      : event.key === 'ArrowUp'
        ? (index - 1 + items.length) % items.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : null;
    if (nextIndex !== null) {
      event.preventDefault();
      items[nextIndex]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setTodoActionsMenu(false, true);
    }
  });
  todoActions?.addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      if (!todoActions.contains(document.activeElement)) setTodoActionsMenu(false);
    });
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-todo-actions]')) return;
    setTodoActionsMenu(false);
  });

  demoAttachmentRows.forEach((row) => { row.dataset.attachmentOwner = 'permission'; });
  if (composerAttachments) {
    sessionSamples.question.attachments.forEach((filename) => {
      const item = document.createElement('li');
      item.className = 'composer-attachment';
      item.dataset.attachmentOwner = 'question';
      item.innerHTML = `<span data-icon="file"></span><strong>${filename}</strong><button type="button" aria-label="Remove ${filename}" data-icon="close"></button>`;
      composerAttachments.appendChild(item);
      renderIcons(item);
      bindComposerAttachment(item);
    });
  }

  function bindWorkDisclosure(button) {
    if (!button || button.dataset.disclosureBound) return;
    button.dataset.disclosureBound = 'true';
    button.addEventListener('click', () => {
      const bodyId = button.getAttribute('aria-controls');
      const body = bodyId ? document.getElementById(bodyId) : null;
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open));
      const segment = button.closest('.work-segment');
      if (body) {
        body.hidden = !open;
        body.classList.remove('work-body-reveal');
        if (open) requestAnimationFrame(() => body.classList.add('work-body-reveal'));
      }
      if (segment) {
        segment.classList.remove('work-state-changing');
        requestAnimationFrame(() => {
          segment.classList.add('work-state-changing');
          window.setTimeout(() => segment.classList.remove('work-state-changing'), 180);
        });
      }
    });
  }
  document.querySelectorAll('[data-work-disclosure]').forEach(bindWorkDisclosure);

  function composerHasSendableDraft() {
    const hasText = Boolean(composerInput?.value.trim());
    const hasFiles = Boolean(composerAttachments && !composerAttachments.hidden && composerAttachments.querySelector('.composer-attachment:not([hidden])'));
    return hasText || hasFiles;
  }

  function syncTerminalAction(sampleName = document.body.dataset.sessionSample || 'running') {
    if (!terminalAction) return;
    const ready = Boolean(sessionSamples[sampleName]?.idle);
    const hasDraft = composerHasSendableDraft();
    const mode = ready ? 'send' : hasDraft ? 'queue' : 'stop';
    const previousMode = terminalAction.dataset.actionMode;
    terminalAction.dataset.actionMode = mode;
    terminalAction.classList.toggle('stop', mode === 'stop');
    terminalAction.disabled = ready && !hasDraft;
    terminalAction.setAttribute('aria-label', mode === 'stop' ? 'Stop session' : mode === 'queue' ? 'Queue message' : 'Send message');
    terminalAction.setAttribute('title', mode === 'stop' ? 'Stop' : mode === 'queue' ? 'Queue message' : 'Send message');
    const iconNode = terminalAction.querySelector('[data-icon]');
    if (iconNode) {
      iconNode.dataset.icon = mode === 'stop' ? 'square' : 'arrow-up';
      delete iconNode.dataset.iconReady;
      iconNode.innerHTML = '';
      renderIcons(terminalAction);
    }
    if (previousMode && previousMode !== mode) {
      terminalAction.classList.remove('mode-changing');
      requestAnimationFrame(() => {
        terminalAction.classList.add('mode-changing');
        window.setTimeout(() => terminalAction.classList.remove('mode-changing'), 180);
      });
    }
  }

  function syncSessionQueueVisibility(sampleName = document.body.dataset.sessionSample) {
    if (!sessionQueue) return;
    sessionQueue.querySelectorAll('[data-queue-row]').forEach((row) => { row.hidden = row.dataset.queueOwner !== sampleName; });
    sessionQueue.hidden = !sessionQueue.querySelector('[data-queue-row]:not([hidden])');
  }

  function syncComposerAttachments(sampleName = document.body.dataset.sessionSample) {
    if (!composerAttachments) return;
    composerAttachments.querySelectorAll('.composer-attachment').forEach((item) => { item.hidden = item.dataset.attachmentOwner !== sampleName; });
    composerAttachments.hidden = !composerAttachments.querySelector('.composer-attachment:not([hidden])');
  }

  function syncTodoEntryActions(lane = currentTodoLifecycle, archived = false) {
    todoDiscussionActions.forEach((action) => { action.hidden = archived; });
    const canStartExecution = !archived && ['ready', 'in_progress'].includes(lane);
    todoExecutionActions.forEach((action) => { action.hidden = !canStartExecution; });
  }

  function applyTodoFixture(sample) {
    if (!sample.todo) {
      document.body.dataset.todoKey = '';
      document.querySelectorAll('[data-work-session-open]').forEach((row) => { row.hidden = true; });
      document.querySelectorAll('.work-list-section').forEach((section) => { section.hidden = true; });
      return;
    }
    const todoRoute = new URL(location.href);
    const requestedTodoKey = todoRoute.searchParams.get('todo');
    const requestedLane = todoRoute.searchParams.get('lane');
    const requestedState = todoRoute.searchParams.get('state');
    const storedTodoKey = requestedTodoKey || sample.todo;
    const storedTodo = prototypeTodoById(storedTodoKey);
    let routeWasInvalid = false;
    if (requestedLane && !['idea', 'ready', 'in_progress', 'done'].includes(requestedLane)) {
      todoRoute.searchParams.delete('lane');
      routeWasInvalid = true;
    }
    if (requestedState && !['rejected', 'archived'].includes(requestedState)) {
      todoRoute.searchParams.delete('state');
      routeWasInvalid = true;
    }
    const dynamicLane = ['idea', 'ready', 'in_progress', 'done'].includes(requestedLane)
      ? requestedLane
      : storedTodo?.lane || 'idea';
    const dynamicPresentation = {
      idea: ['Idea', 'neutral'], ready: ['Ready', 'ready'], in_progress: ['In progress', 'progress'], done: ['Done', 'done'],
    };
    const baseFixture = todoFixtures[sample.todo] || todoFixtures.profile;
    const dynamicFixture = Boolean((sample.shellOnly || sample.dynamicTodo) && storedTodo);
    const storedFixtureOverride = Boolean(storedTodo && !dynamicFixture);
    const fixture = dynamicFixture
      ? {
          status: dynamicPresentation[dynamicLane][0],
          tone: dynamicPresentation[dynamicLane][1],
          lane: dynamicLane,
          workCount: sample.shellOnly ? 0 : 1,
          plan: 'absent',
          contentHtml: renderPrototypeMarkdown(storedTodo.content),
          markdown: storedTodo.content,
          references: [],
        }
      : storedFixtureOverride
        ? {
            ...baseFixture,
            status: dynamicPresentation[dynamicLane][0],
            tone: dynamicPresentation[dynamicLane][1],
            lane: dynamicLane,
            contentHtml: renderPrototypeMarkdown(storedTodo.content),
            markdown: storedTodo.content,
          }
      : requestedLane && ['idea', 'ready', 'in_progress', 'done'].includes(requestedLane)
        ? { ...baseFixture, status: dynamicPresentation[dynamicLane][0], tone: dynamicPresentation[dynamicLane][1], lane: dynamicLane }
        : baseFixture;
    const createdTodoSession = sample.dynamicTodo && (dynamicFixture || requestedTodoKey);
    const fixtureLead = projectTodoDisplayLead(fixture.markdown);
    const fixtureKey = dynamicFixture ? requestedTodoKey : sample.todo;
    document.body.dataset.todoKey = fixtureKey;
    let dynamicWorkRow = document.querySelector('[data-dynamic-work-row]');
    if (createdTodoSession && !sample.shellOnly && !dynamicWorkRow && workLists.active) {
      dynamicWorkRow = document.createElement('button');
      dynamicWorkRow.type = 'button';
      dynamicWorkRow.className = 'work-session-row';
      dynamicWorkRow.dataset.dynamicWorkRow = '';
      dynamicWorkRow.dataset.workSessionOpen = '';
      dynamicWorkRow.dataset.workTodo = 'dynamic';
      dynamicWorkRow.innerHTML = '<span class="work-session-icon live"><span class="tool-spinner"></span></span><span class="work-session-copy"><strong></strong><small><span></span><span>project root</span></small></span><span class="work-session-state"><span class="status-label live">Running</span><small>active now</small></span><span data-icon="chevron"></span>';
      workLists.active.appendChild(dynamicWorkRow);
      renderIcons(dynamicWorkRow);
    }
    if (dynamicWorkRow && createdTodoSession && !sample.shellOnly) {
      dynamicWorkRow.dataset.workTodo = fixtureKey;
      dynamicWorkRow.dataset.workSessionSample = document.body.dataset.sessionSample;
      dynamicWorkRow.dataset.workType = document.body.dataset.sessionSample === 'discussion-new' ? 'discussion' : 'session';
      const dynamicKind = document.body.dataset.sessionSample === 'discussion-new' ? 'Discussion' : 'Work Session';
      dynamicWorkRow.querySelector('.work-session-copy strong').textContent = `${dynamicKind === 'Discussion' ? 'Discussion' : 'Work'} · ${fixtureLead}`;
      dynamicWorkRow.querySelector('.work-session-copy small span').textContent = dynamicKind;
    }
    currentTodoLifecycle = fixture.lane;
    lastActiveTodoLane = fixture.lane;
    archivedTodoLifecycle = undefined;
    if (todoLead) todoLead.textContent = fixtureLead;
    if (todoStatus) {
      todoStatus.textContent = fixture.status;
      todoStatus.className = `status-label ${fixture.tone}`;
    }
    if (todoWorkCount) todoWorkCount.textContent = String(fixture.workCount);
    todoLifecycleButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.todoLifecycle === fixture.lane)));
    syncTodoExceptionalActions('active');
    todoLifecycleButtons.forEach((button) => { button.disabled = false; });
    syncTodoEntryActions(fixture.lane, false);
    if (todoRejectEditor) todoRejectEditor.hidden = true;
    if (todoContentView) todoContentView.innerHTML = fixture.contentHtml;
    if (todoContentInput) todoContentInput.value = fixture.markdown;
    const requestedPlan = todoRoute.searchParams.get('plan');
    if (requestedPlan && !['present', 'absent', 'empty'].includes(requestedPlan)) {
      todoRoute.searchParams.delete('plan');
      routeWasInvalid = true;
    }
    const planState = ['present', 'absent', 'empty'].includes(requestedPlan) ? requestedPlan : fixture.plan;
    document.querySelectorAll('[data-todo-plan-state]').forEach((section) => { section.hidden = section.dataset.todoPlanState !== planState; });
    todoReferenceRows.forEach((row, index) => {
      const reference = fixture.references[index];
      row.hidden = !reference;
      if (!reference) return;
      const [name, metadata] = reference;
      const strong = row.querySelector('strong');
      const small = row.querySelector('small');
      if (strong) strong.textContent = name;
      if (small) small.textContent = metadata;
      const openButton = row.querySelector('.todo-reference-actions button:first-child');
      if (openButton && !openButton.disabled) openButton.dataset.toast = `${openButton.textContent.trim()}ing ${name}`;
    });
    if (todoResult) todoResult.hidden = !fixture.result;
    if (todoResultHeading) todoResultHeading.textContent = fixture.lane === 'done' ? 'Accepted outcome' : 'Result for review';
    if (todoResultCopy) todoResultCopy.textContent = fixture.result || '';
    document.querySelectorAll('[data-work-session-open]').forEach((row) => {
      row.hidden = row.dataset.workTodo !== fixtureKey;
    });
    document.querySelectorAll('.work-list-section').forEach((section) => {
      const visible = [...section.querySelectorAll('[data-work-session-open]')].filter((row) => !row.hidden);
      section.hidden = visible.length === 0;
      const count = section.querySelector('.work-list-section-head b');
      if (count) count.textContent = String(visible.length);
    });
    const workEmpty = document.querySelector('[data-work-empty]');
    if (workEmpty) workEmpty.hidden = [...document.querySelectorAll('[data-work-session-open]')].some((row) => !row.hidden);
    if (requestedState === 'rejected') {
      currentTodoLifecycle = 'rejected';
      todoLifecycleButtons.forEach((button) => { button.setAttribute('aria-pressed', 'false'); button.disabled = true; });
      if (todoStatus) { todoStatus.textContent = 'Rejected'; todoStatus.className = 'status-label attention'; }
      syncTodoExceptionalActions('rejected');
      syncTodoEntryActions('rejected', false);
    } else if (requestedState === 'archived') {
      archivedTodoLifecycle = todoRoute.searchParams.get('archivedFrom') === 'rejected' ? 'rejected' : fixture.lane;
      todoLifecycleButtons.forEach((button) => { button.disabled = true; });
      syncTodoExceptionalActions('archived');
      if (todoStatus) { todoStatus.textContent = 'Archived'; todoStatus.className = 'status-label neutral'; }
      syncTodoEntryActions(fixture.lane, true);
    }
    if (routeWasInvalid) history.replaceState(history.state, '', `${todoRoute.pathname.split('/').pop()}${todoRoute.search}`);
  }

  const todoLanePresentation = {
    idea: ['Idea', 'neutral'],
    ready: ['Ready', 'ready'],
    in_progress: ['In progress', 'progress'],
    done: ['Done', 'done'],
  };
  function updateTodoDetailRouteAndNavigator(lane = lastActiveTodoLane, state) {
    const route = new URL(location.href);
    route.searchParams.set('lane', lane);
    if (state) route.searchParams.set('state', state);
    else route.searchParams.delete('state');
    if (state === 'archived') route.searchParams.set('archivedFrom', archivedTodoLifecycle || lane);
    else route.searchParams.delete('archivedFrom');
    history.replaceState(history.state, '', `${route.pathname.split('/').pop()}${route.search}`);

    const displayLead = todoLead?.textContent.trim();
    const navRows = [...document.querySelectorAll('.todo-nav .nav-row')];
    const row = navRows.find((item) => {
      const group = item.closest('.nav-section')?.querySelector('.nav-section-title span')?.textContent.trim();
      return (group === 'In progress' || group === 'Ready')
        && item.querySelector('span:nth-child(2)')?.textContent.trim() === displayLead;
    });
    navRows.forEach((item) => item.classList.remove('active'));
    if (!row) return;
    const sourceSection = row.closest('.nav-section');
    const sourceLabel = sourceSection?.querySelector('.nav-section-title span')?.textContent.trim();
    const targetLabel = !state && lane === 'ready' ? 'Ready' : !state && lane === 'in_progress' ? 'In progress' : undefined;
    const targetSection = targetLabel
      ? [...document.querySelectorAll('.todo-nav .nav-section')].find((section) => section.querySelector('.nav-section-title span')?.textContent.trim() === targetLabel)
      : undefined;
    const bump = (section, delta) => {
      const badge = section?.querySelector('.nav-section-title b');
      if (badge) badge.textContent = String(Math.max(0, Number(badge.textContent) + delta));
    };
    const wasVisible = !row.hidden;
    if (!targetSection) {
      if (wasVisible) bump(sourceSection, -1);
      row.hidden = true;
      return;
    }
    if (!wasVisible || sourceLabel !== targetLabel) {
      if (wasVisible) bump(sourceSection, -1);
      bump(targetSection, 1);
      targetSection.appendChild(row);
    }
    row.hidden = false;
    row.classList.add('active');
    const status = row.querySelector('.nav-status');
    if (status) status.className = `nav-status ${lane === 'ready' ? 'ready' : 'progress'}`;
    row.href = `${route.pathname.split('/').pop()}${route.search}`;
  }
  function applyTodoLifecycleLane(lane) {
    const [label, tone] = todoLanePresentation[lane] || todoLanePresentation.idea;
    currentTodoLifecycle = lane;
    lastActiveTodoLane = lane;
    archivedTodoLifecycle = undefined;
    todoLifecycleButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.todoLifecycle === lane)));
    if (todoStatus) {
      todoStatus.textContent = label;
      todoStatus.className = `status-label ${tone}`;
    }
    if (todoResultHeading && !todoResult?.hidden) todoResultHeading.textContent = lane === 'done' ? 'Accepted outcome' : 'Result for review';
    todoLifecycleButtons.forEach((button) => { button.disabled = false; });
    syncTodoExceptionalActions('active');
    syncTodoEntryActions(lane, false);
    updatePrototypeTodoLane(document.body.dataset.todoKey, lane);
    updateTodoDetailRouteAndNavigator(lane);
  }
  todoLifecycleButtons.forEach((button) => button.addEventListener('click', () => applyTodoLifecycleLane(button.dataset.todoLifecycle)));
  todoRejectButton?.addEventListener('click', () => {
    setTodoActionsMenu(false);
    if (todoActions) todoActions.hidden = true;
    if (todoRejectEditor) todoRejectEditor.hidden = false;
    todoRejectEditor?.querySelector('input')?.focus();
  });
  document.querySelector('[data-todo-reject-cancel]')?.addEventListener('click', () => {
    if (todoRejectEditor) todoRejectEditor.hidden = true;
    syncTodoExceptionalActions('active');
    todoActionsToggle?.focus();
  });
  document.querySelector('[data-todo-reject-confirm]')?.addEventListener('click', () => {
    const reason = todoRejectEditor?.querySelector('input')?.value.trim();
    if (!reason) return todoRejectEditor?.querySelector('input')?.focus();
    todoLifecycleButtons.forEach((button) => { button.setAttribute('aria-pressed', 'false'); button.disabled = true; });
    currentTodoLifecycle = 'rejected';
    if (todoStatus) { todoStatus.textContent = 'Rejected'; todoStatus.className = 'status-label attention'; }
    if (todoResultHeading && !todoResult?.hidden) todoResultHeading.textContent = 'Result for review';
    if (todoRejectEditor) todoRejectEditor.hidden = true;
    syncTodoExceptionalActions('rejected');
    requestAnimationFrame(() => todoRestoreButton?.focus());
    syncTodoEntryActions('rejected', false);
    updateTodoDetailRouteAndNavigator(lastActiveTodoLane, 'rejected');
    showToast('Todo rejected with the recorded reason.');
  });
  todoArchiveButton?.addEventListener('click', () => {
    setTodoActionsMenu(false);
    archivedTodoLifecycle = currentTodoLifecycle;
    todoLifecycleButtons.forEach((button) => { button.disabled = true; });
    if (todoStatus) { todoStatus.textContent = 'Archived'; todoStatus.className = 'status-label neutral'; }
    syncTodoExceptionalActions('archived');
    requestAnimationFrame(() => todoRestoreButton?.focus());
    syncTodoEntryActions(currentTodoLifecycle, true);
    updateTodoDetailRouteAndNavigator(lastActiveTodoLane, 'archived');
    showToast('Todo archived. Restore remains available here and in Archived.');
  });
  todoRestoreButton?.addEventListener('click', () => {
    if (currentTodoLifecycle === 'rejected' && !archivedTodoLifecycle) {
      todoLifecycleButtons.forEach((button) => { button.disabled = false; });
      applyTodoLifecycleLane('idea');
      showToast('Todo restored to Idea.');
      return;
    }
    if (archivedTodoLifecycle === 'rejected') {
      currentTodoLifecycle = 'rejected';
      archivedTodoLifecycle = undefined;
      todoLifecycleButtons.forEach((button) => { button.setAttribute('aria-pressed', 'false'); button.disabled = true; });
      if (todoStatus) { todoStatus.textContent = 'Rejected'; todoStatus.className = 'status-label attention'; }
      syncTodoExceptionalActions('rejected');
      syncTodoEntryActions('rejected', false);
      updateTodoDetailRouteAndNavigator(lastActiveTodoLane, 'rejected');
      showToast('Todo restored to Rejected.');
      return;
    }
    const restoreLane = archivedTodoLifecycle || lastActiveTodoLane || 'idea';
    todoLifecycleButtons.forEach((button) => { button.disabled = false; });
    applyTodoLifecycleLane(restoreLane);
    showToast(`Todo restored to ${todoLanePresentation[restoreLane]?.[0] || 'Idea'}.`);
  });
  document.querySelector('[data-result-session-open]')?.addEventListener('click', () => {
    window.openPrototypeSessionSample?.(document.body.dataset.sessionSample || 'ready');
  });

  function selectAgentSession(target, updateHistory = false) {
    const sampleName = document.body.dataset.sessionSample || 'running';
    const sample = sessionSamples[sampleName];
    const validTarget = sample?.children && ['analyst', 'build'].includes(target) ? target : 'lead';
    document.querySelectorAll('[data-agent-session-target]').forEach((item) => {
      const selected = item.dataset.agentSessionTarget === validTarget;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    const rootThread = document.querySelector(`[data-session-thread="${sampleName}"]`);
    if (rootThread) rootThread.hidden = validTarget !== 'lead';
    document.querySelectorAll('[data-agent-session]').forEach((session) => { session.hidden = session.dataset.agentSession !== validTarget; });
    if (updateHistory) {
      const url = new URL(location.href);
      if (validTarget === 'lead') url.searchParams.delete('focus');
      else url.searchParams.set('focus', validTarget);
      history.pushState({ ...(history.state || {}), focus: validTarget }, '', `${url.pathname.split('/').pop()}${url.search}`);
    } else if (target && validTarget === 'lead') {
      const url = new URL(location.href);
      url.searchParams.delete('focus');
      history.replaceState(history.state, '', `${url.pathname.split('/').pop()}${url.search}`);
    }
    document.querySelector('.workbench-scroll')?.scrollTo({ top: 0, behavior: updateHistory ? 'smooth' : 'auto' });
  }

  const sourceFixtureVisuals = {
    'direct-completed': {
      analystObjective: 'Child of Lead · approval-state analysis',
      analystResult: 'The restart path preserves the exact approval request and resumes the same logical Execution without creating a compatibility continuation.',
      buildObjective: 'Child of Lead · recovery verification',
      diffTitle: '2 files changed',
      diffScope: 'project root · approval recovery verification',
      files: ['packages/agent-core/src/hitl/approval-store.ts', 'packages/agent-core/src/hitl/approval-store.test.ts'],
    },
    'automation-run': {
      analystObjective: 'Child of Lead · dependency policy analysis',
      analystResult: 'The scheduled invocation retained its Automation source and wrote changes only inside the invocation Session checkout.',
      buildObjective: 'Child of Lead · dependency verification',
      diffTitle: '3 files changed',
      diffScope: 'dependency-health-patrol · Automation invocation checkout',
      files: ['packages/agent-core/src/automations/invocation.ts', 'packages/agent-core/src/automations/service.ts', 'packages/agent-core/src/automations/service.test.ts'],
    },
  };
  function syncSourceFixtureVisuals(sampleName) {
    const fixture = sourceFixtureVisuals[sampleName];
    const analystObjective = document.querySelector('[data-agent-session="analyst"] .agent-session-heading small');
    const analystResult = document.querySelector('[data-agent-session="analyst"] .final-response p');
    const buildObjective = document.querySelector('[data-agent-session="build"] .agent-session-heading small');
    const diffHeading = document.querySelector('[data-work-diff-heading]');
    const diffScope = document.querySelector('.work-diff-head p');
    const diffFiles = [...document.querySelectorAll('.work-diff-page .file-change header strong')];
    if (analystObjective) analystObjective.textContent = fixture?.analystObjective || 'Child of Lead · contract analysis';
    if (analystResult) analystResult.textContent = fixture?.analystResult || 'Use one strict project-owned partial profile map and resolve it before Session admission. Unknown model or variant references must fail bootstrap rather than fall through.';
    if (buildObjective) buildObjective.textContent = fixture?.buildObjective || 'Child of Lead · implementation';
    if (diffHeading) diffHeading.textContent = fixture?.diffTitle || '3 files changed';
    if (diffScope) diffScope.textContent = fixture?.diffScope || 'codex/project-profile-defaults · relative to the current checkout base';
    diffFiles.forEach((file, index) => {
      file.closest('.file-change').hidden = Boolean(fixture && index >= fixture.files.length);
      file.textContent = fixture?.files[index] || ['packages/agent-core/src/config/schema.ts', 'packages/agent-core/src/projects/context-resolver.ts', 'packages/agent-core/src/config/schema.test.ts'][index];
    });
  }

  function setSessionSample(name, updateHistory = false) {
    const sampleName = normalizeSessionSample(name);
    const sampleBase = sessionSamples[sampleName];
    const requestedTodoKey = new URLSearchParams(location.search).get('todo');
    const sample = requestedTodoKey && todoFixtures[requestedTodoKey]
      ? { ...sampleBase, todo: requestedTodoKey }
      : sampleBase;
    if (composerInput && currentComposerDraftSample && currentComposerDraftSample !== sampleName) {
      composerDrafts.set(currentComposerDraftSample, composerInput.value);
    }
    currentComposerDraftSample = sampleName;
    if (composerInput) composerInput.value = composerDrafts.get(sampleName) || '';
    document.body.dataset.sessionSample = sampleName;
    document.body.dataset.sessionTodoBound = String(Boolean(sample.todo));
    document.body.dataset.sessionShellOnly = String(Boolean(sample.shellOnly));
    document.body.dataset.sessionBackHref = sample.backHref || '';
    document.body.classList.toggle('source-only-session', !sample.todo);
    syncSourceFixtureVisuals(sampleName);
    if (todoShellHeader) todoShellHeader.hidden = !sample.todo;
    applyTodoFixture(sample);
    const todoRouteParams = new URLSearchParams(location.search);
    const requestedLifecycle = todoRouteParams.get('lane');
    const requestedTodoState = todoRouteParams.get('state');
    const baseLifecycle = prototypeTodoById(requestedTodoKey || sample.todo)?.lane || todoFixtures[sample.todo]?.lane;
    if (sample.todo && (requestedTodoState || (requestedLifecycle && baseLifecycle && requestedLifecycle !== baseLifecycle))) {
      updateTodoDetailRouteAndNavigator(lastActiveTodoLane, requestedTodoState || undefined);
    } else if (sample.shellOnly && todoLead) {
      const exactNavRow = [...document.querySelectorAll('.todo-nav .nav-row')].find((row) => row.querySelector('span:nth-child(2)')?.textContent.trim() === todoLead.textContent.trim());
      if (exactNavRow) {
        document.querySelectorAll('.todo-nav .nav-row').forEach((row) => row.classList.toggle('active', row === exactNavRow));
      }
    }
    document.querySelectorAll('[data-session-thread]').forEach((thread) => { thread.hidden = thread.dataset.sessionThread !== sampleName; });
    document.querySelectorAll('[data-agent-session]').forEach((thread) => { thread.hidden = true; });
    document.querySelectorAll('[data-agent-session-target]').forEach((button) => {
      const selected = button.dataset.agentSessionTarget === 'lead';
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      if (button.dataset.agentSessionTarget !== 'lead') button.hidden = !sample.children;
    });
    if (inspectorChildBranch) inspectorChildBranch.hidden = !sample.children;
    document.querySelectorAll('[data-hitl-card]').forEach((card) => { card.hidden = card.dataset.hitlCard !== sampleName || resolvedHitlSamples.has(sampleName); });
    const dynamicSessionPrefix = sampleName === 'discussion-new' ? 'Discussion' : sampleName === 'work-new' ? 'Work' : '';
    if (sessionTitle) sessionTitle.textContent = sample.dynamicTodo && requestedTodoKey
      ? `${dynamicSessionPrefix} · ${todoLead?.textContent || 'Todo'}`
      : sample.title;
    if (sessionEyebrow) sessionEyebrow.textContent = sample.eyebrow;
    if (sessionStatusCopy) sessionStatusCopy.textContent = sample.status;
    if (sessionStatus) sessionStatus.className = `status-label ${sample.tone}`;
    sessionStatus?.querySelector('.pulse-dot')?.toggleAttribute('hidden', sample.tone !== 'live');
    if (sessionCheckout) sessionCheckout.textContent = sample.checkout;
    if (sessionSource) sessionSource.textContent = sample.sourceLabel || 'Todo · Work';
    if (sessionBackLabel) sessionBackLabel.textContent = sample.backLabel || 'All work';
    if (sessionBackButton) sessionBackButton.dataset.backHref = sample.backHref || '';
    if (sessionTools) sessionTools.textContent = sample.tools;
    if (sessionTokens) sessionTokens.textContent = sample.tokens;
    if (sessionAgentCount) sessionAgentCount.textContent = String(sample.agentCount);
    if (sessionChangeCount) sessionChangeCount.textContent = String(sample.changeCount);
    if (sessionChangePresent) sessionChangePresent.hidden = sample.changeCount === 0;
    if (sessionChangeEmpty) sessionChangeEmpty.hidden = sample.changeCount !== 0;
    if (sessionFullDiffAction) sessionFullDiffAction.hidden = sample.changeCount === 0 || document.body.classList.contains('work-diff-surface');
    if (composerStateCopy) composerStateCopy.textContent = sample.composer;
    if (composerHint) composerHint.textContent = 'Shift+Enter for newline';
    if (composerState) composerState.className = `composer-state ${sample.composerTone}`;
    if (inspectorAgentStatus) { inspectorAgentStatus.textContent = sample.agentStatus; inspectorAgentStatus.className = `status-label ${sample.agentTone}`; }
    if (inspectorRootMark) {
      inspectorRootMark.textContent = sample.rootMark;
      inspectorRootMark.className = `agent-node ${sample.rootClass}`;
    }
    if (inspectorRootRole) inspectorRootRole.textContent = sample.rootRole;
    if (inspectorRootProfile) inspectorRootProfile.textContent = sample.rootProfile;
    if (inspectorRootObjective) inspectorRootObjective.textContent = sample.rootObjective;
    if (contextExecution) contextExecution.textContent = sample.execution;
    if (contextModel) contextModel.textContent = `${modelLabel?.textContent || 'GPT-5.6 Luna'} · ${variantLabel?.textContent || 'deep'}`;
    if (contextTokens) contextTokens.textContent = sample.contextTokens;
    if (contextCwd) contextCwd.textContent = sample.cwd;
    syncSessionQueueVisibility(sampleName);
    syncComposerAttachments(sampleName);
    if (composerInput) composerInput.placeholder = sample.idle ? 'Send a message…' : 'Queue a message…';
    if (terminalAction) delete terminalAction.dataset.toast;
    syncTerminalAction(sampleName);
    if (slashMenu) slashMenu.hidden = true;
    document.title = `${sessionTitle?.textContent || sample.title} · ArchCode`;
    document.body.classList.remove('nav-open');
    window.syncPrototypeNavState?.();
    const requestedFocus = new URLSearchParams(location.search).get('focus');
    selectAgentSession(requestedFocus, false);
    if (updateHistory) {
      const url = new URL(location.href);
      url.searchParams.set('view', 'detail');
      url.searchParams.set('sample', sampleName);
      history.replaceState(null, '', `${url.pathname.split('/').pop()}${url.search}`);
    }
  }

  window.setPrototypeSessionSample = (name) => setSessionSample(name, false);

  document.querySelectorAll('[data-todo-plan-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const todoKey = document.body.dataset.todoKey;
      const reusable = todoKey === 'profile' && sessionSamples['plan-review']?.idle;
      if (reusable) {
        const planSession = sessionSamples['plan-review'];
        Object.assign(planSession, {
          status: 'Running', tone: 'live', composer: 'Running', composerTone: 'running',
          agentStatus: 'Running', agentTone: 'live', execution: 'Running', idle: false,
          rootObjective: 'Improving the bound Todo Plan',
        });
        appendRootTurnWithWorkSegment('plan-review', 'Use plan-work to improve the current Plan for this Todo.');
        window.openPrototypeSessionSample?.('plan-review');
        return;
      }
      window.openPrototypeSessionSample?.('discussion-new');
    });
  });

  document.querySelectorAll('[data-create-todo-session]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.createTodoSession;
      const todoKey = document.body.dataset.todoKey;
      if (sessionSamples[target]?.dynamicTodo && todoKey && todoKey !== 'profile' && todoKey !== 'dynamic') {
        const url = new URL(location.href);
        url.searchParams.set('todo', todoKey);
        history.replaceState(history.state, '', `${url.pathname.split('/').pop()}${url.search}`);
      }
      window.openPrototypeSessionSample?.(target);
    });
  });

  sessionSampleLinks.forEach((link) => link.addEventListener('click', (event) => {
    if (link.closest('.todo-nav')) return;
    event.preventDefault();
    if (window.openPrototypeSessionSample) window.openPrototypeSessionSample(link.dataset.sessionSample);
    else setSessionSample(link.dataset.sessionSample, true);
  }));
  if (sessionSampleLinks.length) {
    setSessionSample(new URLSearchParams(location.search).get('sample') || 'running');
    window.addEventListener('DOMContentLoaded', () => setSessionSample(new URLSearchParams(location.search).get('sample') || 'running'));
  }

  document.querySelectorAll('[data-agent-session-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.agentSessionTarget;
      if (document.body.dataset.sessionSample !== 'running') return;
      selectAgentSession(target, true);
    });
  });

  const permissionRequests = [
    { id: 'permission-recovery-check', title: 'Run focused recovery verification', summary: 'The Agent wants to run one scoped check before moving the stale worktree to Trash.', command: 'bun run test recovery-policy.test.ts', cwd: '/workspace/archcode', persistentApprovalEligible: true },
    { id: 'permission-trash-worktree', title: 'Move the stale worktree to Trash', summary: 'The verified managed worktree can now be moved to Trash without touching the project root or active Sessions.', command: 'trash /workspace/.worktrees/recovery-policy-old', cwd: '/workspace/archcode', persistentApprovalEligible: false },
  ];
  let permissionRequestIndex = 0;
  const hitlCardExpandedById = new Map();
  const permissionCard = document.querySelector('[data-hitl-card="permission"]');
  const hitlRequestIndex = document.querySelector('[data-hitl-request-index]');
  const hitlPrevious = document.querySelector('[data-hitl-request-previous]');
  const hitlNext = document.querySelector('[data-hitl-request-next]');
  const permissionTitle = document.querySelector('[data-permission-title]');
  const permissionSummaryTitle = document.querySelector('[data-permission-summary-title]');
  const permissionSummary = document.querySelector('[data-permission-summary]');
  const permissionCommand = document.querySelector('[data-permission-command]');
  const permissionCwd = document.querySelector('[data-permission-cwd]');
  const persistentAllow = document.querySelector('[data-hitl-persistent-allow]');
  const hitlSummaryIndex = document.querySelector('[data-hitl-summary-index]');
  function renderPermissionRequest() {
    const request = permissionRequests[permissionRequestIndex];
    if (permissionTitle) permissionTitle.textContent = request.title;
    if (permissionSummaryTitle) permissionSummaryTitle.textContent = request.title;
    if (permissionSummary) permissionSummary.textContent = request.summary;
    if (permissionCommand) permissionCommand.textContent = request.command;
    if (permissionCwd) permissionCwd.textContent = request.cwd;
    if (persistentAllow) persistentAllow.hidden = !request.persistentApprovalEligible;
    if (hitlRequestIndex) hitlRequestIndex.textContent = `${permissionRequestIndex + 1}/${permissionRequests.length}`;
    if (hitlSummaryIndex) hitlSummaryIndex.textContent = `${permissionRequestIndex + 1}/${permissionRequests.length}`;
    if (hitlPrevious) hitlPrevious.disabled = permissionRequestIndex === 0;
    if (hitlNext) hitlNext.disabled = permissionRequestIndex === permissionRequests.length - 1;
    if (permissionCard) setHitlCardExpanded(permissionCard, hitlCardExpandedById.get(request.id) ?? true);
  }
  hitlPrevious?.addEventListener('click', () => { permissionRequestIndex = Math.max(0, permissionRequestIndex - 1); renderPermissionRequest(); });
  hitlNext?.addEventListener('click', () => { permissionRequestIndex = Math.min(permissionRequests.length - 1, permissionRequestIndex + 1); renderPermissionRequest(); });
  renderPermissionRequest();

  function hitlCardStateKey(card) {
    return card.dataset.hitlCard === 'permission'
      ? permissionRequests[permissionRequestIndex]?.id
      : 'question-primary';
  }
  function setHitlCardExpanded(card, open) {
    const button = card.querySelector('[data-hitl-card-toggle]');
    if (!button) return;
    button.setAttribute('aria-expanded', String(open));
    card.querySelectorAll('[data-hitl-expanded-section]').forEach((section) => {
      section.hidden = !open;
    });
  }
  document.querySelectorAll('[data-hitl-card-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const card = button.closest('[data-hitl-card]');
      if (!card) return;
      const open = button.getAttribute('aria-expanded') !== 'true';
      const stateKey = hitlCardStateKey(card);
      if (stateKey) hitlCardExpandedById.set(stateKey, open);
      setHitlCardExpanded(card, open);
    });
  });

  const hitlDetailsToggle = document.querySelector('[data-hitl-details-toggle]');
  const hitlDetails = document.querySelector('[data-hitl-details]');
  hitlDetailsToggle?.addEventListener('click', () => {
    const open = hitlDetails?.hidden ?? true;
    if (hitlDetails) hitlDetails.hidden = !open;
    hitlDetailsToggle.setAttribute('aria-expanded', String(open));
    hitlDetailsToggle.querySelector('span:last-child').textContent = open ? 'Hide details' : 'Details';
  });

  document.querySelectorAll('[data-hitl-note-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const note = document.querySelector(`[data-hitl-note="${button.dataset.hitlNoteToggle}"]`);
      if (!note) return;
      note.hidden = !note.hidden;
      button.textContent = note.hidden ? 'Add note' : 'Hide note';
      if (!note.hidden) note.focus();
    });
  });

  const questionCard = document.querySelector('[data-hitl-card="question"]');
  const questionOptions = [...document.querySelectorAll('[data-question-option]')];
  const questionCustom = document.querySelector('[data-question-custom]');
  const questionSubmit = document.querySelector('[data-question-submit]');
  function syncQuestionSubmit() {
    if (questionSubmit) questionSubmit.disabled = !questionOptions.some((option) => option.classList.contains('selected')) && !questionCustom?.value.trim();
  }
  questionOptions.forEach((option) => option.addEventListener('click', () => {
    questionOptions.forEach((item) => item.classList.toggle('selected', item === option));
    questionOptions.forEach((item) => { const input = item.querySelector('input'); if (input) input.checked = item === option; });
    if (questionCustom) questionCustom.value = '';
    syncQuestionSubmit();
  }));
  questionCustom?.addEventListener('input', () => {
    if (questionCustom.value.trim()) questionOptions.forEach((option) => {
      option.classList.remove('selected');
      const input = option.querySelector('input');
      if (input) input.checked = false;
    });
    syncQuestionSubmit();
  });
  function resumeHitlSession(action) {
    const sampleName = document.body.dataset.sessionSample;
    const sample = sessionSamples[sampleName];
    if (!sample || !['permission', 'question'].includes(sampleName)) return;
    if (sampleName === 'question') hitlCardExpandedById.delete('question-primary');
    resolvedHitlSamples.add(sampleName);
    Object.assign(sample, {
      status: 'Running', tone: 'live', composer: 'Running', composerTone: 'running',
      agentStatus: 'Running', agentTone: 'live', execution: 'Running', idle: false,
    });
    syncWorkExecutionState(sampleName, 'running');
    setSessionSample(sampleName);
    showToast(`${action} — the same Execution resumed.`);
  }
  function resolveCurrentHitl(action) {
    const sampleName = document.body.dataset.sessionSample;
    if (sampleName === 'permission' && permissionRequests.length > 1) {
      const [resolvedRequest] = permissionRequests.splice(permissionRequestIndex, 1);
      if (resolvedRequest) hitlCardExpandedById.delete(resolvedRequest.id);
      permissionRequestIndex = Math.min(permissionRequestIndex, permissionRequests.length - 1);
      renderPermissionRequest();
      showToast(`${action}. ${permissionRequests.length} permission request remains.`);
      return;
    }
    resumeHitlSession(action);
  }
  questionSubmit?.addEventListener('click', () => {
    const selectedOption = questionOptions.find((option) => option.classList.contains('selected'));
    const answer = questionCustom?.value.trim()
      || selectedOption?.querySelector('strong')?.textContent.trim()
      || selectedOption?.textContent.trim()
      || '';
    const question = questionCard?.querySelector('legend')?.textContent.trim() || '';
    window.projectSettledAskUserRecord?.({ kind: 'single', answer, questions: [{ question, answer }] });
    resolveCurrentHitl('Answer submitted');
  });
  document.querySelectorAll('[data-hitl-resolve]').forEach((button) => button.addEventListener('click', () => resolveCurrentHitl(`${button.textContent.trim()} applied`)));
  document.querySelectorAll('[data-hitl-cancel]').forEach((button) => button.addEventListener('click', () => {
    if (document.body.dataset.sessionSample === 'question') {
      const question = questionCard?.querySelector('legend')?.textContent.trim() || '';
      window.projectSettledAskUserRecord?.({ kind: 'cancelled', questions: [{ question, answer: '' }] });
    }
    resolveCurrentHitl('Request cancelled');
  }));

  const queueEditDialog = document.querySelector('[data-queue-edit-dialog]');
  const queueEditInput = document.querySelector('[data-queue-edit-input]');
  let editingQueueRow;
  function bindQueueRow(row) {
    row.querySelector('[data-queue-delete]')?.addEventListener('click', () => { row.remove(); syncSessionQueueVisibility(); showToast('Queued message deleted.'); });
    row.querySelector('[data-queue-edit]')?.addEventListener('click', () => {
      editingQueueRow = row;
      if (queueEditInput) queueEditInput.value = row.querySelector('.queue-copy')?.textContent.trim() || '';
      queueEditDialog?.showModal();
      requestAnimationFrame(() => queueEditInput?.focus());
    });
    row.querySelector('[data-queue-steer]')?.addEventListener('click', () => {
      const content = row.querySelector('.queue-copy')?.textContent.trim();
      const sampleName = document.body.dataset.sessionSample || 'running';
      appendRootTurnWithWorkSegment(sampleName, content);
      row.remove();
      syncSessionQueueVisibility();
      showToast("Message added to the root Session's current Execution.");
    });
  }
  const fixtureQueueRow = sessionQueue?.querySelector('[data-queue-row="primary"]');
  if (fixtureQueueRow) fixtureQueueRow.dataset.queueOwner = 'running';
  document.querySelectorAll('[data-queue-row]').forEach(bindQueueRow);
  ['permission', 'question'].forEach((sampleName) => {
    if (sessionSamples[sampleName]?.queue) createQueuedMessage(sessionSamples[sampleName].queue, sampleName, true);
  });
  syncSessionQueueVisibility();

  document.querySelector('[data-queue-edit-cancel]')?.addEventListener('click', () => queueEditDialog?.close());
  document.querySelector('[data-queue-edit-save]')?.addEventListener('click', () => {
    const next = queueEditInput?.value.trim();
    if (!editingQueueRow || !next) return queueEditInput?.focus();
    const copy = editingQueueRow.querySelector('.queue-copy');
    if (copy) copy.textContent = next;
    queueEditDialog?.close();
    editingQueueRow = undefined;
    showToast('Queued message updated without changing its requested model.');
  });
  queueEditDialog?.addEventListener('click', (event) => { if (event.target === queueEditDialog) queueEditDialog.close(); });

  function consumeComposerAttachments() {
    if (!composerAttachments) return;
    const sampleName = document.body.dataset.sessionSample;
    composerAttachments.querySelectorAll('.composer-attachment').forEach((item) => {
      if (item.dataset.attachmentOwner === sampleName) item.remove();
    });
    syncComposerAttachments(sampleName);
  }

  function createQueuedMessage(content, owner = document.body.dataset.sessionSample || 'running', quiet = false) {
    if (!sessionQueue) return;
    const row = document.createElement('div');
    row.className = 'queue-row';
    row.dataset.queueRow = `draft-${Date.now()}`;
    row.dataset.queueState = 'queued';
    row.dataset.queueOwner = owner;
    row.innerHTML = '<span class="queue-status" data-icon="clock" role="img" aria-label="Queued" title="Queued"></span><p class="queue-copy"></p><div class="queue-actions"><button type="button" aria-label="Steer" title="Steer into root Session turn" data-queue-steer data-icon="corner-down-right"></button><button type="button" aria-label="Edit" title="Edit" data-queue-edit data-icon="edit"></button><button type="button" aria-label="Delete" title="Delete" data-queue-delete data-icon="trash"></button></div>';
    row.querySelector('.queue-copy').textContent = content;
    sessionQueue.appendChild(row);
    renderIcons(row);
    bindQueueRow(row);
    syncSessionQueueVisibility();
    if (!quiet) sessionQueue.hidden = false;
  }

  function appendRootUserMessage(sampleName, content) {
    const rootThread = document.querySelector(`[data-session-thread="${sampleName}"]`);
    if (!rootThread || !content) return;
    rootThread.querySelector('.session-empty')?.remove();
    const message = document.createElement('article');
    message.className = 'message';
    message.innerHTML = '<div class="user-message"><p class="user-bubble"></p><time class="message-time">Now</time></div>';
    message.querySelector('.user-bubble').textContent = content;
    rootThread.appendChild(message);
  }

  function appendRootTurnWithWorkSegment(sampleName, content) {
    const rootThread = document.querySelector(`[data-session-thread="${sampleName}"]`);
    if (!rootThread || !content) return;
    rootThread.querySelectorAll('.work-segment.running,.work-segment.live').forEach((segment) => {
      segment.className = 'work-segment complete';
      const control = segment.querySelector('[data-work-disclosure]');
      const bodyId = control?.getAttribute('aria-controls');
      const body = bodyId ? document.getElementById(bodyId) : null;
      if (control) {
        control.setAttribute('aria-expanded', 'false');
        control.querySelector('.work-live-dot')?.remove();
        control.querySelector('.work-current-activity')?.remove();
        const summary = control.querySelector('strong');
        if (summary) summary.innerHTML = summary.innerHTML.replace('Working for', 'Worked for');
      }
      if (body) body.hidden = true;
    });
    appendRootUserMessage(sampleName, content);
    const segmentId = `work-body-${sampleName}-${crypto.randomUUID()}`;
    const waiting = ['permission', 'question'].includes(sampleName) && !resolvedHitlSamples.has(sampleName);
    const segment = document.createElement('section');
    segment.className = `work-segment ${waiting ? 'paused' : 'running'}`;
    segment.dataset.workSegment = `turn-${segmentId}`;
    segment.dataset.settledToolCount = '0';
    segment.innerHTML = `<button class="work-summary-control" type="button" aria-expanded="true" aria-controls="${segmentId}" data-work-disclosure><span data-icon="down"></span>${waiting ? '' : '<span class="work-live-dot" aria-hidden="true"></span>'}<strong>${waiting ? 'Paused · Worked for <span class="tabular">just now</span>' : 'Working for <span class="tabular">just now</span>'}</strong><span class="work-current-activity">— ${waiting ? 'Waiting for your response' : 'New Session input'}</span><span class="work-summary-divider"></span></button><div class="work-segment-body" id="${segmentId}"><p class="work-commentary"></p></div>`;
    segment.querySelector('.work-commentary').textContent = waiting
      ? 'This input is bound to the root Session and will continue after the pending request resolves.'
      : 'The root Session accepted this input and opened a new current Work segment.';
    rootThread.appendChild(segment);
    renderIcons(segment);
    bindWorkDisclosure(segment.querySelector('[data-work-disclosure]'));
  }

  function syncWorkExecutionState(sampleName, state) {
    const thread = document.querySelector(`[data-session-thread="${sampleName}"]`);
    const segments = [...(thread?.querySelectorAll('.work-segment.running,.work-segment.paused,.work-segment.live') || [])];
    const segment = segments.at(-1);
    if (!segment) return;
    const control = segment.querySelector('[data-work-disclosure]');
    const body = control?.getAttribute('aria-controls') ? document.getElementById(control.getAttribute('aria-controls')) : null;
    if (state === 'running') {
      segment.className = 'work-segment running';
      if (control) {
        control.setAttribute('aria-expanded', 'true');
        control.innerHTML = '<span data-icon="down"></span><span class="work-live-dot" aria-hidden="true"></span><strong>Working for <span class="tabular">just resumed</span></strong><span class="work-current-activity">— Continue the same Execution</span><span class="work-summary-divider"></span>';
      }
      if (body) body.hidden = false;
    } else if (state === 'stopped') {
      segment.className = 'work-segment complete';
      if (control) {
        control.setAttribute('aria-expanded', 'false');
        control.innerHTML = '<span data-icon="down"></span><strong>Stopped · Worked until now</strong><span class="work-summary-divider"></span>';
      }
      if (body) body.hidden = true;
    }
    if (control) renderIcons(control);
  }

  terminalAction?.addEventListener('click', () => {
    const mode = terminalAction.dataset.actionMode;
    const sampleName = document.body.dataset.sessionSample || 'running';
    const sample = sessionSamples[sampleName];
    if (mode === 'stop') {
      if (sample) Object.assign(sample, {
        status: 'Stopped', tone: 'neutral', composer: 'Ready', composerTone: 'idle',
        agentStatus: 'Stopped', agentTone: 'neutral', execution: 'Stopped', idle: true,
      });
      syncWorkExecutionState(sampleName, 'stopped');
      setSessionSample(sampleName);
      showToast('Session stopped.');
      return;
    }
    const content = composerInput?.value.trim();
    const attachmentCount = composerAttachments?.querySelectorAll('.composer-attachment:not([hidden])').length || 0;
    if (!content && !composerHasSendableDraft()) return composerInput?.focus();
    const message = content || `${attachmentCount} attached file${attachmentCount === 1 ? '' : 's'}`;
    if (mode === 'queue') createQueuedMessage(message, sampleName);
    else {
      appendRootTurnWithWorkSegment(sampleName, message);
      if (sample) Object.assign(sample, {
        status: 'Running', tone: 'live', composer: 'Running', composerTone: 'running',
        agentStatus: 'Running', agentTone: 'live', execution: 'Running', idle: false,
      });
    }
    composerInput.value = '';
    composerDrafts.set(sampleName, '');
    consumeComposerAttachments();
    if (slashMenu) slashMenu.hidden = true;
    showToast(mode === 'queue' ? 'Message queued for the root Session.' : 'Message sent.');
    if (mode === 'send') setSessionSample(sampleName);
    else syncTerminalAction();
  });
  document.querySelectorAll('[data-slash-command]').forEach((button) => {
    button.addEventListener('click', () => {
      if (composerInput) composerInput.value = `${button.dataset.slashCommand}${button.dataset.slashCommand === '/skill use' ? ' ' : ''}`;
      if (slashMenu) slashMenu.hidden = true;
      composerInput?.focus();
    });
  });
  composerInput?.addEventListener('input', () => {
    syncTerminalAction();
    if (!slashMenu) return;
    const ready = Boolean(sessionSamples[document.body.dataset.sessionSample]?.idle);
    slashMenu.hidden = !(ready && composerInput.value.trimStart().startsWith('/'));
  });
  composerInput?.addEventListener('keydown', (event) => {
    const plainEnter = event.key === 'Enter'
      && !event.shiftKey
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey;
    if (!plainEnter || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!composerHasSendableDraft()) return;
    terminalAction?.click();
  });
  const newTodoOutcome = {
    save: 'Todo saved to Ideas.',
    discussion: 'Todo saved to Ideas and Discussion started.',
    run: 'Todo moved to In Progress and Lead Session started.',
  };
  document.querySelectorAll('[data-new-todo-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (newTodoPending) return;
      if (!newTodoInput?.value.trim()) {
        if (newTodoError) newTodoError.hidden = false;
        newTodoInput?.focus();
        return;
      }
      const outcome = button.dataset.newTodoAction;
      const content = newTodoInput.value.trim();
      const lane = outcome === 'run' ? 'in_progress' : 'idea';
      const pendingCopy = outcome === 'discussion'
        ? 'Saving Todo and starting Discussion…'
        : outcome === 'run'
          ? 'Saving Todo and starting Lead Session…'
          : 'Saving Todo…';
      setNewTodoPending(true, pendingCopy);
      await new Promise((resolve) => window.setTimeout(resolve, 650));
      const todo = savePrototypeTodo(content, lane);
      setNewTodoPending(false);
      newTodoDialog?.close();
      if (outcome === 'discussion' || outcome === 'run') {
        const sample = outcome === 'discussion' ? 'discussion-new' : 'work-new';
        location.href = `./session.html?view=detail&sample=${sample}&todo=${encodeURIComponent(todo.id)}&lane=${lane}`;
        return;
      }
      window.addPrototypeIdeaTodo?.(todo.content, todo.id);
      showToast(newTodoOutcome[outcome] || 'Todo saved.');
      newTodoInput.value = '';
    });
  });

  document.querySelectorAll('textarea[data-auto-grow]').forEach((textarea) => {
    const resize = () => { textarea.style.height = '0'; textarea.style.height = `${Math.min(180, textarea.scrollHeight)}px`; };
    textarea.addEventListener('input', resize);
  });
})();

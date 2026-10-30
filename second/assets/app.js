/* Controls, profile state and documentation navigation. */
(function (root) {
  'use strict';
  const G = root.Graph;
  const labels = { collapse: 'Collapse', expandLevel: 'Expand one level', expandBranch: 'Expand branch',
    exploreInputs: 'Explore inputs', exploreOutputs: 'Explore outputs' };
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function button(text, callback, className) {
    const node = element('button', text, className); node.type = 'button'; node.addEventListener('click', callback); return node;
  }
  function shell(host, project, callbacks) {
    host.classList.add('calculation-tree');
    const toolbar = element('div', undefined, 'tree-toolbar');
    const profile = element('select'); profile.setAttribute('aria-label', 'Calculation profile');
    for (const id of project.profiles) { const option = element('option', project.info[id]?.title ?? (id === 'all' ? 'All' : id)); option.value = id; profile.append(option); }
    profile.addEventListener('change', () => callbacks.profile(profile.value));
    const search = element('input'); search.type = 'search'; search.placeholder = 'Search nodes…'; search.setAttribute('aria-label', 'Search nodes');
    search.addEventListener('input', () => callbacks.search(search.value));
    const more = element('details', undefined, 'tree-more');
    const moreTitle = element('summary', 'More'); more.append(moreTitle);
    const menu = element('div', undefined, 'tree-menu');
    const expand = button('Show full calculation', callbacks.expandAll), reset = button('Reset positions', callbacks.reset);
    menu.append(expand, reset); more.append(menu);
    toolbar.append(profile, search, button('Fit graph', callbacks.fit), more);
    const context = element('div', undefined, 'tree-context'); context.hidden = true;
    const contextLabel = element('span'); context.append(contextLabel, button('Show full calculation', callbacks.expandAll));
    const workspace = element('div', undefined, 'tree-workspace'), stage = element('div', undefined, 'tree-stage');
    const canvas = element('div', undefined, 'tree-canvas'); canvas.setAttribute('aria-label', 'Calculation graph');
    const legend = element('div', undefined, 'tree-legend');
    for (const [kind, text] of [['source', 'Source'], ['model', 'Model'], ['data', 'Data'], ['collapsed', 'Collapsed']]) legend.append(element('span', text, 'tree-key ' + kind));
    stage.append(canvas, legend);
    const sidebar = element('aside', undefined, 'tree-sidebar'); sidebar.setAttribute('aria-label', 'Node details');
    workspace.append(stage, sidebar);
    const footer = element('div', undefined, 'tree-footer'); footer.setAttribute('role', 'status');
    const notice = element('div', undefined, 'tree-notice'); notice.setAttribute('role', 'alert'); notice.hidden = true;
    const noticeText = element('span');
    notice.append(noticeText, button('Dismiss', callbacks.dismiss));
    host.replaceChildren(toolbar, notice, context, workspace, footer);
    return { profile, search, more, expand, canvas, sidebar, footer, notice, noticeText, context, contextLabel };
  }
  function showSidebar(ui, context, callbacks) {
    const { graph, view, state, selected, query } = context, box = ui.sidebar; box.replaceChildren();
    const heading = text => box.append(element('h3', text));
    const paragraph = text => box.append(element('p', text));
    function row(id, destination = box) {
      const node = graph.byId.get(id);
      destination.append(button(`${node.label ?? id}${view.hidden.has(id) ? ' · hidden' : ''}`, () => callbacks.pick(id), 'tree-row'));
    }
    function list(title, ids) {
      heading(title); const unique = [...new Set(ids)];
      if (!unique.length) paragraph('None'); else unique.forEach(id => row(id));
    }
    if (query.trim()) {
      const needle = query.trim().toLowerCase();
      const matches = graph.nodes.filter(n => [n.label, n.id, n.description].some(value => String(value ?? '').toLowerCase().includes(needle)));
      heading(`${matches.length} matches`); matches.slice(0, 100).forEach(n => row(n.id));
      if (matches.length > 100) paragraph('Showing the first 100. Refine your search to see fewer results.');
    } else if (selected !== null && graph.byId.has(selected)) {
      const node = graph.byId.get(selected);
      box.append(element('div', `${graph.sources.has(selected) ? 'SOURCE DATA' : node.group}${view.active.has(selected) ? ' · COLLAPSED' : view.hidden.has(selected) ? ' · HIDDEN' : ''}`, 'tree-eyebrow'));
      heading(node.label ?? node.id); paragraph(node.description ?? `ID: ${node.id}`);
      box.append(button('Open node page ↗', () => callbacks.open(selected), 'tree-open'));
      const actions = node.group === 'MODEL' ? ['collapse', 'expandLevel', 'expandBranch', 'exploreInputs', 'exploreOutputs'] : ['exploreInputs', 'exploreOutputs'];
      const group = element('div', undefined, 'tree-actions');
      for (const action of actions) {
        const control = button(labels[action], () => callbacks.perform(action, selected));
        control.disabled = !G.available(graph, state, view, action, selected); group.append(control);
      }
      box.append(group);
      list('Inputs', graph.incoming.get(selected)); list('Outputs', graph.outgoing.get(selected));
      if (node.metadata !== undefined) { heading('Metadata'); box.append(element('pre', JSON.stringify(node.metadata, null, 2))); }
    } else {
      box.append(element('div', 'CALCULATION EXPLORER', 'tree-eyebrow'));
      heading('Follow the calculation');
      paragraph('Sources start in the first column. Select a node to inspect it, collapse a model, or explore its inputs and outputs. Drag nodes vertically to arrange each column.');
      list('Final outputs', graph.roots);
    }
    if (state.closed.size) {
      heading('Collapsed models');
      for (const id of state.closed) {
        const entry = element('div', undefined, 'tree-region'); row(id, entry);
        if (view.hidden.has(id)) entry.append(element('small', 'Outside the current view'));
        entry.append(button('Expand', () => callbacks.perform('expandBranch', id))); box.append(entry);
      }
    }
  }
  const mounted = new WeakMap();
  let viewerCount = 0;
  function mount(options) {
    G.assert(root.GraphLayout && root.GraphViewer && root.vis, 'Graph modules and vis-network are required.');
    const host = typeof options.container === 'string' ? document.querySelector(options.container) : options.container;
    G.assert(host?.nodeType === 1, 'A valid container is required.');
    const automaticLayout = options.automaticLayout ?? root.GraphLayout.useAutomatic;
    const project = G.project({ ...options, automaticLayout });
    const storage = { getItem: key => root.sessionStorage.getItem(key), setItem: (key, value) => root.sessionStorage.setItem(key, value), removeItem: key => root.sessionStorage.removeItem(key) };
    const ticket = G.session(project, root.location.href, storage);
    let restored = null, initialNotice = '';
    try { restored = options.initialState !== undefined ? G.snapshot(project, options.initialState) : ticket.read(); }
    catch (error) { initialNotice = 'Starting a fresh view. ' + error.message; }
    mounted.get(host)?.destroy();
    let disposed = false, profile = restored?.profile ?? 'all', graph = project.graph(profile);
    const states = restored?.states ?? new Map([['all', G.freshState()]]);
    let state = states.get(profile), selected = restored?.selected ?? null, view, query = '', searchTimer;
    const alive = () => G.assert(!disposed, 'Viewer has been destroyed.');
    const notice = message => { ui.noticeText.textContent = message; ui.notice.hidden = !message; };
    const safe = callback => (...args) => { if (disposed) return; try { notice(''); return callback(...args); } catch (error) { notice(error.message); } };
    const callbacks = {
      dismiss: safe(() => notice('')),
      profile: safe(switchProfile), search: safe(value => {
        clearTimeout(searchTimer); searchTimer = setTimeout(safe(() => { query = value; sidebar(); }), 120);
      }), expandAll: safe(showFull), reset: safe(resetPositions), fit: safe(() => renderer.fit()),
      pick: safe(id => select(id, true)), open: safe(openNode), perform: safe(perform)
    };
    const ui = shell(host, project, callbacks);
    let renderer;
    try { renderer = root.GraphViewer.create(ui.canvas, project.graph('all'), restored?.positions, automaticLayout); }
    catch (error) { host.replaceChildren(); host.classList.remove('calculation-tree'); throw error; }
    const network = renderer.network;
    viewerCount++; document.body.classList.add('calculation-tree-page');
    function clearSearch() { clearTimeout(searchTimer); query = ''; ui.search.value = ''; }
    function sidebar() { showSidebar(ui, { graph, view, state, selected, query }, callbacks); }
    function render() {
      view = G.derive(graph, state); renderer.render(graph, view); renderer.select(selected);
      ui.profile.value = profile; ui.expand.disabled = !state.closed.size && !state.exploration;
      ui.context.hidden = !state.exploration;
      if (state.exploration) {
        const { startNode, direction } = state.exploration;
        ui.contextLabel.textContent = `${direction === 'incoming' ? 'Inputs to' : 'Outputs from'} ${graph.byId.get(startNode).label ?? startNode}`;
      }
      ui.footer.textContent = `${view.nodes.length} / ${graph.nodes.length} nodes · ${view.edges.length} edges · ${view.active.size} collapsed · Drag vertically to arrange`;
      sidebar();
    }
    function select(id, focus = false) {
      alive(); G.assert(id === null || graph.byId.has(id), 'Unknown node.');
      selected = id; clearSearch(); renderer.select(id); sidebar();
      if (focus && id !== null) renderer.focus(id);
    }
    function perform(action, id) {
      alive(); state = G.transition(graph, state, action, id); states.set(profile, state);
      selected = id; clearSearch(); render();
      if (action.startsWith('explore')) renderer.fit();
    }
    function showFull() {
      alive(); const wasExploring = !!state.exploration;
      state = G.freshState(); states.set(profile, state); ui.more.open = false; clearSearch(); render();
      if (wasExploring) renderer.fit();
    }
    function switchProfile(id) {
      alive(); if (id === profile) return;
      const nextGraph = project.graph(id), before = renderer.camera();
      graph = nextGraph; profile = id; state = states.get(id) ?? G.freshState(); states.set(id, state);
      if (!graph.byId.has(selected)) selected = null;
      clearSearch(); render(); renderer.moveCamera(before);
    }
    function resetPositions() { alive(); renderer.reset(); ui.more.open = false; }
    function exportState() {
      alive();
      return structuredClone({ automaticLayout, profile, states: Object.fromEntries([...states].map(([id, partial]) => [id, { partial: G.serialize(partial) }])), selected,
        camera: renderer.camera(), sharedLayout: renderer.layout() });
    }
    function openNode(id) {
      alive(); G.assert(graph.byId.has(id), 'Unknown node.');
      G.assert(graph.byId.get(id).url, 'No documentation page is linked to this node.');
      const url = G.nodeURL(graph.byId.get(id), options.siteRoot ?? '../', ticket.normalized);
      select(id);
      try { ticket.save(exportState()); } catch (error) { throw new Error('Unable to save this view. Navigation stopped. ' + error.message); }
      root.location.assign(url);
    }
    function destroy() {
      if (disposed) return;
      disposed = true; clearTimeout(searchTimer); renderer.destroy();
      host.replaceChildren(); host.classList.remove('calculation-tree'); mounted.delete(host);
      if (--viewerCount === 0) document.body.classList.remove('calculation-tree-page');
    }
    network.on('click', safe(event => select(event.nodes[0] ?? null)));
    render();
    if (restored) renderer.moveCamera(restored.camera); else network.fit({ animation: false });
    if (initialNotice) notice(initialNotice);
    if (ticket.source !== null) {
      const representative = G.returnRepresentative(graph, view, ticket.source);
      if (representative !== null) {
        select(representative);
        renderer.center(representative, Number.isFinite(options.returnZoomFactor) && options.returnZoomFactor > 0 ? options.returnZoomFactor : 1.15);
      } else notice([initialNotice, 'The returning node is outside this view. Use Show full calculation to find it.'].filter(Boolean).join(' '));
      ticket.consume(root.history);
    }
    const api = { getProfile: () => profile, getView: () => structuredClone(view), exportState, switchProfile, resetPositions, openNode, perform,
      collapse: id => perform('collapse', id), expandOneLevel: id => perform('expandLevel', id), expand: id => perform('expandBranch', id),
      exploreInputs: id => perform('exploreInputs', id), exploreOutputs: id => perform('exploreOutputs', id),
      showFull, expandAll: showFull, destroy, network };
    mounted.set(host, api); return api;
  }
  root.CalculationTree = { mount };
})(globalThis);

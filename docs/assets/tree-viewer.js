(function (global) {
  'use strict';

  const mountedHosts = new WeakMap();
  let activeViewers = 0;
  const canonicalId = node => node.collapsed ? node.collapsedFrom : node.id;

  /** Browser entry point. Python's dictionaries remain the public input contract. */
  function mount(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error('CalculationTree.mount requires an options object.');
    for (const name of ['TreeCore', 'TreeRuntime', 'TreeView']) {
      if (!global[name]) throw Error(`${name} did not load. Check the script order in tree.md.`);
    }
    if (!global.vis?.Network || !global.vis?.DataSet) throw Error('vis-network did not load. Check the connection or load a local copy.');
    const host = typeof options.container === 'string' ? document.querySelector(options.container) : options.container;
    if (!host) throw Error('Graph container not found.');
    const project = global.TreeRuntime.createProject(options);
    const session = global.TreeRuntime.createSession(project, options);
    const restored = options.initialState === undefined ? session.read() : restoreExplicitState(options.initialState, project);
    const snapshot = restored.state;
    // Validate graph construction before replacing a previously mounted viewer.
    const allGraph = project.getGraph('all');
    const graph = project.getGraph(snapshot?.profile ?? 'all');
    mountedHosts.get(host)?.destroy();
    const viewer = createViewer({host, project, session, snapshot, graph, allGraph, options, notice: restored.notice});
    mountedHosts.set(host, viewer);
    return viewer;
  }

  function restoreExplicitState(state, project) {
    try {
      return {state: structuredClone(global.TreeRuntime.validateSnapshot(state, project)), notice: null};
    } catch {
      return {state: undefined, notice: 'The saved tree state was invalid; a fresh view was opened.'};
    }
  }

  function createViewer({host, project, session, snapshot, graph, allGraph, options, notice}) {
    const element = global.TreeView.element;
    const controls = global.TreeView.createShell(host, options.title ?? 'Calculation tree');
    const {search, fit, restore, reset, profileSelect, more, canvasWrap, canvas, aside, count} = controls;
    const nodeSet = new global.vis.DataSet();
    const edgeSet = new global.vis.DataSet();
    const network = new global.vis.Network(canvas, {nodes: nodeSet, edges: edgeSet}, networkOptions(project.flowOptions));
    const profileStates = new Map(Object.entries(snapshot?.states ?? {}));
    const pendingChecks = new Set();
    let currentProfile = snapshot?.profile ?? 'all';
    const saved = snapshot?.states?.[currentProfile];
    let graphState = graph.createState(saved?.partial);
    let selected = snapshot?.selected ?? null;
    let view;
    let visibleIds = new Map();
    let nodeSignatures = new Map();
    let edgeSignatures = new Map();
    let disposed = false;
    let searchTimer;
    let sidebarVersion = 0;
    let errorNotice;
    let layout;
    let sidebar;

    function ensureActive() {
      if (disposed) throw Error('This tree viewer has been destroyed.');
    }

    function showError(error) {
      if (disposed) return;
      if (!errorNotice) {
        errorNotice = element('div', undefined, 'notice');
        errorNotice.setAttribute('role', 'alert');
        canvasWrap.append(errorNotice);
      }
      errorNotice.textContent = error.message ?? String(error);
    }

    // UI callbacks report errors without losing the active graph or navigation state.
    function safely(callback) {
      return (...args) => {
        if (disposed) return;
        try { return callback(...args); }
        catch (error) { showError(error); }
      };
    }

    function clearDisplay() {
      edgeSet.clear();
      nodeSet.clear();
      nodeSignatures.clear();
      edgeSignatures.clear();
    }

    function cancelChecks() {
      sidebarVersion++;
      for (const task of pendingChecks) {
        if (task.idle && typeof global.cancelIdleCallback === 'function') global.cancelIdleCallback(task.id);
        else if (!task.idle) global.clearTimeout(task.id);
      }
      pendingChecks.clear();
    }

    function checkAction(button, action, id) {
      const version = sidebarVersion;
      const state = graphState;
      const currentGraph = graph;
      const task = {idle: typeof global.requestIdleCallback === 'function'};
      button.disabled = true;
      button.title = 'Checking availability…';
      const check = () => {
        pendingChecks.delete(task);
        if (disposed || version !== sidebarVersion) return;
        try { button.disabled = !currentGraph.canTransition(state, action, id); }
        catch (error) { button.disabled = true; showError(error); }
        button.title = '';
      };
      task.id = task.idle ? global.requestIdleCallback(check, {timeout: 150}) : global.setTimeout(check, 0);
      pendingChecks.add(task);
    }

    function toDisplayNode(node) {
      // group is a calculation type, not a vis-network styling group.
      const {group, color: suppliedColor, ...displayNode} = node;
      const source = graph.sources.has(canonicalId(node));
      const fallback = node.collapsed ? {background: '#e6e1f4', border: '#8a76b0'}
        : group === 'MODEL' ? {background: '#e0efe9', border: '#6c9d8d'}
          : source ? {background: '#fff1d9', border: '#d3b074'} : {background: '#e7eff9', border: '#89a8ce'};
      const color = typeof suppliedColor === 'string'
        ? {background: suppliedColor, border: suppliedColor}
        : {...fallback, ...suppliedColor};
      const stateColor = {background: color.background, border: color.border};
      return {
        ...displayNode,
        ...layout.pointFor(node),
        label: String(node.label ?? node.id),
        shape: group === 'MODEL' ? 'box' : 'ellipse',
        color: {...color, highlight: {...stateColor, ...color.highlight}, hover: {...stateColor, ...color.hover}},
        title: element('div', `${node.label ?? node.id}${node.collapsed ? ` — ${node.hiddenCount} hidden dependencies` : ''}`)
      };
    }

    function synchronizeDisplay() {
      const nextNodes = new Map(view.nodes.map(node => [node.id, JSON.stringify(node)]));
      const nextEdges = new Map(view.edges.map(edge => [edge.id, JSON.stringify(edge)]));
      const removedEdges = edgeSet.getIds().filter(id => !nextEdges.has(id));
      if (removedEdges.length) edgeSet.remove(removedEdges);
      const removedNodes = nodeSet.getIds().filter(id => !nextNodes.has(id));
      if (removedNodes.length) nodeSet.remove(removedNodes);
      const changedNodes = view.nodes.filter(node => nextNodes.get(node.id) !== nodeSignatures.get(node.id)).map(toDisplayNode);
      if (changedNodes.length) nodeSet.update(changedNodes);
      const changedEdges = view.edges.filter(edge => nextEdges.get(edge.id) !== edgeSignatures.get(edge.id));
      if (changedEdges.length) edgeSet.update(changedEdges);
      nodeSignatures = nextNodes;
      edgeSignatures = nextEdges;
    }

    function renderSidebar() {
      sidebar.render({graph, graphState, view, selected, visibleIds, query: search.value.trim().toLowerCase()});
    }

    function render() {
      layout.capture();
      view = graph.derive(graphState);
      visibleIds = new Map(view.nodes.map(node => [canonicalId(node), node.id]));
      synchronizeDisplay();
      if (selected !== null && !graph.byId.has(selected)) selected = null;
      const shown = visibleIds.get(selected);
      if (shown !== undefined) network.selectNodes([shown], false);
      else network.unselectAll();
      restore.disabled = graphState.regions.size === 0;
      count.textContent = `${view.nodes.length} / ${graph.nodes.length} nodes shown · ${view.edges.length} edges · ${view.active.size} collapsed${view.dormant.size ? ` · ${view.dormant.size} nested` : ''}`;
      renderSidebar();
    }

    function renderLayout() {
      render();
      layout.restoreFlow();
      layout.styleEdges(graph);
    }

    function pick(id) {
      selected = id;
      search.value = '';
      renderSidebar();
      const shown = visibleIds.get(id);
      if (shown !== undefined) {
        network.selectNodes([shown], false);
        network.focus(shown, {scale: Math.max(.65, network.getScale()), locked: false, animation: {duration: 250}});
      }
    }

    function perform(action, id) {
      ensureActive();
      graphState = graph.transition(graphState, action, id);
      selected = id;
      render();
    }

    function saveProfile() {
      layout.capture();
      profileStates.set(currentProfile, {
        graph, graphState
      });
    }

    function switchProfile(id) {
      ensureActive();
      if (id === currentProfile) return;
      // Prepare everything that can fail before changing the current view.
      const nextGraph = project.getGraph(id);
      const target = profileStates.get(id);
      const nextState = target?.graphState ?? nextGraph.createState(target?.partial);
      const camera = captureCamera(network);
      saveProfile();
      currentProfile = id;
      graph = nextGraph;
      graphState = nextState;
      selected = graph.byId.has(selected) ? selected : null;
      profileSelect.value = id;
      search.value = '';
      clearDisplay();
      renderLayout();
      network.moveTo({...camera, animation: false});
    }

    function exportState() {
      ensureActive();
      saveProfile();
      const states = Object.create(null);
      for (const [id, state] of profileStates) {
        states[id] = {
          partial: state.graphState ? state.graph.serializeState(state.graphState) : state.partial
        };
      }
      return structuredClone({profile: currentProfile, states, selected, camera: captureCamera(network), sharedLayout: layout.exportShared()});
    }

    function openNode(id) {
      ensureActive();
      const node = graph.byId.get(id);
      if (!node) throw Error(`Unknown node: ${id}`);
      const url = session.urlFor(node);
      selected = id;
      session.save(exportState());
      global.location.assign(url.href);
    }

    function resetPositions() {
      ensureActive();
      const camera = captureCamera(network);
      layout.reset();
      layout.restoreFlow();
      network.moveTo({...camera, animation: false});
      more.open = false;
    }

    function restoreReturningNode() {
      if (session.source === null) return;
      const id = global.TreeRuntime.returningRepresentative(session.source, graph, view);
      if (id !== null) {
        selected = id;
        renderSidebar();
        const shown = visibleIds.get(id);
        const configured = options.returnZoomFactor ?? 1.15;
        const factor = Number.isFinite(configured) && configured > 0 ? configured : 1.15;
        network.selectNodes([shown], false);
        network.focus(shown, {scale: (snapshot?.camera.scale ?? network.getScale()) * factor, locked: false, animation: false});
      } else aside.append(element('p', 'The returning node is absent from this profile or has no visible representative.'));
      session.consume();
    }

    function destroy() {
      if (disposed) return;
      disposed = true;
      cancelChecks();
      global.clearTimeout(searchTimer);
      network.destroy();
      host.replaceChildren();
      host.classList.remove('dg', 'dg-mkdocs');
      mountedHosts.delete(host);
      activeViewers--;
      if (activeViewers === 0) document.body.classList.remove('dg-graph-page');
    }

    for (const definition of project.definitions.values()) {
      const option = element('option', definition.title);
      option.value = definition.id;
      profileSelect.append(option);
    }
    profileSelect.value = currentProfile;
    sidebar = global.TreeView.createSidebar({aside, pick: safely(pick), openNode: safely(openNode), perform: safely(perform), checkAction, cancelChecks});
    layout = global.TreeView.createLayout({
      network, nodeSet, edgeSet, allGraph, saved: snapshot,
      flowOptions: project.flowOptions, clearDisplay
    });
    profileSelect.onchange = safely(() => {
      try { switchProfile(profileSelect.value); }
      catch (error) { profileSelect.value = currentProfile; throw error; }
    });
    search.oninput = () => {
      global.clearTimeout(searchTimer);
      searchTimer = global.setTimeout(safely(renderSidebar), 120);
    };
    fit.onclick = safely(() => network.fit({animation: {duration: 300}}));
    restore.onclick = safely(() => { graphState = graph.createState(); render(); });
    reset.onclick = safely(resetPositions);
    network.on('click', safely(event => {
      const node = nodeSet.get(event.nodes[0]);
      selected = node ? canonicalId(node) : null;
      search.value = '';
      renderSidebar();
    }));
    network.on('dragEnd', safely(() => layout.capture()));
    activeViewers++;
    try {
      layout.initialize();
      renderLayout();
      if (snapshot?.camera) network.moveTo({...snapshot.camera, animation: false});
      else network.fit();
      restoreReturningNode();
      if (notice) showError(Error(notice));
      host.classList.add('dg-mkdocs');
      document.body.classList.add('dg-graph-page');
    } catch (error) {
      destroy();
      throw error;
    }

    return {
      network,
      exportState, resetPositions, switchProfile, openNode, perform, destroy,
      getProfile() { return currentProfile; },
      getView() { return structuredClone(view); },
      expandAllDownstream(id) { perform('downstreamAll', id); },
      collapseOneLevel(id) { perform('collapseLevel', id); },
      expandOneLevel(id) { perform('expandLevel', id); },
      expandDownstreamOneLevel(id) { perform('downstream', id); },
      collapse(id) { perform('collapseAll', id); },
      expand(id) { perform('expandAll', id); },
      expandAll() { ensureActive(); graphState = graph.createState(); render(); }
    };
  }

  function captureCamera(network) {
    return {position: {...network.getViewPosition()}, scale: network.getScale()};
  }

  function networkOptions(flowOptions) {
    return {
      layout: {randomSeed: 42, hierarchical: {enabled: false, direction: 'LR', sortMethod: 'directed', levelSeparation: 220, nodeSpacing: 100, ...flowOptions}},
      physics: {enabled: false},
      nodes: {font: {face: 'system-ui', size: 15, color: '#233343'}, scaling: {label: {drawThreshold: 7}}, borderWidth: 1.5, margin: 12},
      edges: {arrows: 'to', color: {color: '#aabac7', highlight: '#326b59'}, width: 1.2, smooth: {enabled: true, type: 'cubicBezier', forceDirection: 'horizontal', roundness: .35}, font: {size: 10, color: '#718192'}},
      interaction: {hover: true, hoverConnectedEdges: false, selectConnectedEdges: false, hideEdgesOnDrag: true, hideEdgesOnZoom: true, keyboard: {enabled: true, bindToWindow: false}, tooltipDelay: 250}
    };
  }

  global.CalculationTree = {mount};
})(typeof window !== 'undefined' ? window : globalThis);

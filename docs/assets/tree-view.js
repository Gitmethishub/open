(function (global) {
  'use strict';
  const el = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };

  // Public button wording is independent of the internal calculation direction.
  const NODE_ACTIONS = {
    MODEL: [
      ['collapseLevel', 'Collapse dependencies one level'],
      ['expandLevel', 'Expand dependencies one level'],
      ['collapseAll', 'Collapse all dependencies'],
      ['expandAll', 'Expand all dependencies'],
      ['downstreamAll', 'Expand upstream all']
    ],
    DATA: [
      ['downstream', 'Expand upstream one level'],
      ['downstreamAll', 'Expand upstream all']
    ]
  };

  // Static markup only: all project-provided labels are assigned with textContent.
  const SHELL = `
    <header><div><div class="eyebrow">DOCUMENTATION / EXPLORER</div><h1 data-ui="title"></h1></div><span class="badge">Calculation dependencies</span></header>
    <div class="toolbar" data-ui="toolbar">
      <select data-ui="profileSelect" aria-label="Graph profile"></select>
      <input data-ui="search" type="search" placeholder="Search nodes…" aria-label="Search nodes">
      <button data-ui="fit">Fit graph</button>
      <details class="toolbar-more" data-ui="more"><summary>More</summary><div class="more-panel" data-ui="morePanel">
        <button data-ui="restore">Expand all</button><button data-ui="reset">Reset positions</button>
      </div></details>
    </div>
    <div class="workspace"><div class="canvas-wrap" data-ui="canvasWrap">
      <div class="canvas" data-ui="canvas" tabindex="0" aria-label="Interactive documentation network. Use the sidebar to select nodes."></div>
      <div class="legend"><span><i class="dot"></i>Model</span><span><i class="dot data"></i>Data</span><span><i class="dot source"></i>Source input</span></div>
    </div><aside data-ui="aside" aria-label="Node details and search results"></aside></div>
    <footer><span data-ui="count" role="status"></span><span>Select a node for actions · Scroll to zoom</span></footer>`;

  function createShell(host, title) {
    host.innerHTML = SHELL;
    host.classList.add('dg');
    const names = 'search fit restore reset profileSelect more canvasWrap canvas aside count'.split(' ');
    const controls = Object.fromEntries(names.map(name => [name, host.querySelector(`[data-ui="${name}"]`)]));
    host.querySelector('[data-ui="title"]').textContent = title;
    return controls;
  }

  function createSidebar({aside, pick, openNode, perform, checkAction, cancelChecks}) {
    let graph, graphState, view, selected, visibleIds, query;
    const label = id => String(graph.byId.get(id)?.label ?? id);
    function row(id, note) {
      const button = el('button', label(id));
      if (note) button.append(el('small', note));
      button.onclick = () => pick(id);
      return button;
    }
    function renderSearchResults(query) {
      aside.append(el('div', 'FIND A NODE', 'type'));
      const matches = graph.nodes.filter(n => `${n.label ?? ''} ${n.id} ${n.description ?? ''}`.toLowerCase().includes(query));
      aside.append(el('p', `${matches.length} result${matches.length === 1 ? '' : 's'}`));
      const list = el('div', undefined, 'list');
      for (const n of matches.slice(0, 100)) {
        const visible = visibleIds.has(n.id);
        const button = row(n.id, `${n.group}${visible ? '' : ' · inside a collapsed branch'}`);
        list.append(button);
      }
      aside.append(list);
      if (matches.length > 100) aside.append(el('p', 'Showing the first 100 results. Refine your search.'));
    }
    function renderNodeActions(node) {
      const actions = NODE_ACTIONS[node.group];
      for (const [action, text] of actions) {
        const button = el('button', text);
        if (node.group === 'MODEL' && !graph.relevant.has(node.id)) button.disabled = true;
        else checkAction(button, action, node.id);
        button.onclick = () => perform(action, node.id);
        aside.append(button);
      }
    }
    function renderSidebar() {
      cancelChecks();
      aside.replaceChildren();

      if (query) {
        renderSearchResults(query);
        return;
      }
      const node = graph.byId.get(selected);
      if (node) renderSelectedNode(node);
      else renderOverview();
      renderCollapsedModels();
    }
    function renderOverview() {
      aside.append(el('div', 'GRAPH OVERVIEW', 'type'), el('h2', 'Explore the calculation'), el('p', 'Follow arrows from source inputs through models to final outputs. Select a model to inspect or collapse its dependencies.'));
      aside.append(el('h3', 'Final outputs'));
      const list = el('div', undefined, 'list');
      graph.roots.forEach(id => list.append(row(id)));
      aside.append(list);
    }
    function renderSelectedNode(node) {
      aside.append(el('div', `${node.group}${graph.sources.has(node.id) ? ' · source input' : ''}${view.active.has(node.id) ? ' · collapsed' : ''}`, 'type'), el('h2', label(node.id)), el('p', node.description ?? `Node ID: ${node.id}`));
      const descriptionButton = el('button', 'Open node page');
      descriptionButton.onclick = () => openNode(node.id);
      aside.append(descriptionButton);
      renderNodeActions(node);
      if (node.group === 'MODEL') aside.append(el('p', 'Source inputs and shared dependencies stay visible. Expand a layer from either end without losing the other exposed boundary.'));

      renderConnections(node);
      if (node.metadata) {
        aside.append(el('h3', 'Metadata'), el('div', JSON.stringify(node.metadata, null, 2), 'metadata'));
      }
    }
    function renderConnections(node) {
      for (const [name, map] of [['Inputs / producers', graph.incoming], ['Outputs / consumers', graph.outgoing]]) {
        aside.append(el('h3', name));
        const list = el('div', undefined, 'list');
        [...new Set(map.get(node.id))].forEach(id => {
          const hidden = view.hidden.has(id);
          list.append(row(id, hidden ? 'Inside a collapsed branch' : undefined));
        });
        aside.append(list.childElementCount ? list : el('p', 'None'));
      }
    }
    function renderCollapsedModels() {
      if (graphState.regions.size) {
        aside.append(el('h3', 'Collapsed models'));
        const list = el('div', undefined, 'list');
        for (const id of graphState.regions.keys()) {
          const button = el('button', `Expand ${label(id)}`);
          if (view.dormant.has(id)) button.append(el('small', 'Nested inside another collapse'));
          button.onclick = () => perform('expandAll', id);
          list.append(button);
        }
        aside.append(list);
      }
    }

    return {
      render(context) {
        ({graph, graphState, view, selected, visibleIds, query} = context);
        renderSidebar();
      }
    };
  }

  const canonicalId = node => node.collapsed ? node.collapsedFrom : node.id;
  const copyPositions = entries => new Map([...entries].map(([id, point]) => [id, {...point}]));

  /** Shared Flow positions; physics is never enabled. */
  function createLayout({network, nodeSet, edgeSet, allGraph, saved, flowOptions, clearDisplay}) {
    let defaults = new Map(saved?.sharedLayout?.defaults ?? []);
    let shared = new Map(saved?.sharedLayout?.positions ?? []);

    function freezePositions() {
      network.setOptions({
        physics: {enabled: false},
        layout: {improvedLayout: false, hierarchical: {enabled: false}}
      });
    }

    function capture() {
      const captured = network.getPositions();
      for (const node of nodeSet.get()) {
        const point = captured[node.id];
        if (point) shared.set(canonicalId(node), {...point});
      }
    }

    function calculateDefaults() {
      freezePositions();
      clearDisplay();
      const full = allGraph.derive(allGraph.createState());
      nodeSet.add(full.nodes.map(({group, ...node}) => ({
        ...node,
        label: String(node.label ?? node.id),
        shape: group === 'MODEL' ? 'box' : 'ellipse'
      })));
      edgeSet.add(full.edges);
      if (!allGraph.hasCycle) {
        network.setOptions({layout: {randomSeed: 42, hierarchical: {
          enabled: true, direction: 'LR', sortMethod: 'directed',
          levelSeparation: 220, nodeSpacing: 100, ...flowOptions
        }}});
      }
      const captured = network.getPositions();
      defaults = new Map(full.nodes.map(node => [node.id, {...captured[node.id]}]));
      freezePositions();
      clearDisplay();
    }

    function initialize() {
      if (!defaults.size) calculateDefaults();
      if (!shared.size) shared = copyPositions(defaults);
    }

    function restoreFlow() {
      freezePositions();
      const updates = nodeSet.get().flatMap(node => {
        const point = shared.get(canonicalId(node));
        return point ? [{id: node.id, ...point}] : [];
      });
      if (updates.length) nodeSet.update(updates);
    }

    function reset() {
      shared = copyPositions(defaults);
    }

    function styleEdges(graph) {
      // Apply after hierarchy is disabled, since vis can overwrite smoothing.
      const smooth = graph.nodes.length >= 500 ? {enabled: false}
        : {enabled: true, type: 'cubicBezier', forceDirection: 'horizontal', roundness: .35};
      network.setOptions({edges: {smooth}});
    }

    return {
      initialize, capture, restoreFlow, reset, styleEdges,
      pointFor(node) { return shared.get(canonicalId(node)); },
      exportShared() { return {positions: [...shared], defaults: [...defaults]}; }
    };
  }

  global.TreeView = {element: el, createShell, createSidebar, createLayout};
})(typeof window !== 'undefined' ? window : globalThis);

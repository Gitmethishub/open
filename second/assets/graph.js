/* Pure graph rules: a closed MODEL stops traversal; everything else is derived. */
(function (root) {
  'use strict';
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const validId = id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
  const freshState = () => ({ closed: new Set(), exploration: null });
  function walk(graph, starts, direction, stop = () => false) {
    const seen = new Set(), pending = [...starts];
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      if (!stop(id)) for (const next of graph[direction].get(id)) pending.push(next);
    }
    return seen;
  }
  function createGraph(inputNodes, inputEdges, rootIds) {
    assert(Array.isArray(inputNodes) && Array.isArray(inputEdges), 'Nodes and edges must be arrays.');
    const nodes = structuredClone(inputNodes), edges = structuredClone(inputEdges);
    const byId = new Map(), incoming = new Map(), outgoing = new Map(), edgeIds = new Set();
    for (const node of nodes) {
      assert(node && validId(node.id) && !byId.has(node.id), 'Node IDs must be unique strings or finite numbers.');
      assert(node.group === 'DATA' || node.group === 'MODEL', 'Node group must be DATA or MODEL.');
      byId.set(node.id, node); incoming.set(node.id, []); outgoing.set(node.id, []);
    }
    for (const edge of edges) {
      assert(edge && byId.has(edge.from) && byId.has(edge.to), 'Unknown edge endpoint.');
      assert(byId.get(edge.from).group !== byId.get(edge.to).group, 'Edges must alternate DATA and MODEL.');
      if (edge.id !== undefined) {
        assert(validId(edge.id) && !edgeIds.has(edge.id), 'Edge IDs must be unique strings or finite numbers.');
        edgeIds.add(edge.id);
      }
    }
    let counter = 0;
    for (const edge of edges) {
      if (edge.id === undefined) {
        do { edge.id = `__doc_edge_${counter++}`; } while (edgeIds.has(edge.id));
        edgeIds.add(edge.id);
      }
      incoming.get(edge.to).push(edge.from); outgoing.get(edge.from).push(edge.to);
    }
    const sources = new Set(nodes.filter(n => n.group === 'DATA' && !incoming.get(n.id).length).map(n => n.id));
    const roots = rootIds === undefined ? nodes.filter(n => !outgoing.get(n.id).length).map(n => n.id) : structuredClone(rootIds);
    assert(Array.isArray(roots) && roots.every(id => byId.has(id)), 'Roots must be an array of known node IDs.');
    assert(rootIds !== undefined || !nodes.length || roots.length, 'A graph without terminal nodes needs explicit roots.');
    const degree = new Map(nodes.map(n => [n.id, incoming.get(n.id).length]));
    const queue = nodes.filter(n => degree.get(n.id) === 0).map(n => n.id);
    for (let i = 0; i < queue.length; i++) for (const id of outgoing.get(queue[i])) {
      degree.set(id, degree.get(id) - 1); if (!degree.get(id)) queue.push(id);
    }
    assert(queue.length === nodes.length, 'Calculation graphs must be acyclic.');
    const levels = new Map(nodes.map(n => [n.id, n.group === 'MODEL' ? 1 : 0]));
    for (const id of queue) for (const next of outgoing.get(id)) {
      levels.set(next, Math.max(levels.get(next), levels.get(id) + 1));
    }
    return { nodes, edges, byId, incoming, outgoing, sources, roots, levels };
  }
  const directionOf = state => state.exploration?.direction ?? 'incoming';
  function serialize(state) { return { closed: [...state.closed], exploration: state.exploration }; }
  function deserialize(graph, value) {
    assert(value && Array.isArray(value.closed), 'Invalid gate state.');
    assert(value.closed.every(id => graph.byId.get(id)?.group === 'MODEL'), 'Unknown model gate.');
    const exploration = value.exploration;
    assert(exploration === null || (exploration && graph.byId.has(exploration.startNode) && ['incoming', 'outgoing'].includes(exploration.direction)), 'Invalid exploration.');
    return { closed: new Set(value.closed), exploration: exploration ? { ...exploration } : null };
  }
  function derive(graph, state) {
    const direction = directionOf(state);
    const starts = state.exploration ? [state.exploration.startNode] : graph.roots;
    const visible = walk(graph, starts, direction, id => state.closed.has(id));
    if (!state.exploration) for (const id of graph.sources) visible.add(id);
    const hidden = new Set(graph.nodes.filter(n => !visible.has(n.id)).map(n => n.id));
    const active = new Set([...state.closed].filter(id => visible.has(id)));
    const edges = graph.edges.filter(e => visible.has(e.from) && visible.has(e.to)).map(e => ({ ...e }));
    const pairs = new Set(edges.map(e => JSON.stringify([e.from, e.to])));
    const edgeIds = new Set(graph.edges.map(e => e.id)), counts = new Map();
    // A summary connects only to visible boundaries reached through its hidden work.
    // Shared work already visible along another branch stops this walk naturally.
    for (const anchor of active) {
      const interior = new Set(), boundary = new Set(), pending = [...graph[direction].get(anchor)];
      while (pending.length) {
        const id = pending.pop();
        if (visible.has(id)) { if (id !== anchor) boundary.add(id); continue; }
        if (interior.has(id)) continue;
        interior.add(id);
        for (const next of graph[direction].get(id)) pending.push(next);
      }
      counts.set(anchor, interior.size);
      for (const id of boundary) {
        const from = direction === 'incoming' ? id : anchor, to = direction === 'incoming' ? anchor : id;
        const pair = JSON.stringify([from, to]);
        if (pairs.has(pair)) continue;
        pairs.add(pair);
        let edgeId = '__boundary_' + pair;
        while (edgeIds.has(edgeId)) edgeId += '_';
        edgeIds.add(edgeId);
        edges.push({ id: edgeId, from, to, arrows: 'to', dashes: true, synthetic: true });
      }
    }
    const nodes = graph.nodes.filter(n => visible.has(n.id)).map(n => active.has(n.id)
      ? { ...n, label: `${n.label ?? n.id}\n(collapsed)`, collapsed: true, hiddenCount: counts.get(n.id) }
      : { ...n });
    return { nodes, edges, hidden, active };
  }
  const actions = new Set(['collapse', 'expandLevel', 'expandBranch', 'exploreInputs', 'exploreOutputs']);
  function transition(graph, state, action, id) {
    assert(actions.has(action) && graph.byId.has(id), 'Unknown node or action.');
    const next = { closed: new Set(state.closed), exploration: state.exploration };
    if (action === 'exploreInputs' || action === 'exploreOutputs') {
      return { closed: new Set(), exploration: { startNode: id, direction: action === 'exploreInputs' ? 'incoming' : 'outgoing' } };
    }
    assert(graph.byId.get(id).group === 'MODEL', 'Only models can be collapsed or expanded.');
    const direction = directionOf(state);
    if (action === 'collapse') next.closed.add(id);
    if (action === 'expandLevel' && state.closed.has(id)) {
      next.closed.delete(id);
      for (const data of graph[direction].get(id)) for (const model of graph[direction].get(data)) next.closed.add(model);
    }
    if (action === 'expandBranch') for (const member of walk(graph, [id], direction)) next.closed.delete(member);
    return next;
  }
  function available(graph, state, view, action, id) {
    if (!graph.byId.has(id) || !actions.has(action)) return false;
    if (action.startsWith('explore')) return true;
    if (graph.byId.get(id).group !== 'MODEL') return false;
    if (action === 'collapse') return !view.hidden.has(id) && !state.closed.has(id) && graph[directionOf(state)].get(id).length > 0;
    if (action === 'expandLevel') return view.active.has(id);
    return state.closed.has(id); // Expand a registered gate, including one hidden behind another.
  }
  root.Graph = { assert, validId, createGraph, freshState, serialize, deserialize, walk, derive, transition, available };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Graph;
})(globalThis);

/* Project validation and the one-use documentation return ticket. */
(function (root) {
  'use strict';
  const C = root.Graph, { assert } = C;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  function project(options) {
    const automaticLayout = options.automaticLayout ?? false;
    assert(typeof automaticLayout === 'boolean', 'automaticLayout must be a boolean.');
    const nodes = structuredClone(options.dynamicNodes), edges = structuredClone(options.dynamicEdges);
    const info = structuredClone(options.profileInfo ?? {}), roots = structuredClone(options.rootIdsByProfile ?? {});
    assert(record(nodes) && record(edges) && own(nodes, 'all') && own(edges, 'all'), 'Both graph dictionaries need an all profile.');
    assert(record(info) && record(roots), 'Profile metadata and roots must be dictionaries.');
    const profiles = ['all', ...Object.keys(nodes).filter(id => id !== 'all')];
    for (const key of [...Object.keys(info), ...Object.keys(roots)]) assert(own(nodes, key), 'Unknown metadata or root profile.');
    const cache = new Map();
    for (const id of profiles) {
      assert(id.length && own(edges, id), 'Each profile needs edges.');
      if (own(info, id)) assert(record(info[id]) && (info[id].title === undefined || typeof info[id].title === 'string'), 'Invalid profile metadata.');
      cache.set(id, C.createGraph(nodes[id], edges[id], own(roots, id) ? roots[id] : undefined));
    }
    const all = cache.get('all');
    for (const graph of cache.values()) for (const node of graph.nodes) {
      assert(all.byId.get(node.id)?.group === node.group, 'All must contain each profile node with the same group.');
    }
    const graph = id => { assert(cache.has(id), 'Unknown profile.'); return cache.get(id); };
    let hash = 2166136261;
    for (const character of JSON.stringify(['gates-v1', nodes, edges, roots, automaticLayout])) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return { nodes, edges, info, roots, profiles, graph, automaticLayout, revision: (hash >>> 0).toString(16) };
  }
  function point(value) {
    return record(value) && Object.keys(value).length === 2 && Number.isFinite(value.x) && Number.isFinite(value.y);
  }
  function layoutMap(entries, graph) {
    assert(Array.isArray(entries) && entries.length === graph.nodes.length, 'Incomplete layout.');
    const map = new Map();
    for (const entry of entries) {
      assert(Array.isArray(entry) && entry.length === 2, 'Invalid layout entry.');
      const [id, position] = entry;
      assert(graph.byId.has(id) && !map.has(id) && point(position), 'Invalid layout coordinate.'); map.set(id, { ...position });
    }
    return map;
  }
  function snapshot(project, input) {
    const value = structuredClone(input);
    assert((value?.automaticLayout ?? false) === project.automaticLayout, 'The layout mode has changed; the saved view was discarded.');
    assert(record(value) && project.profiles.includes(value.profile) && record(value.states) && own(value.states, value.profile), 'Invalid snapshot profile.');
    const states = new Map();
    for (const [id, entry] of Object.entries(value.states)) {
      assert(project.profiles.includes(id), 'Unknown saved profile.');
      states.set(id, C.deserialize(project.graph(id), entry?.partial));
    }
    assert(value.selected === null || project.graph(value.profile).byId.has(value.selected), 'Invalid saved selection.');
    assert(point(value.camera?.position) && Number.isFinite(value.camera.scale) && value.camera.scale > 0, 'Invalid saved camera.');
    const all = project.graph('all');
    return { profile: value.profile, states, selected: value.selected, camera: value.camera,
      positions: layoutMap(value.sharedLayout?.positions, all), defaults: layoutMap(value.sharedLayout?.defaults, all) };
  }
  function normalizeURL(url) { const result = new URL(url); result.searchParams.delete('source'); result.hash = ''; return result; }
  function nodeURL(node, siteRoot, graphURL) {
    assert(typeof node.url === 'string' && node.url.endsWith('/'), 'Node URL must be a string ending in /.');
    const graph = normalizeURL(graphURL), result = new URL(node.url, new URL(siteRoot, graph));
    assert(['http:', 'https:'].includes(result.protocol) && result.origin === graph.origin, 'Node page must use HTTP(S) on this site.');
    return result.href;
  }
  function session(project, href, storage) {
    const url = new URL(href), normalized = normalizeURL(href), source = url.searchParams.get('source');
    const key = 'calculation-tree-gates-v1:' + normalized.href;
    return {
      source, normalized,
      read() {
        if (source === null) return null;
        const raw = storage.getItem(key); if (!raw) return null;
        const saved = JSON.parse(raw);
        assert(saved.revision === project.revision, 'The calculation has changed; the saved view was discarded.');
        return snapshot(project, saved.state);
      },
      save(state) { storage.setItem(key, JSON.stringify({ revision: project.revision, state })); },
      consume(history) {
        try { history.replaceState(history.state, '', normalized.href); } catch { /* Display must survive cleanup failure. */ }
        try { storage.removeItem(key); } catch { /* Same rule for storage. */ }
      }
    };
  }
  function returnRepresentative(graph, view, source) {
    const matches = graph.nodes.filter(node => String(node.id) === source);
    if (matches.length !== 1) return null;
    const queue = [matches[0].id], seen = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]; if (!view.hidden.has(id)) return id;
      for (const next of graph.outgoing.get(id)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    return null;
  }
  Object.assign(root.Graph, { project, snapshot, nodeURL, normalizeURL, session, returnRepresentative });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Graph;
})(typeof globalThis !== 'undefined' ? globalThis : this);

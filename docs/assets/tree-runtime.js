(function (global) {
  'use strict';

  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  /** Validate the Python-to-browser contract and lazily index each profile once. */
  function createProject({dynamicNodes, dynamicEdges, profileInfo = {}, rootIdsByProfile = {}, flowOptions = {}}) {
    if (!isRecord(dynamicNodes) || !isRecord(dynamicEdges)) {
      throw Error('dynamicNodes and dynamicEdges must be dictionaries keyed by profile ID.');
    }
    if (!hasOwn(dynamicNodes, 'all') || !hasOwn(dynamicEdges, 'all')) {
      throw Error('Both graph dictionaries must contain the all profile.');
    }
    if (!isRecord(profileInfo) || !isRecord(rootIdsByProfile)) {
      throw Error('profileInfo and rootIdsByProfile must be dictionaries.');
    }

    const configuredFlow = readFlowOptions(flowOptions);
    const ids = ['all', ...Object.keys(dynamicNodes).filter(id => id !== 'all')];
    const definitions = new Map();
    const graphCache = new Map();
    for (const id of ids) {
      if (!id || !Array.isArray(dynamicNodes[id]) || !hasOwn(dynamicEdges, id) || !Array.isArray(dynamicEdges[id])) {
        throw Error(`Profile ${id}: nodes and edges must both be arrays.`);
      }
      const info = hasOwn(profileInfo, id) ? profileInfo[id] : null;
      if (hasOwn(profileInfo, id) && (!isRecord(info) || typeof info.title !== 'string' || !info.title.trim())) {
        throw Error(`Profile ${id}: metadata must contain a non-empty title string.`);
      }
      const roots = hasOwn(rootIdsByProfile, id) ? rootIdsByProfile[id] : undefined;
      if (roots !== undefined && !Array.isArray(roots)) throw Error(`Profile ${id}: root IDs must be an array.`);
      definitions.set(id, {
        id,
        title: info?.title ?? (id === 'all' ? 'All' : id),
        nodes: dynamicNodes[id],
        edges: dynamicEdges[id],
        roots
      });
    }
    for (const dictionary of [dynamicEdges, profileInfo, rootIdsByProfile]) {
      for (const id of Object.keys(dictionary)) {
        if (!definitions.has(id)) throw Error(`Profile ${id} has metadata, roots or edges but no matching node graph.`);
      }
    }

    // Validate every profile's structure up front, without building every derived view.
    // Invalid targets must not fail halfway through a profile switch.
    const allGroups = new Map();
    for (const definition of definitions.values()) {
      const nodeIds = new Set();
      const edgeIds = new Set();
      for (const node of definition.nodes) {
        if (!isRecord(node) || !validId(node.id) || nodeIds.has(node.id)) {
          throw Error(`Profile ${definition.id}: each node needs a unique string or finite number ID.`);
        }
        if (!['DATA', 'MODEL'].includes(node.group)) throw Error(`Node ${node.id}: group must be DATA or MODEL.`);
        nodeIds.add(node.id);
        if (definition.id === 'all') allGroups.set(node.id, node.group);
        else if (allGroups.get(node.id) !== node.group) throw Error(`Profile ${definition.id}: node ${node.id} must exist with the same group in All.`);
      }
      const groups = new Map(definition.nodes.map(node => [node.id, node.group]));
      for (const edge of definition.edges) {
        if (!isRecord(edge) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw Error(`Profile ${definition.id}: an edge refers to an unknown node.`);
        if (groups.get(edge.from) === groups.get(edge.to)) throw Error(`Profile ${definition.id}: edges must alternate DATA and MODEL.`);
        if (edge.id !== undefined) {
          if (!validId(edge.id) || edgeIds.has(edge.id)) throw Error(`Profile ${definition.id}: edge IDs must be unique strings or finite numbers.`);
          edgeIds.add(edge.id);
        }
      }
      for (const root of definition.roots ?? []) {
        if (!nodeIds.has(root)) throw Error(`Profile ${definition.id}: unknown root ${root}.`);
      }
      if (definition.nodes.length && definition.roots === undefined) {
        const producers = new Set(definition.edges.map(edge => edge.from));
        if (definition.nodes.every(node => producers.has(node.id))) throw Error(`Profile ${definition.id}: no terminal nodes; configure rootIdsByProfile for this cyclic graph.`);
      }
    }

    function getGraph(id) {
      const definition = definitions.get(id);
      if (!definition) throw Error(`Unknown profile: ${id}`);
      if (!graphCache.has(id)) {
        graphCache.set(id, global.TreeCore.createGraph(definition.nodes, definition.edges, definition.roots));
      }
      return graphCache.get(id);
    }

    return {
      definitions,
      getGraph,
      flowOptions: configuredFlow,
      // Titles do not change calculation identity or invalidate saved coordinates.
      revision: fingerprint({dynamicNodes, dynamicEdges, rootIdsByProfile, flowOptions: configuredFlow})
    };
  }

  function validId(id) {
    return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
  }

  function fingerprint(value) {
    let hash = 2166136261;
    for (const character of JSON.stringify(value)) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  const finite = value => typeof value === 'number' && Number.isFinite(value);

  function validateSnapshot(snapshot, project) {
    if (!isRecord(snapshot) || !project.definitions.has(snapshot.profile) || !isRecord(snapshot.states)) {
      throw Error('Invalid saved profile.');
    }
    const all = project.getGraph('all');
    const shared = snapshot.sharedLayout;
    if (!isRecord(shared)) throw Error('Missing shared layout.');
    validatePositions(shared.positions, all, true);
    validatePositions(shared.defaults, all, true);
    for (const [id, state] of Object.entries(snapshot.states)) {
      if (!project.definitions.has(id) || !isRecord(state)) throw Error('Unknown saved profile.');
      project.getGraph(id).createState(state.partial);
    }
    if (!Object.prototype.hasOwnProperty.call(snapshot.states, snapshot.profile)) throw Error('Missing active profile state.');
    if (snapshot.selected !== null && !project.getGraph(snapshot.profile).byId.has(snapshot.selected)) throw Error('Unknown saved selection.');
    const camera = snapshot.camera;
    if (!isRecord(camera) || !isRecord(camera.position) || !finite(camera.position.x) || !finite(camera.position.y) || !finite(camera.scale) || camera.scale <= 0) throw Error('Invalid saved camera.');
    return snapshot;
  }

  function validatePositions(entries, graph, complete = false) {
    if (!Array.isArray(entries)) throw Error('Saved positions must be ID/coordinate pairs.');
    const ids = new Set();
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) throw Error('Invalid saved coordinate entry.');
      const [id, point] = entry;
      if (!graph.byId.has(id) || ids.has(id) || !isRecord(point) || !finite(point.x) || !finite(point.y)) throw Error('Invalid saved coordinates.');
      if (Object.keys(point).some(key => !['x', 'y'].includes(key))) throw Error('Unexpected saved coordinate fields.');
      ids.add(id);
    }
    if (complete && ids.size !== graph.nodes.length) throw Error('Incomplete shared layout.');
  }

  /** Fixed settings supplied by tree.md; no runtime layout controls. */
  function readFlowOptions(options) {
    if (!isRecord(options)) throw Error('Flow options must be an object.');
    const configured = {parentCentralization: true, edgeMinimization: true, blockShifting: false};
    for (const key of Object.keys(options)) {
      if (!hasOwn(configured, key) || typeof options[key] !== 'boolean') throw Error('Unknown or invalid Flow option: ' + key);
      configured[key] = options[key];
    }
    return configured;
  }

  /** Resolve supplied directory URLs; never invent suffixes or filesystem roots. */
  function documentationUrl(node, graphUrl, siteRoot) {
    if (typeof node.url !== 'string' || !node.url.endsWith('/')) throw Error(`Node ${node.id}: url must be a directory path ending in /.`);
    const url = new URL(node.url, new URL(siteRoot, graphUrl));
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== graphUrl.origin) throw Error('Node URLs must belong to this documentation site.');
    return url;
  }

  function createSession(project, {siteRoot = '../'} = {}) {
    const graphUrl = new URL(global.location.href);
    const source = graphUrl.searchParams.get('source');
    graphUrl.searchParams.delete('source');
    graphUrl.hash = '';
    const key = 'calculation-tree-v2:' + graphUrl.href;

    function read() {
      if (source === null) return {state: undefined, notice: null};
      try {
        const record = JSON.parse(global.sessionStorage.getItem(key));
        if (!record) return {state: undefined, notice: null};
        if (record.revision !== project.revision) return {state: undefined, notice: 'The calculation changed; the tree was opened with a fresh layout.'};
        return {state: validateSnapshot(record.state, project), notice: null};
      } catch {
        return {state: undefined, notice: 'The saved tree state was unavailable or invalid; a fresh view was opened.'};
      }
    }

    function save(state) {
      try {
        global.sessionStorage.setItem(key, JSON.stringify({revision: project.revision, state}));
      } catch {
        throw Error('Unable to save tree state in this tab. Navigation stopped to preserve your view.');
      }
    }

    function consume() {
      if (source === null) return;
      try { global.history.replaceState(null, '', graphUrl.href); } catch { /* Some hosts restrict History access. */ }
      try { global.sessionStorage.removeItem(key); } catch { /* Cleanup must not prevent a return. */ }
    }

    return {
      source,
      read,
      save,
      consume,
      urlFor(node) { return documentationUrl(node, graphUrl, siteRoot); }
    };
  }

  /** Hidden returning nodes are represented by the first visible result-side boundary. */
  function returningRepresentative(source, graph, view) {
    const matches = graph.nodes.filter(node => String(node.id) === source);
    if (matches.length !== 1) return null;
    const visible = new Set(view.nodes.map(node => node.collapsed ? node.collapsedFrom : node.id));
    const queue = [matches[0].id];
    const visited = new Set();
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      if (visited.has(id)) continue;
      visited.add(id);
      if (visible.has(id)) return id;
      queue.push(...graph.outgoing.get(id));
    }
    return null;
  }

  global.TreeRuntime = {createProject, createSession, validateSnapshot, returningRepresentative};
})(typeof window !== 'undefined' ? window : globalThis);

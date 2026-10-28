(function (global) {
  'use strict';
  const copy = value => structuredClone(value);
  const validId = id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
  function createGraph(nodesInput, edgesInput, rootIds) {
    if (!Array.isArray(nodesInput) || !Array.isArray(edgesInput)) throw Error('Nodes and edges must be arrays.');
    const nodes = copy(nodesInput);
    const edges = copy(edgesInput);
    const byId = new Map();
    const incoming = new Map();
    const outgoing = new Map();
    for (const node of nodes) {
      if (!node || !validId(node.id) || byId.has(node.id)) throw Error('Every node needs a unique string or number ID.');
      if (!['MODEL', 'DATA'].includes(node.group)) throw Error(`Node ${node.id}: group must be "MODEL" or "DATA".`);
      byId.set(node.id, node);
      incoming.set(node.id, []);
      outgoing.set(node.id, []);
    }
    const edgeIds = new Set(edges.filter(e => e && e.id !== undefined).map(e => e.id));
    let nextEdgeId = 0;
    const seenEdges = new Set();
    for (const edge of edges) {
      if (!edge || !byId.has(edge.from) || !byId.has(edge.to)) throw Error(`Edge ${edge?.id ?? '(unnamed)'} has an unknown endpoint.`);
      if (byId.get(edge.from).group === byId.get(edge.to).group) throw Error('Edges must alternate between data and model nodes.');
      if (edge.id === undefined) {
        while (edgeIds.has(`__doc_edge_${nextEdgeId}`)) nextEdgeId++;
        edge.id = `__doc_edge_${nextEdgeId++}`;
        edgeIds.add(edge.id);
      }
      if (!validId(edge.id) || seenEdges.has(edge.id)) throw Error('Edge IDs must be unique strings or numbers.');
      seenEdges.add(edge.id);
      incoming.get(edge.to).push(edge.from);
      outgoing.get(edge.from).push(edge.to);
    }
    const roots = rootIds === undefined ? nodes.filter(n => !outgoing.get(n.id).length).map(n => n.id) : [...rootIds];
    if (nodes.length && !roots.length) throw Error('No terminal nodes found. Supply rootIds explicitly for a cyclic graph.');
    for (const id of roots) if (!byId.has(id)) throw Error(`Unknown root ID: ${id}`);
    const walkTowardInputs = (starts, stops = new Set()) => {
      const visited = new Set();
      const stack = [...starts];
      while (stack.length) {
        const id = stack.pop();
        if (visited.has(id)) continue;
        visited.add(id);
        if (!stops.has(id)) stack.push(...incoming.get(id));
      }
      return visited;
    };
    const relevant = walkTowardInputs(roots);
    const sources = new Set(nodes.filter(n => n.group === 'DATA' && !incoming.get(n.id).length).map(n => n.id));
    const syntheticIds = new Map();
    const usedIds = new Set(byId.keys());
    nodes.forEach((n, i) => {
      let id = `__doc_collapsed_${i}`;
      while (usedIds.has(id)) id += '_';
      usedIds.add(id);
      syntheticIds.set(n.id, id);
    });
    // Detect cycles without recursion, including disconnected components.
    const degree = new Map(nodes.map(n => [n.id, incoming.get(n.id).length]));
    const queue = nodes.filter(n => !degree.get(n.id)).map(n => n.id);
    for (let index = 0; index < queue.length; index++) {
      for (const id of outgoing.get(queue[index])) {
        degree.set(id, degree.get(id) - 1);
        if (!degree.get(id)) queue.push(id);
      }
    }
    const hasCycle = queue.length !== nodes.length;
    /** Region/exposure state is immutable by convention after creation. */
    function createState(saved) {
      if (saved !== undefined && (!saved || !Array.isArray(saved.regions) || !Array.isArray(saved.exposed))) {
        throw Error('Saved graph state must contain regions and exposed arrays.');
      }
      const regions = new Map();
      for (const entry of saved?.regions ?? []) {
        if (!Array.isArray(entry) || entry.length !== 2) throw Error('Invalid collapsed region.');
        const [anchor, members] = entry;
        if (byId.get(anchor)?.group !== 'MODEL' || !relevant.has(anchor) || regions.has(anchor)) throw Error('Invalid collapsed model.');
        if (!Array.isArray(members) || members.some(id => !byId.has(id))) throw Error('Unknown node in collapsed region.');
        regions.set(anchor, new Set(members));
      }
      if ((saved?.exposed ?? []).some(id => !byId.has(id))) throw Error('Unknown exposed node.');
      return {regions, exposed: new Set(saved?.exposed ?? [])};
    }
    function serializeState(state) {
      return {
        regions: [...state.regions].map(([id, members]) => [id, [...members]]),
        exposed: [...state.exposed]
      };
    }
    const viewCache = new WeakMap();
    const actionCache = new WeakMap();
    const signatureCache = new WeakMap();
    // Each stage preserves canonical order, which also stabilizes display IDs.
    function determineVisibility(state) {
      const collapsed = new Set(state.regions.keys());
      for (const id of collapsed) if (byId.get(id)?.group !== 'MODEL' || !relevant.has(id)) throw Error('Only models connected to a root can be collapsed.');
      const reached = walkTowardInputs(roots, collapsed);
      const candidates = new Set();
      for (const members of state.regions.values()) {
        for (const id of members) candidates.add(id);
      }
      const hidden = new Set([...candidates].filter(id => !reached.has(id) && !sources.has(id) && !state.exposed.has(id)));
      const active = new Set(nodes.filter(n => collapsed.has(n.id) && (!hidden.has(n.id) || state.exposed.has(n.id))).map(n => n.id));
      // A visible data boundary must retain every canonical producer. If an
      // enclosing region still masks that producer, expose it as a summary
      // instead of dropping its computation or emitting a dangling edge.
      for (const node of nodes) {
        if (node.group === 'MODEL' && hidden.has(node.id) && outgoing.get(node.id).some(id => !hidden.has(id))) {
          active.add(node.id);
        }
      }
      for (const id of active) hidden.delete(id);
      return {hidden, active, dormant: new Set([...collapsed].filter(id => !active.has(id)))};
    }
    function assignHiddenNodesToSummaries({hidden, active}) {
      const owners = new Map();
      const hiddenCounts = new Map();
      for (const anchor of active) {
        const visited = new Set();
        const stack = [anchor];
        while (stack.length) {
          const id = stack.pop();
          if (visited.has(id)) continue;
          visited.add(id);
          if (id !== anchor && !hidden.has(id)) continue;
          if (!owners.has(id)) owners.set(id, new Set());
          owners.get(id).add(anchor);
          if (hidden.has(id)) hiddenCounts.set(anchor, (hiddenCounts.get(anchor) ?? 0) + 1);
          stack.push(...incoming.get(id));
        }
      }
      for (const anchor of active) owners.set(anchor, new Set([anchor]));
      return {owners, hiddenCounts};
    }
    function buildDisplayNodes({hidden, active}, {hiddenCounts}) {
      const viewNodes = nodes.filter(n => !hidden.has(n.id) && !active.has(n.id)).map(copy);
      for (const id of active) {
        const node = byId.get(id);
        viewNodes.push({...copy(node), id: syntheticIds.get(id), label: `${node.label ?? node.id}\n(collapsed)`, collapsed: true, collapsedFrom: id,
          hiddenCount: hiddenCounts.get(id) ?? 0});
      }
      return viewNodes;
    }
    function buildDisplayEdges({hidden, active}, {owners}) {
      const endpoint = id => owners.has(id) ? [...owners.get(id)].map(a => syntheticIds.get(a)) : [id];
      const viewEdges = [];
      const boundary = new Map();
      const usedEdgeIds = new Set(edges.map(e => e.id));
      for (const edge of edges) {
        if (hidden.has(edge.from) && hidden.has(edge.to)) continue;
        // A shared hidden input belongs inside each consuming summary;
        // it does not imply a dependency between those summaries.
        if (hidden.has(edge.from) && active.has(edge.to)) continue;
        if (active.has(edge.from) && hidden.has(edge.to)) continue;
        if (!owners.has(edge.from) && !owners.has(edge.to)) {
          viewEdges.push(copy(edge));
          continue;
        }
        for (const from of endpoint(edge.from)) for (const to of endpoint(edge.to)) {
          if (from === to) continue;
          const key = JSON.stringify([from, to]);
          if (boundary.has(key)) {
            boundary.get(key).originalEdgeIds.push(edge.id);
            continue;
          }
          let id = '__doc_boundary_' + key;
          while (usedEdgeIds.has(id)) id += '_';
          usedEdgeIds.add(id);
          const result = {id, from, to, arrows: 'to', dashes: true, synthetic: true, originalEdgeIds: [edge.id]};
          boundary.set(key, result);
          viewEdges.push(result);
        }
      }
      return viewEdges;
    }
    function derive(state = createState()) {
      if (viewCache.has(state)) return viewCache.get(state);
      const visibility = determineVisibility(state);
      const ownership = assignHiddenNodesToSummaries(visibility);
      const result = {
        nodes: buildDisplayNodes(visibility, ownership),
        edges: buildDisplayEdges(visibility, ownership),
        ...visibility
      };
      viewCache.set(state, result);
      return result;
    }
    function walkTowardResults(start) {
      const visited = new Set();
      const stack = [start];
      while (stack.length) {
        const id = stack.pop();
        if (visited.has(id)) continue;
        visited.add(id);
        stack.push(...outgoing.get(id));
      }
      return visited;
    }
    function summarizeProducer(next, before, producer) {
      next.exposed.add(producer);
      const deeper = new Set([...walkTowardInputs([producer])].filter(id => before.hidden.has(id) && !sources.has(id)));
      deeper.delete(producer);
      if (deeper.size) {
        deeper.add(producer);
        next.regions.set(producer, deeper);
      } else {
        next.regions.delete(producer);
      }
    }

    function collapseAll(next, before, id) {
      const members = walkTowardInputs([id]);
      next.regions.set(id, members);
      for (const member of members) next.exposed.delete(member);
    }

    function collapseLevel(next, before, id) {
      const members = new Set(next.regions.get(id) ?? [id]);
      const frontier = new Set();
      const visited = new Set();
      const stack = [...incoming.get(id)];
      // Cross the existing hidden interior; stop at its visible input-data boundary.
      while (stack.length) {
        const current = stack.pop();
        if (visited.has(current)) continue;
        visited.add(current);
        if (before.hidden.has(current) && members.has(current)) {
          stack.push(...incoming.get(current));
        } else if (byId.get(current).group === 'DATA') {
          frontier.add(current);
        }
      }
      for (const data of frontier) {
        if (sources.has(data)) continue;
        members.add(data);
        for (const producer of incoming.get(data)) {
          members.add(producer);
          // Absorbing an existing summary must retain its hidden interior.
          for (const member of next.regions.get(producer) ?? []) members.add(member);
        }
      }
      next.regions.set(id, members);
      for (const member of members) next.exposed.delete(member);
    }

    function expandLevel(next, before, id) {
      if (!before.active.has(id)) return;
      next.regions.delete(id);
      next.exposed.add(id);
      for (const data of incoming.get(id)) {
        next.exposed.add(data);
        for (const producer of incoming.get(data)) summarizeProducer(next, before, producer);
      }
    }

    function expandAll(next, before, id) {
      for (const ancestor of walkTowardInputs([id])) {
        next.exposed.add(ancestor);
        next.regions.delete(ancestor);
      }
    }

    function downstreamAll(next, before, id) {
      if (before.hidden.has(id)) return;
      const following = walkTowardResults(id);
      for (const descendant of following) {
        next.exposed.add(descendant);
        next.regions.delete(descendant);
      }
      const boundaryData = new Set();
      for (const descendant of following) {
        if (byId.get(descendant).group !== 'MODEL') continue;
        for (const input of incoming.get(descendant)) {
          next.exposed.add(input);
          boundaryData.add(input);
        }
        for (const output of outgoing.get(descendant)) boundaryData.add(output);
      }
      // Reveal side-input data, but preserve its external hidden computation as summaries.
      for (const data of boundaryData) {
        for (const producer of incoming.get(data)) {
          if (!following.has(producer) && (before.hidden.has(producer) || before.active.has(producer))) {
            summarizeProducer(next, before, producer);
          }
        }
      }
    }

    function downstream(next, before, id) {
      if (byId.get(id).group !== 'DATA' || before.hidden.has(id)) return;
      for (const model of outgoing.get(id)) {
        if (!before.hidden.has(model) && !before.active.has(model)) continue;
        next.regions.delete(model);
        next.exposed.add(model);
        for (const output of outgoing.get(model)) {
          next.exposed.add(output);
          for (const producer of incoming.get(output)) {
            if (producer !== model && (before.hidden.has(producer) || before.active.has(producer))) {
              summarizeProducer(next, before, producer);
            }
          }
        }
        for (const input of incoming.get(model)) {
          next.exposed.add(input);
          for (const producer of incoming.get(input)) {
            if (producer !== model && (before.hidden.has(producer) || before.active.has(producer))) {
              summarizeProducer(next, before, producer);
            }
          }
        }
      }
    }

    const actions = {collapseAll, collapseLevel, expandLevel, expandAll, downstreamAll, downstream};

    function computeTransition(state, action, id) {
      const node = byId.get(id);
      if (!node) throw Error('Unknown node: ' + id);
      if (!Object.prototype.hasOwnProperty.call(actions, action)) throw Error('Unknown graph action: ' + action);
      if (!['downstream', 'downstreamAll'].includes(action) && (node.group !== 'MODEL' || !relevant.has(id))) throw Error('Select a model connected to a root.');
      const next = createState(serializeState(state));
      actions[action](next, derive(state), id);
      return next;
    }
    function transition(state, action, id) {
      let perNode = actionCache.get(state);
      if (!perNode) {
        perNode = new Map();
        actionCache.set(state, perNode);
      }
      let perAction = perNode.get(id);
      if (!perAction) {
        perAction = new Map();
        perNode.set(id, perAction);
        if (perNode.size > 4) perNode.delete(perNode.keys().next().value);
      }
      if (!perAction.has(action)) perAction.set(action, computeTransition(state, action, id));
      return perAction.get(action);
    }
    function signature(view) {
      if (!signatureCache.has(view)) signatureCache.set(view, JSON.stringify([view.nodes.map(n => [n.id, n.hiddenCount]), view.edges.map(e => [e.from, e.to])]));
      return signatureCache.get(view);
    }
    function canTransition(state, action, id) {
      if (!byId.has(id) || !Object.prototype.hasOwnProperty.call(actions, action)) return false;
      if (!['downstream', 'downstreamAll'].includes(action) && (byId.get(id).group !== 'MODEL' || !relevant.has(id))) return false;
      const before = derive(state);
      if (action === 'expandLevel' && !before.active.has(id)) return false;
      if (action === 'downstream' && !outgoing.get(id).some(n => before.hidden.has(n) || before.active.has(n))) return false;
      if (action === 'expandAll' && ![...walkTowardInputs([id])].some(n => before.hidden.has(n) || before.active.has(n))) return false;
      return signature(before) !== signature(derive(transition(state, action, id)));
    }
    return {nodes, edges, roots, byId, incoming, outgoing, relevant, sources, hasCycle, derive, createState, serializeState, transition, canTransition};
  }
  global.TreeCore = {createGraph};
  if (typeof module !== 'undefined') module.exports = global.TreeCore;
})(typeof window !== 'undefined' ? window : globalThis);

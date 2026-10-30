/* Drawing and coordinates only. The graph module owns visibility decisions. */
(function (root) {
  'use strict';
  const copyPositions = map => new Map([...map].map(([id, point]) => [id, { ...point }]));
  function color(node, graph) {
    const palette = node.collapsed ? ['#e6e1f4', '#8a76b0'] : node.group === 'MODEL' ? ['#e0efe9', '#6c9d8d'] : graph.sources.has(node.id) ? ['#fff1d9', '#d3b074'] : ['#e7eff9', '#89a8ce'];
    const custom = typeof node.color === 'string' ? { background: node.color, border: node.color } : node.color ?? {};
    const normal = { background: palette[0], border: palette[1], ...custom };
    return { ...normal, hover: { background: normal.background, border: normal.border, ...custom.hover }, highlight: { background: normal.background, border: normal.border, ...custom.highlight } };
  }
  function tooltip(text) { const span = document.createElement('span'); span.textContent = String(text); return span; }
  function create(container, all, saved, useAutomatic = root.GraphLayout.useAutomatic) {
    const datasets = { nodes: new vis.DataSet(), edges: new vis.DataSet() };
    const network = new vis.Network(container, datasets, {
      physics: false, layout: { improvedLayout: false, hierarchical: { enabled: false } },
      nodes: { font: { face: 'system-ui', size: 15, color: '#233343' }, borderWidth: 1.5, margin: 12, fixed: { x: true, y: false }, scaling: { label: { drawThreshold: 7 } } },
      edges: { arrows: 'to', color: { color: '#aabac7', highlight: '#326b59' }, width: 1.2, font: { size: 10, color: '#718192' } },
      interaction: { hover: true, hoverConnectedEdges: false, selectConnectedEdges: false, hideEdgesOnDrag: true, hideEdgesOnZoom: true,
        keyboard: { enabled: true, bindToWindow: false }, tooltipDelay: 250 }
    });
    let defaults;
    try { defaults = root.GraphLayout.initialPositions(all, network, datasets, useAutomatic); }
    catch (error) { network.destroy(); throw error; }
    // Both layout strategies supply starting positions; interaction rules stay the same.
    let positions = copyPositions(defaults);
    if (saved) for (const [id, point] of saved) positions.get(id).y = point.y;
    let graph, view, nodeSignatures = new Map(), edgeSignatures = new Map();
    const pointFor = id => ({ ...positions.get(id), x: graph.sources.has(id) ? 0 : defaults.get(id).x });
    function capture() {
      if (!view) return;
      const current = network.getPositions(view.nodes.map(n => n.id));
      for (const node of view.nodes) {
        const point = current[node.id];
        if (!point || !Number.isFinite(point.y)) continue;
        positions.get(node.id).y = point.y;
        const x = pointFor(node.id).x;
        if (point.x !== x) network.moveNode(node.id, x, point.y);
      }
    }
    function render(nextGraph, nextView) {
      capture();
      if (graph !== nextGraph) {
        datasets.edges.clear(); datasets.nodes.clear(); nodeSignatures.clear(); edgeSignatures.clear();
      }
      graph = nextGraph; view = nextView;
      const nextNodes = new Map(view.nodes.map(n => [n.id, JSON.stringify(n)]));
      const nextEdges = new Map(view.edges.map(e => [e.id, JSON.stringify(e)]));
      datasets.edges.remove([...edgeSignatures.keys()].filter(id => !nextEdges.has(id)));
      datasets.nodes.remove([...nodeSignatures.keys()].filter(id => !nextNodes.has(id)));
      const changedNodes = view.nodes.filter(n => nextNodes.get(n.id) !== nodeSignatures.get(n.id)).map(node => {
        const { group, ...record } = node;
        return { ...record, ...pointFor(node.id), fixed: { x: true, y: false }, collapsed: !!node.collapsed,
          label: String(node.label ?? node.id), title: tooltip(`${node.label ?? node.id}${node.collapsed ? `\n${node.hiddenCount} hidden nodes` : ''}`),
          shape: group === 'MODEL' ? 'box' : 'ellipse', color: color(node, graph) };
      });
      const smooth = graph.nodes.length >= 500 ? false : { enabled: true, type: 'cubicBezier', forceDirection: 'horizontal', roundness: 0.35 };
      const changedEdges = view.edges.filter(e => nextEdges.get(e.id) !== edgeSignatures.get(e.id)).map(edge => ({ ...edge, smooth,
        ...(edge.title !== undefined ? { title: tooltip(edge.title) } : {}) }));
      if (changedNodes.length) datasets.nodes.update(changedNodes);
      if (changedEdges.length) datasets.edges.update(changedEdges);
      nodeSignatures = nextNodes; edgeSignatures = nextEdges;
    }
    const camera = () => ({ position: network.getViewPosition(), scale: network.getScale() });
    const moveCamera = value => network.moveTo({ ...value, animation: false });
    function reset() {
      const before = camera(); positions = copyPositions(defaults);
      datasets.nodes.update(view.nodes.map(n => ({ id: n.id, ...pointFor(n.id), fixed: { x: true, y: false } })));
      moveCamera(before);
    }
    network.on('dragEnd', capture);
    return { network, render, camera, moveCamera, reset,
      layout() { capture(); return { positions: [...copyPositions(positions)], defaults: [...copyPositions(defaults)] }; },
      select(id) { if (id !== null && !view.hidden.has(id)) network.selectNodes([id], false); else network.unselectAll(); },
      focus(id) { if (!view.hidden.has(id)) network.focus(id, { scale: Math.max(.65, network.getScale()), animation: { duration: 250 }, locked: false }); },
      center(id, factor) { network.moveTo({ position: pointFor(id), scale: network.getScale() * factor, animation: false }); },
      fit() { network.fit({ animation: { duration: 300 } }); },
      destroy() { network.destroy(); }
    };
  }
  root.GraphViewer = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.GraphViewer;
})(globalThis);

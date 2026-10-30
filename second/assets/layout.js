/* Change this one boolean to select the default layout for every viewer. */
(function (root) {
  'use strict';
  const USE_AUTOMATIC_LAYOUT = true;
  const COLUMN_GAP = 260;
  const ROW_GAP = 110;

  function predictable(graph) {
    const columns = new Map(), positions = new Map();
    for (const node of graph.nodes) {
      const level = graph.levels.get(node.id);
      if (!columns.has(level)) columns.set(level, []);
      columns.get(level).push(node.id);
    }
    for (const [level, ids] of columns) ids.forEach((id, index) => {
      positions.set(id, { x: level * COLUMN_GAP, y: (index - (ids.length - 1) / 2) * ROW_GAP });
    });
    return positions;
  }

  function automatic(graph, network, datasets) {
    if (!graph.nodes.length) return new Map();
    try {
      // Explicit levels keep every source in column zero. The library chooses y.
      // Use enabled:false rather than false so vis's hierarchy backup also keeps physics off.
      network.setOptions({
        physics: { enabled: false },
        layout: { randomSeed: 42, improvedLayout: false, hierarchical: {
          enabled: true, direction: 'LR', sortMethod: 'directed',
          levelSeparation: COLUMN_GAP, nodeSpacing: ROW_GAP,
          parentCentralization: true, edgeMinimization: true, blockShifting: true
        } },
        edges: { smooth: false }
      });
      datasets.nodes.add(graph.nodes.map(node => ({
        id: node.id, label: String(node.label ?? node.id),
        shape: node.group === 'MODEL' ? 'box' : 'ellipse',
        level: graph.levels.get(node.id), fixed: { x: false, y: false }
      })));
      datasets.edges.add(graph.edges.map(({ id, from, to }) => ({ id, from, to })));
      const placed = network.getPositions(graph.nodes.map(node => node.id));
      return new Map(graph.nodes.map(node => [node.id, {
        x: graph.levels.get(node.id) * COLUMN_GAP, y: placed[node.id].y
      }]));
    } finally {
      network.setOptions({ physics: { enabled: false }, layout: { improvedLayout: false, hierarchical: { enabled: false } } });
      datasets.edges.clear(); datasets.nodes.clear();
    }
  }

  function initialPositions(graph, network, datasets, useAutomatic = USE_AUTOMATIC_LAYOUT) {
    return useAutomatic ? automatic(graph, network, datasets) : predictable(graph);
  }
  root.GraphLayout = { useAutomatic: USE_AUTOMATIC_LAYOUT, initialPositions, predictable };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.GraphLayout;
})(globalThis);

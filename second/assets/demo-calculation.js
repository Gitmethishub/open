/* Deterministic test data, separate from the production viewer. */
(function (root) {
  'use strict';
  function build({ stages = 12, lanes = 40 } = {}) {
    const nodes = [], edges = [], alternatives = new Set();
    const operations = ['Validate orders', 'Convert currency', 'Apply pricing', 'Allocate costs', 'Forecast demand', 'Adjust inventory', 'Calculate margin', 'Apply risk', 'Estimate tax', 'Reconcile accounts', 'Stress test', 'Finalize forecast'];
    const factors = ['Exchange rates', 'Tax rules', 'Energy prices', 'Interest rates', 'Inflation', 'Risk weights', 'Capacity limits', 'Discount policy'];
    function node(id, label, group, description, metadata) { nodes.push({ id, label, group, description, metadata }); return id; }
    function edge(from, to) { edges.push({ from, to }); }
    const number = lane => String(lane + 1).padStart(2, '0');
    for (let lane = 0; lane < lanes; lane++) node(`source:${lane}`, `Orders · unit ${number(lane)}`, 'DATA', 'Independent source records for this business unit.', { unit: lane + 1 });
    factors.forEach((label, i) => node(`factor:${i}`, label, 'DATA', 'A shared external input, also used by later calculation stages.'));
    for (let stage = 0; stage < stages; stage++) {
      for (let lane = 0; lane < lanes; lane++) {
        const model = `model:${stage}:${lane}`, output = `data:${stage}:${lane}`;
        node(model, `${operations[stage % operations.length]} · ${number(lane)}`, 'MODEL', `Stage ${stage + 1}, unit ${lane + 1}. Combines local and shared dependencies.`, { stage: stage + 1, unit: lane + 1 });
        node(output, `Stage ${stage + 1} result · ${number(lane)}`, 'DATA', 'Intermediate result reused by later stages and neighboring units.', { stage: stage + 1, unit: lane + 1 });
        const inputs = stage === 0 ? [`source:${lane}`] : [0, 1, 7].map(offset => `data:${stage - 1}:${(lane + offset) % lanes}`);
        if (stage >= 3 && lane % 3 === 0) inputs.push(`data:${stage - 3}:${(lane + 11) % lanes}`);
        if (lane % 5 === 0 || stage === stages - 1) inputs.push(`factor:${(stage + lane) % factors.length}`);
        for (const input of new Set(inputs)) edge(input, model);
        edge(model, output);
        if (lane % 4 === 0) {
          const alternate = `alternative:${stage}:${lane}`;
          node(alternate, `Alternative ${stage + 1} · ${number(lane)}`, 'MODEL', 'An alternative producer of the same result, present only in All calculations.');
          alternatives.add(alternate);
          edge(inputs[0], alternate); edge(`factor:${(lane + 3) % factors.length}`, alternate); edge(alternate, output);
        }
      }
    }
    const regions = Math.ceil(lanes / 5);
    for (let region = 0; region < regions; region++) {
      const model = `region-model:${region}`, result = `region:${region}`;
      node(model, `Consolidate region ${region + 1}`, 'MODEL', 'Combines the final results of up to five business units.');
      node(result, `Region ${region + 1} result`, 'DATA', 'Regional output used in the portfolio calculation.');
      for (let lane = region * 5; lane < Math.min(lanes, region * 5 + 5); lane++) edge(`data:${stages - 1}:${lane}`, model);
      edge(model, result);
    }
    node('portfolio-model', 'Consolidate portfolio', 'MODEL', 'Combines every regional result with the interest-rate assumption.');
    node('portfolio-result', 'Net portfolio result', 'DATA', 'The final output. Select its input model to collapse or explore the full dependency chain.', { currency: 'EUR', scenario: 'Illustrative synthetic calculation' });
    for (let region = 0; region < regions; region++) edge(`region:${region}`, 'portfolio-model');
    edge('factor:3', 'portfolio-model'); edge('portfolio-model', 'portfolio-result');
    const standardNodes = nodes.filter(n => !alternatives.has(n.id));
    const standardEdges = edges.filter(e => !alternatives.has(e.from) && !alternatives.has(e.to));
    return {
      dynamicNodes: { all: nodes, standard: standardNodes },
      dynamicEdges: { all: edges, standard: standardEdges },
      profileInfo: { all: { title: 'All calculations · alternative producers' }, standard: { title: 'Standard · one producer per result' } },
      stages, lanes
    };
  }
  root.DemoCalculation = { build };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DemoCalculation;
})(globalThis);

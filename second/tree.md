<div id="calculation-tree" data-documentation-graph></div>
<link rel="stylesheet" href="../assets/tree.css">
<script src="https://cdn.jsdelivr.net/npm/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<script src="../assets/graph.js"></script>
<script src="../assets/layout.js"></script>
<script src="../assets/viewer.js"></script>
<script src="../assets/app.js"></script>

<script>
(function () {
  const dynamicNodes =
// [REPLACE_ME_ALL_NODES]
  ;
  const dynamicEdges =
// [REPLACE_ME_ALL_EDGES]
  ;
  const profileInfo =
// [REPLACE_ME_PROFILE_METADATA]
  ;
  const host = document.getElementById('calculation-tree');
  try {
    CalculationTree.mount({
      container: host, dynamicNodes, dynamicEdges, profileInfo,
      siteRoot: '../',
      returnZoomFactor: 1.15
    });
  } catch (error) {
    host.replaceChildren();
    const p = document.createElement('p');
    p.setAttribute('role', 'alert');
    p.textContent = 'Unable to initialize the tree: ' + error.message;
    host.append(p);
  }
})();
</script>

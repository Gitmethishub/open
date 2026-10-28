<div id="calculation-tree" data-documentation-graph></div>

<link rel="stylesheet" href="../assets/tree.css">
<script src="https://cdn.jsdelivr.net/npm/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<script src="../assets/tree-core.js"></script>
<script src="../assets/tree-runtime.js"></script>
<script src="../assets/tree-view.js"></script>
<script src="../assets/tree-viewer.js"></script>
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
      container: host,
      dynamicNodes,
      dynamicEdges,
      profileInfo,
      siteRoot: '../',
      flowOptions: {
        parentCentralization: true,
        edgeMinimization: true,
        blockShifting: false
      },
      returnZoomFactor: 1.15,
      // Optional: rootIdsByProfile: {all: ['result'], profile1: ['result']}
    });
  } catch (error) {
    host.replaceChildren();
    const message = document.createElement('p');
    message.setAttribute('role', 'alert');
    message.textContent = 'Unable to initialize the tree: ' + error.message;
    host.append(message);
  }
})();
</script>

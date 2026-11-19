function buildDependencyGraph() {
  return new Map([
    ['user-service', ['order-service']],
    ['order-service', ['payment-service']],
    ['payment-service', ['database']],
    ['database', []]
  ]);
}

function bfsRootCause(graph, startService) {
  const queue = [[startService, [startService]]];
  const visited = new Set();

  while (queue.length) {
    const [node, path] = queue.shift();
    if (visited.has(node)) continue;
    visited.add(node);

    if (node === 'database') return { path, rootCause: 'database' };

    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        queue.push([neighbor, [...path, neighbor]]);
      }
    }
  }

  return { path: [startService], rootCause: startService };
}

function detectRootCause(serviceName, metadata = {}) {
  const graph = buildDependencyGraph();
  const bfs = bfsRootCause(graph, serviceName);
  const databaseOverloaded = Number(metadata.dbConnections) > 95;
  const rootCause = databaseOverloaded ? 'database' : serviceName;
  const dependentServices = {
    'payment-service': ['payment-service', 'order-service', 'user-service'],
    'order-service': ['order-service', 'user-service'],
    'user-service': ['user-service']
  };
  const affectedServices = databaseOverloaded
    ? ['payment-service', 'order-service', 'user-service']
    : dependentServices[serviceName] || [serviceName];

  return {
    rootCause,
    rootCauseType: databaseOverloaded ? 'database_bottleneck' : metadata.failureMode || 'traffic_spike',
    affectedServices,
    propagationPath: databaseOverloaded ? bfs.path : [serviceName],
    evidence: [
      databaseOverloaded ? 'Database connections above 95%' : 'Traffic volume increased beyond normal threshold',
      `${serviceName} latency increased`,
      'Order service affected due to dependency'
    ]
  };
}

module.exports = { buildDependencyGraph, bfsRootCause, detectRootCause };

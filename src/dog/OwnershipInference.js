/**
 * OwnershipInference.js
 * Implements transitive ownership resolution over the DOG.
 *
 * Given a collection name, this module traverses ownership edges to find
 * ALL data subjects that have rights over rows in that collection —
 * including through multi-hop chains (e.g. Comment → Article → User).
 *
 * Mirrors K9db's ownership inference used to handle GDPR SARs.
 */

/**
 * @typedef {Object} OwnershipResult
 * @property {string}   dataSubject - Name of the data-subject collection
 * @property {string[]} path        - Full edge path from collection to data subject
 * @property {string}   type        - 'OWNED_BY' | 'ACCESSED_BY'
 * @property {string}   onDelete    - 'CASCADE' | 'ANONYMIZE' | 'RETAIN'
 */

/**
 * Infer all data subjects that have ownership rights over `collectionName`,
 * including through transitive chains in the DOG.
 *
 * @param {import('./Graph').Graph} graph
 * @param {string}                 collectionName
 * @param {Set<string>}            [visited] - internal cycle guard
 * @returns {OwnershipResult[]}
 */
function inferOwners(graph, collectionName, visited = new Set()) {
  if (visited.has(collectionName)) return [];
  visited.add(collectionName);

  const edges = graph.getEdgesFrom(collectionName);
  const results = [];

  for (const edge of edges) {
    if (edge.type !== 'OWNED_BY' && edge.type !== 'ACCESSED_BY') continue;

    // Direct relationship
    results.push({
      dataSubject: edge.to,
      path:        [collectionName, edge.field, edge.to],
      type:        edge.type,
      onDelete:    edge.onDelete,
    });

    // Transitive: follow edge.to recursively
    const upstream = inferOwners(graph, edge.to, new Set(visited));
    for (const upEntry of upstream) {
      results.push({
        dataSubject: upEntry.dataSubject,
        path:        [collectionName, edge.field, ...upEntry.path],
        type:        edge.type === 'OWNED_BY' ? upEntry.type : 'ACCESSED_BY',
        onDelete:    edge.onDelete === 'CASCADE' ? upEntry.onDelete : edge.onDelete,
      });
    }
  }

  return results;
}

/**
 * Build a complete ownership map: for each collection in the graph,
 * list all inferred data-subject owners.
 *
 * @param {import('./Graph').Graph} graph
 * @returns {Map<string, OwnershipResult[]>} collectionName → owners
 */
function buildOwnershipMap(graph) {
  const map = new Map();
  for (const collection of graph.getCollections()) {
    map.set(collection, inferOwners(graph, collection));
  }
  return map;
}

module.exports = { inferOwners, buildOwnershipMap };

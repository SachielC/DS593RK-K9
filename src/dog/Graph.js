/**
 * Graph.js
 * Lightweight adjacency-list directed graph representing the
 * Data Ownership Graph (DOG) over MongoDB collections.
 *
 * Nodes  = collection (model) names, e.g. 'User', 'Article', 'Comment'
 * Edges  = ownership relationships from child → parent data subject
 *
 * Mirrors the DOG abstraction from K9db (brownsys/K9db), re-implemented
 * for MongoDB/Mongoose instead of MySQL.
 */

class Graph {
  constructor() {
    /** @type {Map<string, Array<OwnershipEdge>>} */
    this._edges = new Map();
    /** @type {Set<string>} */
    this._nodes = new Set();
  }

  /**
   * @typedef {Object} OwnershipEdge
   * @property {string} from        - source collection (child)
   * @property {string} to          - target collection (parent / data subject)
   * @property {string} field       - Mongoose path that holds the reference
   * @property {string} type        - 'OWNED_BY' | 'ACCESSED_BY' | 'SHARED_AMONG'
   * @property {string} onDelete    - 'CASCADE' | 'ANONYMIZE' | 'RETAIN'
   */

  /**
   * Add a directed edge from `from` → `to`.
   * @param {OwnershipEdge} edge
   */
  addEdge(edge) {
    this._nodes.add(edge.from);
    this._nodes.add(edge.to);
    if (!this._edges.has(edge.from)) {
      this._edges.set(edge.from, []);
    }
    this._edges.get(edge.from).push(edge);
  }

  /**
   * Get all outbound edges from a collection.
   * @param {string} collection
   * @returns {OwnershipEdge[]}
   */
  getEdgesFrom(collection) {
    return this._edges.get(collection) || [];
  }

  /**
   * Get all collection names in the graph.
   * @returns {string[]}
   */
  getCollections() {
    return Array.from(this._nodes);
  }

  /**
   * Check if a collection is a declared data subject (has no outbound
   * OWNED_BY edges — it is the root of ownership chains).
   * @param {string} collection
   * @returns {boolean}
   */
  isDataSubject(collection) {
    const outbound = this.getEdgesFrom(collection);
    return outbound.filter(e => e.type === 'OWNED_BY').length === 0;
  }

  /**
   * Serialize the graph to a plain object (for debugging/visualization).
   */
  toJSON() {
    const result = { nodes: [], edges: [] };
    for (const node of this._nodes) result.nodes.push(node);
    for (const [, edges] of this._edges) result.edges.push(...edges);
    return result;
  }
}

module.exports = { Graph };

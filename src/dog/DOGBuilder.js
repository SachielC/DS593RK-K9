/**
 * DOGBuilder.js
 * Constructs the Data Ownership Graph (DOG) by scanning Mongoose model
 * schemas for _ownership metadata added via SchemaAnnotation.annotateOwnership().
 *
 * Analogous to K9db's schema parser that reads SQL CREATE TABLE annotations.
 */

const { Graph } = require('./Graph');

class DOGBuilder {
  /**
   * @param {Object} mongoose - Mongoose instance with models already registered
   */
  constructor(mongoose) {
    this.mongoose = mongoose;
  }

  /**
   * Scan all registered Mongoose models and extract ownership edges into a Graph.
   * Must be called AFTER all models are compiled (mongoose.model() calls are done).
   *
   * @returns {Graph}
   */
  build() {
    const graph = new Graph();

    for (const [modelName, model] of Object.entries(this.mongoose.models)) {
      this._processSchema(modelName, model.schema, graph);
    }

    return graph;
  }

  /**
   * Walk every path in the schema and emit DOG edges for annotated fields.
   * @param {string}         modelName
   * @param {mongoose.Schema} schema
   * @param {Graph}          graph
   */
  _processSchema(modelName, schema, graph) {
    // Register the node even if it has no outbound edges (data subject)
    schema.eachPath((pathName, schemaType) => {
      const ownership = schemaType.options?._ownership;
      if (!ownership) return;

      graph.addEdge({
        from:     modelName,
        to:       ownership.dataSubject,
        field:    pathName,
        type:     ownership.type,
        onDelete: ownership.onDelete,
      });
    });
  }
}

module.exports = { DOGBuilder };

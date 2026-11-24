'use strict';

/**
 * Create the resolver's lookup using registered Mongoose models.
 * Use models without request authorization hooks, or call from an internal
 * query context at the integration boundary. The caller owns the connection.
 */
function createMongooseLookup(connection, { session } = {}) {
  if (!connection || typeof connection.model !== 'function') {
    throw new TypeError('Expected a Mongoose connection with registered models');
  }

  return async function findById(modelName, id) {
    const query = connection.model(modelName).findById(id).lean();
    if (session) query.session(session);
    return query.exec();
  };
}

module.exports = { createMongooseLookup };

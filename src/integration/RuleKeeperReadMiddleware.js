'use strict';

const { createRecordPolicy } = require('./RuleKeeperRecordPolicy');

function denyRead() {
  return Object.assign(new Error('RuleKeeper denied the read'), {
    code: 'RULEKEEPER_READ_DENIED',
    status: 403
  });
}

/**
 * Opt-in schema plugin for executed find and findOne (including findById).
 * Register before model compilation on a schema that uses this plugin as
 * its read gate. The legacy RuleKeeper data ownership/transfer hooks
 * also gate reads, so do not register them on that same schema.
 * getContext provides the authenticated RuleKeeper principal and trusted
 * endpoint operation. The resolver's findById must be an internal lookup.
 * toEntityId maps a DOG subject { model, id, relation } to a canonical string
 * key in RuleKeeper's entities/consents data. Projected records must retain
 * their _id and the reference fields required by the descriptors.
 */
function createRuleKeeperReadMiddleware({
  policyManager, getContext, getDescriptors, findById, toEntityId
}) {
  const { authorizeOperation, authorizeRecord } = createRecordPolicy(policyManager);
  if ([getContext, getDescriptors, findById, toEntityId].some(fn => typeof fn !== 'function')) {
    throw new TypeError('Expected getContext, getDescriptors, findById, and toEntityId');
  }

  const operations = ['find', 'findOne'];
  const authorizationByQuery = new WeakMap();

  return function ruleKeeperReadMiddleware(schema) {
    schema.pre(operations, async function authorizeReadOperation() {
      // Capture request context before execution. The Mongoose 5 driver can
      // invoke the post hook outside the originating request's async context.
      authorizationByQuery.delete(this);
      const authorization = authorizeOperation(await getContext(this), this.model, this);
      if (!authorization) throw denyRead();
      authorizationByQuery.set(this, authorization);
    });

    schema.post(operations, async function authorizeRecords(result) {
      const authorization = authorizationByQuery.get(this);
      authorizationByQuery.delete(this);
      if (!authorization) throw denyRead();

      const model = this.model.modelName;
      const descriptors = await getDescriptors(model);
      const records = Array.isArray(result) ? result : result == null ? [] : [result];

      for (const record of records) {
        const allowed = await authorizeRecord({
          authorization, model, document: record, descriptors, findById, toEntityId
        });
        if (!allowed) throw denyRead();
      }
    });
  };
}

module.exports = { createRuleKeeperReadMiddleware };

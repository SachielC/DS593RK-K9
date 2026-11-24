'use strict';

const { createMongooseLookup } = require('../resolver/adapters/MongooseLookup');
const { createRecordPolicy } = require('./RuleKeeperRecordPolicy');

function denyWrite() {
  return Object.assign(new Error('RuleKeeper denied the write'), {
    code: 'RULEKEEPER_WRITE_DENIED',
    status: 403
  });
}

function assertFields(fields, model, action) {
  if (!fields || Object.getPrototypeOf(fields) !== Object.prototype) {
    throw new TypeError('Expected a plain object with document field values');
  }
  const { versionKey, discriminatorKey } = model.schema.options;
  for (const key of Object.keys(fields)) {
    if (key.includes('.') || key.startsWith('$') ||
        ['__proto__', 'constructor', 'prototype', versionKey, discriminatorKey].includes(key) ||
        (action === 'update' && key === '_id')) {
      throw new TypeError(`Unsupported write field: ${key}`);
    }
  }
}

/**
 * Opt-in writes on a transaction-capable MongoDB deployment.
 * Batch methods take an explicit list of records and commit as one unit.
 * Each action is bound to a configured RuleKeeper endpoint operation. The
 * application supplies authenticated request context, descriptors, and
 * subject-to-entity mapping. toEntityId receives a transaction-bound findById.
 *
 * Route protected writes through this service. Use models whose hooks do not
 * re-enter request authorization or perform non-transactional side effects.
 * Related ownership documents are read from the transaction snapshot.
 * Existing and proposed document fields are evaluated in full.
 */
function createRuleKeeperWriteService({
  model, policyManager, operations, getContext, getDescriptors, toEntityId,
  createLookup = createMongooseLookup
}) {
  const { authorizeOperation, authorizeRecord } = createRecordPolicy(policyManager);
  if (!model?.schema || typeof model.db?.startSession !== 'function' ||
      [getContext, getDescriptors, toEntityId, createLookup].some(fn => typeof fn !== 'function')) {
    throw new TypeError('Expected a Mongoose model and write authorization callbacks');
  }
  const expectedOperations = {};
  for (const action of ['create', 'update', 'delete', 'createMany', 'updateMany', 'deleteMany']) {
    const operation = operations?.[action];
    if (action.endsWith('Many') && operation === undefined) continue;
    if (typeof operation !== 'string' || !operation.trim()) {
      throw new TypeError(`Expected a RuleKeeper endpoint operation for ${action}`);
    }
    expectedOperations[action] = operation;
  }
  const endpoints = Object.values(expectedOperations);
  if (new Set(endpoints).size !== endpoints.length) {
    throw new TypeError('Each write action requires a distinct endpoint operation');
  }

  async function write(action, entries, batch = false) {
    const endpoint = expectedOperations[batch ? `${action}Many` : action];
    const context = await getContext();
    if (!endpoint || context?.operation !== endpoint) throw denyWrite();
    const authorization = authorizeOperation(context, model, { mongooseCollection: model.collection });
    if (!authorization) throw denyWrite();

    if (!Array.isArray(entries) || entries.length === 0) {
      throw new TypeError('Expected a nonempty array of batch entries');
    }
    const inputs = [];
    const targets = new Set();
    for (const entry of entries) {
      const { id, fields } = entry;
      if (action !== 'delete') assertFields(fields, model, action);
      if (action === 'create') {
        inputs.push({ fields });
        continue;
      }

      if (id == null) throw new TypeError('Expected a record ID');
      const castId = model.schema.path('_id').cast(id);
      const key = String(castId);
      if (targets.has(key)) throw new TypeError('A record may appear only once in a batch');
      targets.add(key);
      inputs.push({ id: castId, fields });
    }

    const descriptors = await getDescriptors(model.modelName);
    if (!Array.isArray(descriptors) || descriptors.length === 0) throw denyWrite();

    const session = await model.db.startSession();
    try {
      let results;
      await session.withTransaction(async () => {
        // Retry from the original inputs and recheck ownership after conflicts.
        results = [];
        const findById = createLookup(model.db, { session });
        const check = async document => {
          const allowed = await authorizeRecord({
            authorization, model: model.modelName, document, descriptors, findById,
            toEntityId: subject => toEntityId(subject, { session, findById })
          });
          if (!allowed) throw denyWrite();
        };
        const readRaw = _id => model.collection.findOne({ _id }, { session });

        const records = [];
        for (const input of inputs) {
          if (action === 'create') {
            records.push({ document: new model(), fields: input.fields });
            continue;
          }

          const existing = await readRaw(input.id);
          if (!existing) {
            if (!batch) return;
            throw Object.assign(new Error('A batch target was not found'), { status: 404 });
          }
          await check(existing);
          records.push({ document: model.hydrate(existing), fields: input.fields });
        }

        // Check every pre-write snapshot before any item can modify the graph.
        for (const { document, fields } of records) {
          if (action === 'delete') {
            const id = document._id;
            await document.deleteOne({ session });
            if (await readRaw(id)) throw denyWrite();
            results.push({ id });
            continue;
          }

          for (const [field, value] of Object.entries(fields)) {
            document.set(field, value, undefined, { strict: 'throw' });
          }
          const recordId = document._id;
          await document.validate();
          await check(document);
          await document.save({ session, validateBeforeSave: false });
          if (String(document._id) !== String(recordId)) throw denyWrite();
          results.push({ id: recordId });
        }

        if (action !== 'delete') {
          // Recheck the final state after all saves, including changes made by
          // save hooks or by a later record in the batch.
          for (const { id } of results) {
            const stored = await readRaw(id);
            if (!stored) throw denyWrite();
            await check(stored);
          }
        }
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
      return batch ? results : results[0] || null;
    } finally {
      await session.endSession();
    }
  }

  const batchEntries = (values, key) => Array.isArray(values)
    ? values.map(value => ({ [key]: value }))
    : values;
  return {
    create: fields => write('create', [{ fields }]),
    update: (id, fields) => write('update', [{ id, fields }]),
    delete: id => write('delete', [{ id }]),
    createMany: documents => write('create', batchEntries(documents, 'fields'), true),
    updateMany: entries => write('update', entries, true),
    deleteMany: ids => write('delete', batchEntries(ids, 'id'), true)
  };
}

module.exports = { createRuleKeeperWriteService };

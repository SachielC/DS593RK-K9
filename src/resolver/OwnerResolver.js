'use strict';

const { createOwnershipDescriptor } = require('./OwnershipDescriptor');

function readField(document, field) {
  // Mongoose documents expose schema paths through get(). Lean documents
  // use ordinary properties.
  if (typeof document.get === 'function') return document.get(field);

  let value = document;
  for (const part of field.split('.')) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function idKey(id) {
  if (typeof id === 'string' && id.trim() !== '') return `string:${id}`;
  if (typeof id === 'number' && Number.isFinite(id)) return `number:${id}`;
  if (id && typeof id.toHexString === 'function') {
    const hex = id.toHexString();
    if (typeof hex === 'string' && /^[a-f0-9]{24}$/i.test(hex)) {
      return `objectId:${hex.toLowerCase()}`;
    }
  }
  return undefined;
}

async function followPath(document, descriptor, descriptorIndex, findById, issues) {
  let documents = [document];

  for (const [hopIndex, hop] of descriptor.hops.entries()) {
    const nextDocuments = [];
    const issueLocation = { descriptorIndex, hopIndex };
    for (const current of documents) {
      const value = readField(current, hop.field);
      const references = Array.isArray(value) ? value : [value];

      for (const id of references) {
        if (id == null) {
          issues.push({ ...issueLocation, code: 'missing_reference' });
          continue;
        }
        if (!idKey(id)) {
          issues.push({ ...issueLocation, code: 'invalid_reference' });
          continue;
        }

        let target;
        try {
          target = await findById(hop.to, id);
        } catch (error) {
          issues.push({ ...issueLocation, code: 'lookup_failed', error });
          continue;
        }
        if (target == null) {
          issues.push({ ...issueLocation, code: 'missing_document' });
          continue;
        }
        if (!idKey(readField(target, '_id'))) {
          issues.push({ ...issueLocation, code: 'invalid_document' });
          continue;
        }
        nextDocuments.push(target);
      }
    }
    documents = nextDocuments;
  }

  return documents;
}

/**
 * Resolve subject identities for one record. findById(model, id) returns
 * an unpopulated Mongoose or plain document, or null for a missing record.
 * For populated fields, supply depopulated documents to the resolver.
 *
 * status: resolved | empty | no_paths | unresolved.
 * unresolved can include partial results. For an ownership-dependent
 * policy, unresolved must never be treated as a complete owner list.
 * An empty reference array is valid; a missing or null reference is unresolved.
 */
async function resolveOwners({ model, document, descriptors, findById }) {
  if (typeof model !== 'string' || !model.trim() || !document ||
      !Array.isArray(descriptors) || typeof findById !== 'function') {
    throw new TypeError('Expected model, document, descriptors, and findById');
  }
  const recordId = readField(document, '_id');
  if (!idKey(recordId)) {
    throw new TypeError('The source record requires a valid _id');
  }

  const paths = Array.from(descriptors, createOwnershipDescriptor);
  for (const descriptor of paths) {
    if (descriptor.sourceModel !== model) {
      throw new TypeError(`Descriptor sourceModel must match ${model}`);
    }
  }

  const issues = [];
  const subjects = new Map();
  for (const [index, descriptor] of paths.entries()) {
    const documents = await followPath(document, descriptor, index, findById, issues);
    for (const subject of documents) {
      const id = readField(subject, '_id');
      const key = JSON.stringify([descriptor.subjectModel, idKey(id), descriptor.relation]);
      if (!subjects.has(key)) {
        subjects.set(key, { model: descriptor.subjectModel, id, relation: descriptor.relation });
      }
    }
  }

  const status = issues.length > 0 ? 'unresolved'
    : paths.length === 0 ? 'no_paths'
    : subjects.size === 0 ? 'empty'
    : 'resolved';

  return { model, recordId, status, subjects: [...subjects.values()], issues };
}

module.exports = { resolveOwners };

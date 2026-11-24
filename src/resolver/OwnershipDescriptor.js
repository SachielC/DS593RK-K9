'use strict';

const relations = new Set(['OWNED_BY', 'ACCESSED_BY', 'SHARED_AMONG']);
const unsafeFieldParts = new Set(['__proto__', 'prototype', 'constructor']);

function isModelName(value) {
  return typeof value === 'string' && value.trim() !== '' && value.trim() === value;
}

function isFieldPath(value) {
  return typeof value === 'string' && value.split('.').every(
    part => part.length > 0 && !/[$\s\0]/.test(part) && !unsafeFieldParts.has(part)
  );
}

/**
 * Validate and copy a single path into the resolver's descriptor format.
 * An upstream adapter supplies registered Mongoose model names and the
 * path's effective relation. Each hop follows a forward reference to _id.
 */
function createOwnershipDescriptor(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Expected an ownership descriptor');
  }

  const { sourceModel, subjectModel, relation, hops } = input;
  if (!isModelName(sourceModel) || !isModelName(subjectModel)) {
    throw new TypeError('sourceModel and subjectModel must be model names');
  }
  if (!relations.has(relation)) {
    throw new TypeError('Expected OWNED_BY, ACCESSED_BY, or SHARED_AMONG');
  }
  if (!Array.isArray(hops) || hops.length === 0) {
    throw new TypeError('An ownership descriptor requires at least one hop');
  }

  let expectedFrom = sourceModel;
  const normalizedHops = [];
  for (const [index, hop] of hops.entries()) {
    if (!hop || hop.from !== expectedFrom || !isFieldPath(hop.field) || !isModelName(hop.to)) {
      throw new TypeError(`Invalid ownership hop at index ${index}; expected a reference from ${expectedFrom}`);
    }
    normalizedHops.push({ from: hop.from, field: hop.field, to: hop.to });
    expectedFrom = hop.to;
  }
  if (expectedFrom !== subjectModel) {
    throw new TypeError('The last hop must reach subjectModel');
  }

  return { sourceModel, subjectModel, relation, hops: normalizedHops };
}

module.exports = { createOwnershipDescriptor };

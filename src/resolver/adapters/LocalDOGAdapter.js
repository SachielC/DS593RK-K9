'use strict';

const { createOwnershipDescriptor } = require('../OwnershipDescriptor');

/**
 * Convert the local snapshot's inferOwners() results. That version emits
 * intermediate models as candidates, so the application supplies the set of
 * registered model names that are actual data subjects.
 */
function descriptorsFromLocalDOG(sourceModel, inferredPaths, subjectModels) {
  if (!Array.isArray(inferredPaths) || !(subjectModels instanceof Set) || subjectModels.size === 0) {
    throw new TypeError('Expected inferred paths and a nonempty Set of data-subject models');
  }

  const descriptors = [];
  for (const entry of inferredPaths) {
    if (!entry || typeof entry.dataSubject !== 'string') {
      throw new TypeError('Expected dataSubject on the inferred path');
    }
    if (!subjectModels.has(entry.dataSubject)) continue;

    const { path } = entry;
    if (!Array.isArray(path) || path.length < 3 || path.length % 2 === 0) {
      throw new TypeError('Expected an alternating model/field path ending in a model');
    }
    const hops = [];
    for (let index = 0; index < path.length - 1; index += 2) {
      const [from, field, to] = path.slice(index, index + 3);
      hops.push({ from, field, to });
    }

    descriptors.push(createOwnershipDescriptor({
      sourceModel,
      subjectModel: entry.dataSubject,
      relation: entry.type,
      hops
    }));
  }
  return descriptors;
}

module.exports = { descriptorsFromLocalDOG };

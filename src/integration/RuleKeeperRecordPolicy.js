'use strict';

const { resolveOwners } = require('../resolver/OwnerResolver');

function collectDataPaths(value, prefix = '', paths = new Set()) {
  if (Array.isArray(value) && value.length) {
    for (const item of value) collectDataPaths(item, prefix, paths);
  } else if (value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length) {
    for (const [field, child] of Object.entries(value)) {
      collectDataPaths(child, prefix ? `${prefix}.${field}` : field, paths);
    }
  } else if (prefix) {
    paths.add(prefix);
  }
  return paths;
}

function createRecordPolicy(policyManager) {
  for (const method of ['evaluateAccessControl', 'getPrincipalContext', 'checkPersonalData',
    'evaluateDataTransferControl']) {
    if (typeof policyManager?.[method] !== 'function') {
      throw new TypeError(`Expected RuleKeeper PolicyManager.${method}`);
    }
  }

  function authorizeOperation(context, model, policyTarget) {
    const { principal, operation } = context || {};
    if (!principal || !operation || policyManager.evaluateAccessControl(principal, operation) !== true) {
      return null;
    }

    const principalContext = policyManager.getPrincipalContext(principal);
    const roles = principalContext?.roles || [];
    const isDataSubject = roles.includes('Data Subject');
    const isAuthorizedRole = ['Data Controller', 'Data Processor', 'Third Party']
      .some(role => roles.includes(role));
    const table = model.collection.name;
    if ((!isDataSubject && !isAuthorizedRole) || policyManager.checkPersonalData(policyTarget)?.table !== table) {
      return null;
    }

    return { principal, operation, table, isDataSubject, entity: principalContext.entity };
  }

  async function authorizeRecord({ authorization, model, document, descriptors, findById, toEntityId }) {
    const ownership = await resolveOwners({ model, document, descriptors, findById });
    if (ownership.status !== 'resolved') return false;

    const entities = new Set();
    for (const subject of ownership.subjects) {
      if (subject.relation === 'ACCESSED_BY') continue;
      const entity = await toEntityId(subject);
      if (typeof entity !== 'string' || !entity.trim()) return false;
      entities.add(entity);
    }

    const { principal, operation, table, isDataSubject, entity } = authorization;
    if (entities.size === 0 || (isDataSubject && !entities.has(entity))) return false;

    const data = typeof document.toObject === 'function'
      ? document.toObject({ transform: false, getters: false, virtuals: false })
      : document;
    const subjects = { key: 'principal', list: [...entities] };
    return policyManager.evaluateDataTransferControl(
      principal, operation, [...collectDataPaths(data)], table, subjects
    ) === true;
  }

  return { authorizeOperation, authorizeRecord };
}

module.exports = { createRecordPolicy };

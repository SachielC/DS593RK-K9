/**
 * SchemaAnnotation.js
 * Helpers to annotate Mongoose schema fields with K9db-style
 * Data Ownership Graph (DOG) metadata.
 *
 * Usage in a Mongoose model file:
 *
 *   const { annotateOwnership, OwnershipType } = require('../../src/dog/SchemaAnnotation');
 *
 *   const ArticleSchema = new mongoose.Schema({
 *     author: annotateOwnership(
 *       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
 *       { type: OwnershipType.OWNED_BY, dataSubject: 'User', onDelete: 'CASCADE' }
 *     ),
 *     // ...
 *   });
 */

/** Ownership relationship types (mirrors K9db SQL annotations) */
const OwnershipType = Object.freeze({
  /** Direct ownership: data subject owns this row */
  OWNED_BY: 'OWNED_BY',
  /** Accessorship: data subject can read but doesn't "own" for deletion purposes */
  ACCESSED_BY: 'ACCESSED_BY',
  /** Shared ownership: multiple data subjects have rights to this row */
  SHARED_AMONG: 'SHARED_AMONG',
});

/** What to do when the owning data subject issues a GDPR FORGET request */
const OnDeleteBehavior = Object.freeze({
  /** Delete the row entirely (cascade deletion) */
  CASCADE: 'CASCADE',
  /** Nullify the ownership field (anonymization), keep the row */
  ANONYMIZE: 'ANONYMIZE',
  /** Keep the row as-is (retain for legal/contractual obligations) */
  RETAIN: 'RETAIN',
});

/**
 * Merge DOG ownership metadata into a Mongoose field definition.
 * The metadata is stored under the `_ownership` key, which is
 * recognized by DOGBuilder when scanning schemas.
 *
 * @param {Object} fieldDef - Mongoose field definition object
 * @param {Object} ownershipMeta
 * @param {string} ownershipMeta.type        - OwnershipType value
 * @param {string} ownershipMeta.dataSubject - Name of the referenced data-subject collection
 * @param {string} [ownershipMeta.onDelete]  - OnDeleteBehavior (default: CASCADE)
 * @returns {Object} - fieldDef merged with _ownership metadata
 */
function annotateOwnership(fieldDef, ownershipMeta) {
  if (!OwnershipType[ownershipMeta.type]) {
    throw new Error(`Unknown ownership type: ${ownershipMeta.type}. Use OwnershipType.OWNED_BY etc.`);
  }
  return {
    ...fieldDef,
    _ownership: {
      type: ownershipMeta.type,
      dataSubject: ownershipMeta.dataSubject,
      onDelete: ownershipMeta.onDelete || OnDeleteBehavior.CASCADE,
    },
  };
}

module.exports = { annotateOwnership, OwnershipType, OnDeleteBehavior };

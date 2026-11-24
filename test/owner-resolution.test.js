'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createOwnershipDescriptor } = require('../src/resolver/OwnershipDescriptor');
const { resolveOwners } = require('../src/resolver/OwnerResolver');

// Fixtures express the resolver's contract independently of the upstream DOG format.
const authorHop = { from: 'Article', field: 'author_id', to: 'User' };
const articleOwner = {
  sourceModel: 'Article',
  subjectModel: 'User',
  relation: 'OWNED_BY',
  hops: [authorHop]
};
const commentOwner = {
  ...articleOwner,
  sourceModel: 'Comment',
  hops: [{ from: 'Comment', field: 'article_id', to: 'Article' }, authorHop]
};

const records = {
  Article: new Map([[20, { _id: 20, author_id: 'Alice' }]]),
  User: new Map([['Alice', { _id: 'Alice' }], ['Bob', { _id: 'Bob' }]])
};

async function findById(model, id) {
  return records[model].get(id) ?? null;
}

test('validates and copies descriptors with continuous paths to the declared subject', () => {
  const descriptor = createOwnershipDescriptor(commentOwner);
  assert.deepEqual(descriptor, commentOwner);
  assert.notStrictEqual(descriptor.hops[0], commentOwner.hops[0]);
  assert.throws(() => createOwnershipDescriptor({ ...commentOwner, hops: [authorHop] }),
    /Invalid ownership hop/);
  assert.throws(() => createOwnershipDescriptor({ ...articleOwner, subjectModel: 'Team' }),
    /last hop/);
  assert.throws(() => createOwnershipDescriptor({ ...articleOwner, relation: 'UNKNOWN' }),
    /Expected OWNED_BY/);
});

test('resolves direct ownership for an Article', async () => {
  const result = await resolveOwners({
    model: 'Article',
    document: records.Article.get(20),
    descriptors: [articleOwner],
    findById
  });
  assert.deepEqual(result, {
    model: 'Article',
    recordId: 20,
    status: 'resolved',
    subjects: [{ model: 'User', id: 'Alice', relation: 'OWNED_BY' }],
    issues: []
  });
});

test('resolves two hops for a Comment and preserves its record ID', async () => {
  const lookups = [];
  const result = await resolveOwners({
    model: 'Comment',
    document: { _id: 100, article_id: 20 },
    descriptors: [commentOwner],
    findById(model, id) {
      lookups.push([model, id]);
      return findById(model, id);
    }
  });
  assert.deepEqual(lookups, [['Article', 20], ['User', 'Alice']]);
  assert.equal(result.recordId, 100);
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.subjects, [{ model: 'User', id: 'Alice', relation: 'OWNED_BY' }]);
});

test('reports a missing intermediate document without returning an owner', async () => {
  const result = await resolveOwners({
    model: 'Comment',
    document: { _id: 101, article_id: 999 },
    descriptors: [commentOwner],
    findById
  });
  assert.equal(result.status, 'unresolved');
  assert.deepEqual(result.subjects, []);
  assert.deepEqual(result.issues, [{ descriptorIndex: 0, hopIndex: 0, code: 'missing_document' }]);
});

test('preserves valid paths and accessorship when another path cannot resolve', async () => {
  const accessPath = {
    ...articleOwner,
    relation: 'ACCESSED_BY',
    hops: [{ ...authorHop, field: 'access.readers' }]
  };
  const result = await resolveOwners({
    model: 'Article',
    document: { _id: 21, author_id: 'Alice', access: { readers: ['Alice', 'Bob', 'Bob', 'Unknown'] } },
    descriptors: [articleOwner, accessPath],
    findById
  });
  assert.equal(result.status, 'unresolved');
  assert.deepEqual(result.subjects, [
    { model: 'User', id: 'Alice', relation: 'OWNED_BY' },
    { model: 'User', id: 'Alice', relation: 'ACCESSED_BY' },
    { model: 'User', id: 'Bob', relation: 'ACCESSED_BY' }
  ]);
  assert.deepEqual(result.issues, [{ descriptorIndex: 1, hopIndex: 0, code: 'missing_document' }]);
});

test('distinguishes empty references, absent descriptors, malformed IDs, and lookup failures', async () => {
  const resolve = (author_id, descriptors = [articleOwner], lookup = findById) =>
    resolveOwners({ model: 'Article', document: { _id: 21, author_id }, descriptors, findById: lookup });

  assert.equal((await resolve([])).status, 'empty');
  assert.equal((await resolve('Alice', [])).status, 'no_paths');
  assert.deepEqual((await resolve(undefined)).issues, [
    { descriptorIndex: 0, hopIndex: 0, code: 'missing_reference' }
  ]);
  assert.deepEqual((await resolve({})).issues, [
    { descriptorIndex: 0, hopIndex: 0, code: 'invalid_reference' }
  ]);

  const error = new Error('lookup failed');
  const failure = await resolve('Alice', [articleOwner], async () => { throw error; });
  assert.equal(failure.status, 'unresolved');
  assert.deepEqual(failure.issues, [{ descriptorIndex: 0, hopIndex: 0, code: 'lookup_failed', error }]);
});

test('keeps original ObjectId values and deduplicates equal IDs across paths', async () => {
  const makeId = () => ({ toHexString: () => '65df52bac89aca770b774695' });
  const reference = makeId();
  const result = await resolveOwners({
    model: 'Article',
    document: { _id: 22, author_id: reference },
    descriptors: [articleOwner, articleOwner],
    async findById(model, id) {
      assert.equal(model, 'User');
      assert.strictEqual(id, reference);
      return { _id: makeId() };
    }
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.subjects.length, 1);
  assert.equal(result.subjects[0].id.toHexString(), reference.toHexString());
});

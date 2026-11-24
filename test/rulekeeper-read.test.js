'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRuleKeeperReadMiddleware } = require('../src/integration/RuleKeeperReadMiddleware');

const descriptor = {
  sourceModel: 'Comment',
  subjectModel: 'User',
  relation: 'OWNED_BY',
  hops: [{ from: 'Comment', field: 'article', to: 'Article' },
    { from: 'Article', field: 'author', to: 'User' }]
};
const model = { modelName: 'Comment', collection: { name: 'comments' } };

function setupRead({ role = 'Data Subject', relation = 'OWNED_BY', transferAllowed = true } = {}) {
  let beforeRead;
  let afterRead;
  const policyCalls = [];
  createRuleKeeperReadMiddleware({
    policyManager: {
      evaluateAccessControl: () => true,
      getPrincipalContext: () => ({ entity: 'subject-alice', roles: [role] }),
      checkPersonalData: () => ({ table: 'comments' }),
      evaluateDataTransferControl(...args) {
        policyCalls.push(args);
        return transferAllowed;
      }
    },
    getContext: () => ({ principal: 'alice-login', operation: 'GET /comments' }),
    getDescriptors: () => [{ ...descriptor, relation }],
    findById(name, id) {
      if (name === 'Article') return id === 'gone' ? null : { _id: id, author: id };
      return { _id: id };
    },
    toEntityId: subject => `subject-${subject.id}`
  })({
    pre(operations, hook) {
      assert.deepEqual(operations, ['find', 'findOne']);
      beforeRead = hook;
    },
    post(operations, hook) {
      assert.deepEqual(operations, ['find', 'findOne']);
      afterRead = hook;
    }
  });
  async function read(records) {
    const query = { model };
    await beforeRead.call(query);
    return afterRead.call(query, records);
  }
  return { read, policyCalls };
}

test('uses the resolved entity and all nested fields in the RuleKeeper policy input', async () => {
  const { read, policyCalls } = setupRead();
  await read({ _id: 1, article: 'alice', items: [{ first: true }, { second: true }] });
  assert.deepEqual(policyCalls, [['alice-login', 'GET /comments',
    ['_id', 'article', 'items.first', 'items.second'],
    'comments', { key: 'principal', list: ['subject-alice'] }]]);
});

test('denies a mixed-owner read by a data subject, even with an allowing transfer policy', async () => {
  const { read, policyCalls } = setupRead();
  await assert.rejects(read([{ _id: 1, article: 'alice' }, { _id: 2, article: 'bob' }]),
    { code: 'RULEKEEPER_READ_DENIED' });
  assert.equal(policyCalls.length, 1);
});

test('evaluates a controller read one record at a time', async () => {
  const { read, policyCalls } = setupRead({ role: 'Data Controller' });
  await read([{ _id: 1, article: 'alice' }, { _id: 2, article: 'bob' }]);
  assert.deepEqual(policyCalls.map(call => call[4].list), [['subject-alice'], ['subject-bob']]);
});

test('denies dangling references, accessorship alone, and rejecting policy decisions', async () => {
  const denied = { code: 'RULEKEEPER_READ_DENIED' };
  const missing = setupRead();
  await assert.rejects(missing.read({ _id: 1, article: 'gone' }), denied);
  assert.equal(missing.policyCalls.length, 0);

  const accessOnly = setupRead({ relation: 'ACCESSED_BY' });
  await assert.rejects(accessOnly.read({ _id: 1, article: 'alice' }), denied);
  assert.equal(accessOnly.policyCalls.length, 0);

  const rejected = setupRead({ transferAllowed: false });
  await assert.rejects(rejected.read({ _id: 1, article: 'alice' }), denied);
  assert.equal(rejected.policyCalls.length, 1);
});

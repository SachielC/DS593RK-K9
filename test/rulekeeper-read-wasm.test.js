'use strict';

const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { setTimeout: wait } = require('node:timers/promises');
const { DOGBuilder } = require('../src/dog/DOGBuilder');
const { inferOwners } = require('../src/dog/OwnershipInference');
const { annotateOwnership } = require('../src/dog/SchemaAnnotation');
const {
  createRuleKeeperReadMiddleware, createRuleKeeperWriteService
} = require('../src/integration/rulekeeper-dog-bridge');
const { descriptorsFromLocalDOG } = require('../src/resolver/adapters/LocalDOGAdapter');
const { createMongooseLookup } = require('../src/resolver/adapters/MongooseLookup');

const rulekeeper = join(__dirname, '../rulekeeper');
const operation = 'GET /comments';
const writeOperations = {
  create: 'POST /comments', update: 'PATCH /comments/:id', delete: 'DELETE /comments/:id'
};

// Reproduce with OPA v1 and the RuleKeeper runtime dependencies and Mongoose 5
// on the module path. Set MONGODB_TEST_URI for reads and use a disposable
// replica set as MONGODB_WRITE_TEST_URI for the transaction test.
const { OPA_BIN, MONGODB_TEST_URI, MONGODB_WRITE_TEST_URI } = process.env;

async function loadPolicyManager(t, additionalEndpoints) {
  // The pinned manager loads its policies and data relative to __dirname.
  const directory = mkdtempSync(join(tmpdir(), 'dog-rulekeeper-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const middleware = join(rulekeeper, 'RuleKeeper Middleware');
  const rego = join(rulekeeper, 'RuleKeeper Manager/policies/rego');
  for (const folder of ['pep/policies', 'config', 'utils']) {
    mkdirSync(join(directory, folder), { recursive: true });
  }
  for (const file of ['pep/PolicyManager.js', 'pep/DataHelper.js', 'config/ConnectionManager.js',
    'config/version_utils.js', 'utils/logger.js']) {
    copyFileSync(join(middleware, file), join(directory, file));
  }

  for (const policy of ['access_control', 'rulekeeper']) {
    const bundle = join(directory, `${policy}.tar.gz`);
    execFileSync(OPA_BIN, ['build', '--v0-compatible', '-t', 'wasm', '-e', 'rulekeeper/allow',
      '-o', bundle, join(rego, 'policies', `${policy}.rego`), join(rego, 'utils'), join(rego, 'rules')]);
    const wasm = execFileSync('tar', ['-xOzf', bundle, '/policy.wasm']);
    writeFileSync(join(directory, 'pep/policies', `${policy}.wasm`), wasm);
  }

  const endpoints = [
    { endpoint: operation, operation: 'readComments' },
    ...Object.entries({ ...writeOperations, ...additionalEndpoints }).map(([action, endpoint]) => ({
      endpoint, operation: `${action}Comments`
    }))
  ];
  writeFileSync(join(directory, 'pep/data.json'), JSON.stringify({
    principals: {
      aliceLogin: { entity: 'entity-alice', role: 'reader' },
      bobLogin: { entity: 'entity-bob', role: 'reader' },
      clerk: { entity: 'entity-clerk', role: 'reader' },
      guest: { entity: 'entity-guest', role: 'guest' }
    },
    entities: {
      'entity-alice': { roles: ['Data Subject'] },
      'entity-bob': { roles: ['Data Subject'] },
      'entity-clerk': { roles: ['Data Controller'] },
      'entity-guest': { roles: ['Data Controller'] }
    },
    consents: {
      'entity-alice': { purposes: ['view'] },
      'entity-bob': { purposes: [] }
    },
    operation_endpoints: endpoints,
    operation_purposes: endpoints.map(({ operation }) => ({ operation, purpose: 'view' })),
    maximum_data: [{ purpose: 'view', data: ['commentBody'] }],
    data_purposes: [{ data: 'commentBody', purposes: ['view'] }],
    lawfulness_bases: [{ purpose: 'view', base: 'consent' }],
    role_operations: [{ role: 'reader', operations: endpoints.map(e => e.operation) }],
    personal_data_items: ['commentBody'],
    personal_data_tables: [{ table: 'comments', column: 'article' }],
    data_location: { comments: { body: { data: 'commentBody' } } }
  }));

  const manager = require(join(directory, 'pep/PolicyManager'));
  manager.init(); // This revision does not expose its asynchronous readiness.
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      manager.getPrincipalContext('aliceLogin');
      return manager;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await wait(10);
    }
  }
}

test('authorizes a Mongoose read through the pinned RuleKeeper WASM policies', {
  skip: OPA_BIN && MONGODB_TEST_URI ? false : 'requires OPA_BIN and MONGODB_TEST_URI'
}, async t => {
  const policyManager = await loadPolicyManager(t);
  const { Mongoose, Schema } = require('mongoose');
  const mongoose = new Mongoose();
  const request = new AsyncLocalStorage();
  const { ObjectId } = Schema.Types;
  const ref = dataSubject => annotateOwnership(
    { type: ObjectId, ref: dataSubject }, { type: 'OWNED_BY', dataSubject }
  );
  const User = mongoose.model('User', new Schema({ entity: String }));
  const Article = mongoose.model('Article', new Schema({ author: ref('User') }));
  const commentSchema = new Schema({ article: ref('Article'), body: String });
  const findById = createMongooseLookup(mongoose.connection);
  const subjectModels = new Set(['User']);
  let graph;
  commentSchema.plugin(createRuleKeeperReadMiddleware({
    policyManager,
    findById,
    getContext: () => request.getStore(),
    getDescriptors: model => descriptorsFromLocalDOG(model, inferOwners(graph, model), subjectModels),
    toEntityId: async ({ model, id }) => (await findById(model, id))?.entity
  }));
  const Comment = mongoose.model('Comment', commentSchema);
  graph = new DOGBuilder(mongoose).build();

  try {
    await mongoose.connect(MONGODB_TEST_URI, {
      dbName: `dog_read_test_${randomUUID().replace(/-/g, '')}`,
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000
    });

    const alice = await User.create({ entity: 'entity-alice' });
    const bob = await User.create({ entity: 'entity-bob' });
    const aliceArticle = await Article.create({ author: alice._id });
    const bobArticle = await Article.create({ author: bob._id });
    const aliceComment = await Comment.create({ article: aliceArticle._id, body: 'Alice comment' });
    const bobComment = await Comment.create({ article: bobArticle._id, body: 'Bob comment' });
    const dangling = await Comment.create({ article: new mongoose.Types.ObjectId(), body: 'Dangling comment' });

    const read = (principal, id) => request.run({ principal, operation },
      () => Comment.findById(id).lean().exec());
    const denied = { code: 'RULEKEEPER_READ_DENIED' };
    assert.equal((await read('aliceLogin', aliceComment._id)).body, 'Alice comment');
    assert.equal((await read('clerk', aliceComment._id)).body, 'Alice comment');
    await assert.rejects(read('aliceLogin', bobComment._id), denied);
    await assert.rejects(read('bobLogin', bobComment._id), denied);
    await assert.rejects(read('clerk', bobComment._id), denied);
    await assert.rejects(read('clerk', dangling._id), denied);
    await assert.rejects(read('guest', aliceComment._id), denied);
    await assert.rejects(request.run({ principal: 'aliceLogin', operation },
      () => Comment.find({ _id: { $in: [aliceComment._id, bobComment._id] } }).exec()), denied);
  } finally {
    try {
      if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  }
});

test('enforces create, update, and delete in a MongoDB transaction with RuleKeeper WASM', {
  skip: OPA_BIN && MONGODB_WRITE_TEST_URI ? false : 'requires OPA_BIN and a replica-set MONGODB_WRITE_TEST_URI'
}, async t => {
  const policyManager = await loadPolicyManager(t);
  const { Mongoose, Schema } = require('mongoose');
  const mongoose = new Mongoose();
  const request = new AsyncLocalStorage();
  const { ObjectId } = Schema.Types;
  const ref = dataSubject => annotateOwnership(
    { type: ObjectId, ref: dataSubject }, { type: 'OWNED_BY', dataSubject }
  );
  const User = mongoose.model('User', new Schema({ entity: String }));
  const Article = mongoose.model('Article', new Schema({ author: ref('User') }));
  const commentSchema = new Schema({ article: ref('Article'), body: { type: String, required: true } });
  let hookArticle;
  commentSchema.pre('save', function changeReference() {
    if (this.body === 'trigger save hook') this.article = hookArticle;
  });
  const Comment = mongoose.model('Comment', commentSchema);
  const graph = new DOGBuilder(mongoose).build();
  const subjectModels = new Set(['User']);
  const writes = createRuleKeeperWriteService({
    model: Comment,
    policyManager,
    operations: writeOperations,
    getContext: () => request.getStore(),
    getDescriptors: model => descriptorsFromLocalDOG(model, inferOwners(graph, model), subjectModels),
    toEntityId: async ({ model, id }, { findById }) => (await findById(model, id))?.entity
  });

  try {
    await mongoose.connect(MONGODB_WRITE_TEST_URI, {
      dbName: `dog_write_test_${randomUUID().replace(/-/g, '')}`,
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000
    });
    await Promise.all([User.init(), Article.init(), Comment.init()]);
    const alice = await User.create({ entity: 'entity-alice' });
    const bob = await User.create({ entity: 'entity-bob' });
    const aliceArticle = await Article.create({ author: alice._id });
    const bobArticle = await Article.create({ author: bob._id });
    hookArticle = bobArticle._id;
    const writeAs = (principal, action, ...args) => request.run(
      { principal, operation: writeOperations[action] }, () => writes[action](...args)
    );
    const denied = { code: 'RULEKEEPER_WRITE_DENIED' };

    const { id } = await writeAs('aliceLogin', 'create', { article: aliceArticle._id, body: 'original' });
    await assert.rejects(writeAs('aliceLogin', 'create', { article: bobArticle._id, body: 'wrong owner' }), denied);
    await assert.rejects(writeAs('clerk', 'create', { article: bobArticle._id, body: 'no consent' }), denied);
    await assert.rejects(writeAs('aliceLogin', 'create', {
      article: new mongoose.Types.ObjectId(), body: 'dangling'
    }), denied);
    assert.equal(await Comment.countDocuments(), 1);

    await assert.rejects(writeAs('bobLogin', 'update', id, { article: bobArticle._id }), denied);
    await assert.rejects(writeAs('aliceLogin', 'update', id, { article: bobArticle._id }), denied);
    await assert.rejects(writeAs('aliceLogin', 'update', id, { body: 'trigger save hook' }), denied);
    await assert.rejects(request.run({ principal: 'aliceLogin', operation },
      () => writes.delete(id)), denied);
    const unchanged = await Comment.findById(id).lean().exec();
    assert.equal(unchanged.body, 'original');
    assert.equal(unchanged.article.toHexString(), aliceArticle._id.toHexString());

    const updated = await writeAs('aliceLogin', 'update', id.toHexString(), { body: 'updated' });
    assert.equal(updated.id.toHexString(), id.toHexString());
    assert.equal((await Comment.findById(id).lean().exec()).body, 'updated');
    await assert.rejects(writeAs('bobLogin', 'delete', id), denied);
    assert.equal(await Comment.countDocuments(), 1);
    const removed = await writeAs('aliceLogin', 'delete', id);
    assert.equal(removed.id.toHexString(), id.toHexString());
    assert.equal(await Comment.countDocuments(), 0);
  } finally {
    try {
      if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  }
});

test('enforces authenticated HTTP routes and atomically rolls back denied batches', {
  skip: OPA_BIN && MONGODB_WRITE_TEST_URI ? false : 'requires OPA_BIN and a replica-set MONGODB_WRITE_TEST_URI'
}, async t => {
  const { createCommentsApp, endpoints } = require('../src/app/comments-app');
  const { Mongoose } = require('mongoose');
  const jwt = require('jsonwebtoken');
  const mongoose = new Mongoose();
  const secret = randomUUID() + randomUUID();
  const policyManager = await loadPolicyManager(t, endpoints);
  const { app, models: { User, Article, Comment } } = createCommentsApp({
    mongoose, policyManager, jwtSecret: secret
  });
  let server;

  try {
    await mongoose.connect(MONGODB_WRITE_TEST_URI, {
      dbName: `dog_http_test_${randomUUID().replace(/-/g, '')}`,
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000
    });
    await Promise.all([User.init(), Article.init(), Comment.init()]);
    const alice = await User.create({ rulekeeperEntity: 'entity-alice' });
    const bob = await User.create({ rulekeeperEntity: 'entity-bob' });
    const aliceArticle = await Article.create({ author: alice._id });
    const bobArticle = await Article.create({ author: bob._id });

    await new Promise((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    const url = `http://127.0.0.1:${server.address().port}/comments`;
    const token = principal => jwt.sign({}, secret, { subject: principal, expiresIn: '5m' });
    const aliceToken = token('aliceLogin');
    const bobToken = token('bobLogin');
    const call = (method, path, body, bearer = aliceToken) => fetch(url + path, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const article = aliceArticle._id.toHexString();
    const otherArticle = bobArticle._id.toHexString();

    assert.equal((await call('POST', '', { article, body: 'forged' }, 'invalid-token')).status, 401);
    const created = await call('POST', '', { article, body: 'single' });
    assert.equal(created.status, 201);
    const { id: single } = await created.json();
    const read = await call('GET', `/${single}`);
    assert.equal(read.status, 200);
    assert.equal((await read.json()).body, 'single');
    assert.equal((await call('GET', `/${single}`, undefined, bobToken)).status, 403);
    assert.equal((await call('PATCH', `/${single}`, { body: 'edited' })).status, 200);
    assert.equal((await call('DELETE', `/${single}`)).status, 204);

    const deniedCreates = await call('POST', '/batch', [
      { article, body: 'would be created' }, { article: otherArticle, body: 'wrong owner' }
    ]);
    assert.equal(deniedCreates.status, 403);
    assert.equal(await Comment.countDocuments(), 0);

    const batch = await call('POST', '/batch', [
      { article, body: 'first' }, { article, body: 'second' }
    ]);
    assert.equal(batch.status, 201);
    const [{ id: first }, { id: second }] = await batch.json();
    const other = await Comment.create({ article: otherArticle, body: 'Bob comment' });
    const otherId = other._id.toHexString();

    const deniedExisting = await call('PATCH', '/batch', [
      { id: first, fields: { body: 'must roll back' } },
      { id: otherId, fields: { body: 'wrong owner' } }
    ]);
    assert.equal(deniedExisting.status, 403);
    const deniedProposed = await call('PATCH', '/batch', [
      { id: first, fields: { body: 'also rolls back' } },
      { id: second, fields: { article: otherArticle } }
    ]);
    assert.equal(deniedProposed.status, 403);
    const firstAfter = await Comment.collection.findOne({ _id: new mongoose.Types.ObjectId(first) });
    const secondAfter = await Comment.collection.findOne({ _id: new mongoose.Types.ObjectId(second) });
    assert.equal(firstAfter.body, 'first');
    assert.equal(secondAfter.article.toHexString(), article);

    const updated = await call('PATCH', '/batch', [
      { id: first, fields: { body: 'updated first' } }, { id: second, fields: { body: 'updated second' } }
    ]);
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).length, 2);
    assert.equal((await Comment.collection.findOne({ _id: new mongoose.Types.ObjectId(first) })).body,
      'updated first');

    assert.equal((await call('DELETE', '/batch', [first, otherId])).status, 403);
    assert.equal((await call('DELETE', '/batch', [first, single])).status, 404);
    assert.equal(await Comment.countDocuments(), 3);
    assert.equal((await call('DELETE', '/batch', [first, second])).status, 204);
    assert.equal(await Comment.countDocuments(), 1);
    assert.ok(await Comment.collection.findOne({ _id: other._id }));
  } finally {
    try {
      if (server) {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
      }
      if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  }
});

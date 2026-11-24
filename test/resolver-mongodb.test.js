'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { annotateOwnership } = require('../src/dog/SchemaAnnotation');
const { DOGBuilder } = require('../src/dog/DOGBuilder');
const { inferOwners } = require('../src/dog/OwnershipInference');
const { resolveOwners } = require('../src/resolver/OwnerResolver');
const { descriptorsFromLocalDOG } = require('../src/resolver/adapters/LocalDOGAdapter');
const { createMongooseLookup } = require('../src/resolver/adapters/MongooseLookup');

// Optional integration test. Put Mongoose 5.x on Node's module path and point
// MONGODB_TEST_URI at a server where this test can create a disposable database.
const uri = process.env.MONGODB_TEST_URI;
test('resolves direct and transitive paths against MongoDB', {
  skip: uri ? false : 'MONGODB_TEST_URI is not set'
}, async () => {
  const { Mongoose, Schema } = require('mongoose');
  const mongoose = new Mongoose();
  const { ObjectId } = Schema.Types;
  const ownershipReference = dataSubject => annotateOwnership(
    { type: ObjectId, ref: dataSubject }, { type: 'OWNED_BY', dataSubject }
  );
  const User = mongoose.model('User', new Schema({ name: String }));
  const Article = mongoose.model('Article', new Schema({ author_id: ownershipReference('User') }));
  const Comment = mongoose.model('Comment', new Schema({ article_id: ownershipReference('Article') }));
  const dbName = `dog_resolver_test_${randomUUID().replace(/-/g, '')}`;

  try {
    await mongoose.connect(uri, {
      dbName,
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000
    });
    const alice = await User.create({ name: 'Alice' });
    const article = await Article.create({ author_id: alice._id });
    const comment = await Comment.create({ article_id: article._id });
    const dangling = await Comment.create({ article_id: new mongoose.Types.ObjectId() });

    const graph = new DOGBuilder(mongoose).build();
    const findById = createMongooseLookup(mongoose.connection);
    const resolve = async (model, id) => resolveOwners({
      model,
      document: await findById(model, id),
      descriptors: descriptorsFromLocalDOG(model, inferOwners(graph, model), new Set(['User'])),
      findById
    });

    for (const result of [await resolve('Article', article._id), await resolve('Comment', comment._id)]) {
      assert.equal(result.status, 'resolved');
      assert.equal(result.subjects.length, 1);
      assert.equal(result.subjects[0].model, 'User');
      assert.equal(result.subjects[0].id.toHexString(), alice._id.toHexString());
    }
    const unresolved = await resolve('Comment', dangling._id);
    assert.equal(unresolved.status, 'unresolved');
    assert.deepEqual(unresolved.subjects, []);
    assert.equal(unresolved.issues[0].code, 'missing_document');
  } finally {
    try {
      if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  }
});

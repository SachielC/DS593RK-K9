'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Graph } = require('../src/dog/Graph');
const { inferOwners } = require('../src/dog/OwnershipInference');
const { descriptorsFromLocalDOG } = require('../src/resolver/adapters/LocalDOGAdapter');
const { createMongooseLookup } = require('../src/resolver/adapters/MongooseLookup');

test('converts local inferred paths with explicit data-subject models', () => {
  const graph = new Graph();
  graph.addEdge({ from: 'Comment', field: 'article_id', to: 'Article', type: 'OWNED_BY' });
  graph.addEdge({ from: 'Article', field: 'author_id', to: 'User', type: 'ACCESSED_BY' });
  const subjectModels = new Set(['User']);
  const descriptors = descriptorsFromLocalDOG('Comment', inferOwners(graph, 'Comment'), subjectModels);
  assert.deepEqual(descriptors, [{
    sourceModel: 'Comment',
    subjectModel: 'User',
    relation: 'ACCESSED_BY',
    hops: [
      { from: 'Comment', field: 'article_id', to: 'Article' },
      { from: 'Article', field: 'author_id', to: 'User' }
    ]
  }]);

  assert.throws(() => descriptorsFromLocalDOG('Comment', [{
    dataSubject: 'User',
    path: ['Comment', 'article_id', 'Article'],
    type: 'OWNED_BY'
  }], subjectModels), /last hop/);
});

test('runs a lean findById on the named model and forwards the caller session', async () => {
  const calls = [];
  const session = {};
  const document = { _id: 'Alice' };
  const lookup = createMongooseLookup({
    model(name) {
      calls.push(['model', name]);
      return {
        findById(id) {
          calls.push(['findById', id]);
          return {
            lean() { calls.push(['lean']); return this; },
            session(value) { calls.push(['session', value]); return this; },
            async exec() { calls.push(['exec']); return document; }
          };
        }
      };
    }
  }, { session });

  assert.strictEqual(await lookup('User', 'Alice'), document);
  assert.deepEqual(calls, [
    ['model', 'User'], ['findById', 'Alice'], ['lean'], ['session', session], ['exec']
  ]);
});

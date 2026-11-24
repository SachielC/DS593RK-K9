'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const express = require('express');
const jwt = require('jsonwebtoken');
const { DOGBuilder } = require('../dog/DOGBuilder');
const { inferOwners } = require('../dog/OwnershipInference');
const { annotateOwnership } = require('../dog/SchemaAnnotation');
const { createRuleKeeperReadMiddleware, createRuleKeeperWriteService } =
  require('../integration/rulekeeper-dog-bridge');
const { descriptorsFromLocalDOG } = require('../resolver/adapters/LocalDOGAdapter');
const { createMongooseLookup } = require('../resolver/adapters/MongooseLookup');

const endpoints = {
  read: 'GET /comments/:id',
  create: 'POST /comments',
  update: 'PATCH /comments/:id',
  delete: 'DELETE /comments/:id',
  createMany: 'POST /comments/batch',
  updateMany: 'PATCH /comments/batch',
  deleteMany: 'DELETE /comments/batch'
};

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function commentFields(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(key => key !== 'article' && key !== 'body')) {
    throw badRequest('Expected comment fields article and body');
  }
  if ('article' in value) objectId(value.article);
  if ('body' in value && typeof value.body !== 'string') throw badRequest('Expected a text body');
  return value;
}

function objectId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) {
    throw badRequest('Expected a MongoDB ObjectId');
  }
  return value.toLowerCase();
}

function batchInput(value, parse, idOf) {
  if (!Array.isArray(value) || value.length === 0) throw badRequest('Expected a nonempty batch array');
  const items = value.map(parse);
  if (idOf && new Set(items.map(idOf)).size !== items.length) {
    throw badRequest('A record may appear only once in a batch');
  }
  return items;
}

/** Register the project-owned comment routes on a fresh Mongoose instance. */
function createCommentsApp({ mongoose, policyManager, jwtSecret }) {
  if (typeof jwtSecret !== 'string' || Buffer.byteLength(jwtSecret) < 32) {
    throw new TypeError('Supply a JWT secret of at least 32 bytes');
  }

  const app = express();
  const request = new AsyncLocalStorage();
  const getContext = () => request.getStore();
  const { Schema } = mongoose;
  const reference = dataSubject => annotateOwnership(
    { type: Schema.Types.ObjectId, ref: dataSubject, required: true },
    { dataSubject, type: 'OWNED_BY' }
  );

  const User = mongoose.model('User', new Schema({ rulekeeperEntity: { type: String, required: true } }));
  const Article = mongoose.model('Article', new Schema({ author: reference('User') }));
  const commentSchema = new Schema({ article: reference('Article'), body: { type: String, required: true } });

  const findById = createMongooseLookup(mongoose.connection);
  const subjectModels = new Set(['User']);
  let graph;
  const getDescriptors = model => descriptorsFromLocalDOG(model, inferOwners(graph, model), subjectModels);
  const toEntityId = async ({ model, id }, lookup) => (await lookup(model, id))?.rulekeeperEntity;
  commentSchema.plugin(createRuleKeeperReadMiddleware({
    policyManager, getContext, getDescriptors, findById,
    toEntityId: subject => toEntityId(subject, findById)
  }));
  const Comment = mongoose.model('Comment', commentSchema);
  graph = new DOGBuilder(mongoose).build();

  const writes = createRuleKeeperWriteService({
    model: Comment, policyManager, operations: endpoints, getContext, getDescriptors,
    toEntityId: (subject, { findById: lookup }) => toEntityId(subject, lookup)
  });

  app.use('/comments', (req, res, next) => {
    const match = /^Bearer (\S+)$/i.exec(req.get('authorization') || '');
    try {
      const claims = jwt.verify(match?.[1] || '', jwtSecret, { algorithms: ['HS256'] });
      if (typeof claims.sub !== 'string' || !claims.sub || !Number.isFinite(claims.exp)) {
        return res.sendStatus(401);
      }
      res.locals.principal = claims.sub;
    } catch {
      return res.sendStatus(401);
    }
    next();
  });
  app.use('/comments', express.json());

  const route = (operation, handler) => (req, res, next) => {
    request.run({ principal: res.locals.principal, operation },
      () => handler(req, res).catch(next));
  };

  // Register exact batch routes before routes containing :id.
  app.post('/comments/batch', route(endpoints.createMany, async (req, res) => {
    const results = await writes.createMany(batchInput(req.body, commentFields));
    res.status(201).json(results);
  }));
  app.patch('/comments/batch', route(endpoints.updateMany, async (req, res) => {
    const entries = batchInput(req.body, entry => ({
      id: objectId(entry?.id), fields: commentFields(entry.fields)
    }), entry => entry.id);
    res.json(await writes.updateMany(entries));
  }));
  app.delete('/comments/batch', route(endpoints.deleteMany, async (req, res) => {
    await writes.deleteMany(batchInput(req.body, objectId, id => id));
    res.sendStatus(204);
  }));

  app.get('/comments/:id', route(endpoints.read, async (req, res) => {
    const comment = await Comment.findById(objectId(req.params.id)).lean().exec();
    if (!comment) return res.sendStatus(404);
    res.json({ id: comment._id, article: comment.article, body: comment.body });
  }));
  app.post('/comments', route(endpoints.create, async (req, res) => {
    res.status(201).json(await writes.create(commentFields(req.body)));
  }));
  app.patch('/comments/:id', route(endpoints.update, async (req, res) => {
    const result = await writes.update(objectId(req.params.id), commentFields(req.body));
    if (!result) return res.sendStatus(404);
    res.json(result);
  }));
  app.delete('/comments/:id', route(endpoints.delete, async (req, res) => {
    const result = await writes.delete(objectId(req.params.id));
    res.sendStatus(result ? 204 : 404);
  }));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || (error.name === 'ValidationError' ? 400
      : error.code === 11000 ? 409 : 500);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
  });
  return { app, models: { User, Article, Comment } };
}

module.exports = { createCommentsApp, endpoints };

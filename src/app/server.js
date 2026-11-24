'use strict';

const { access } = require('node:fs/promises');
const { join } = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { Mongoose } = require('mongoose');
const { createCommentsApp } = require('./comments-app');

async function main() {
  const { MONGODB_URI, JWT_SECRET, RULEKEEPER_READY_PRINCIPAL, PORT = '3000' } = process.env;
  if (!MONGODB_URI || !RULEKEEPER_READY_PRINCIPAL) {
    throw new Error('Set MONGODB_URI and RULEKEEPER_READY_PRINCIPAL');
  }
  const policyDirectory = join(__dirname, '../../rulekeeper/RuleKeeper Middleware/pep');
  await Promise.all(['data.json', 'policies/access_control.wasm', 'policies/rulekeeper.wasm']
    .map(file => access(join(policyDirectory, file))));
  const policyManager = require(join(policyDirectory, 'PolicyManager'));
  const mongoose = new Mongoose();
  const { app, models } = createCommentsApp({ mongoose, policyManager, jwtSecret: JWT_SECRET });
  policyManager.init();

  // The pinned PolicyManager loads asynchronously without returning readiness.
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      if (policyManager.getPrincipalContext(RULEKEEPER_READY_PRINCIPAL)?.entity) break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    if (Date.now() >= deadline) throw new Error('RuleKeeper policy data did not become ready');
    await wait(25);
  }
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await Promise.all(Object.values(models).map(model => model.init()));
  const server = app.listen(Number(PORT), () => console.log(`Listening on port ${server.address().port}`));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

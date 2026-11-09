/**
 * rulekeeper-dog-bridge.js
 * Integration bridge: extends RuleKeeper Middleware with a DOG-aware
 * initialization path (initWithDOG).
 *
 * Usage in Express app.js:
 *
 *   const rulekeeper = require('../../RuleKeeper Middleware');
 *   const { initWithDOG } = require('../../src/integration/rulekeeper-dog-bridge');
 *
 *   // Instead of rulekeeper.init(mongoose):
 *   await initWithDOG(mongoose, rulekeeper, path.join(__dirname, 'gdpr-manifest.json'));
 */

const fs = require('fs');
const path = require('path');
const { DOGBuilder } = require('../dog/DOGBuilder');
const { PolicyTranslator } = require('../dog/PolicyTranslator');

const DERIVED_REGO_PATH = path.join(
  __dirname,
  '../../rulekeeper/RuleKeeper Manager/policies/dog_derived.rego'
);
const DERIVED_SAR_PATH = path.join(
  __dirname,
  '../../rulekeeper/RuleKeeper Manager/policies/dog_sar_policies.json'
);

/**
 * Initialize RuleKeeper with DOG-derived policies layered on top.
 *
 * Steps:
 *  1. Build DOG from annotated Mongoose models
 *  2. Generate Rego rules from DOG
 *  3. Write generated Rego to RuleKeeper Manager's policies directory
 *  4. Generate SAR policies JSON
 *  5. Call standard rulekeeper.init()
 *
 * @param {Object} mongoose    - Mongoose instance (all models registered)
 * @param {Object} rulekeeper  - RuleKeeper middleware module
 * @param {string} manifestPath - Path to GDPR manifest JSON
 */
async function initWithDOG(mongoose, rulekeeper, manifestPath) {
  console.log('[DOG Bridge] Building Data Ownership Graph...');
  const startBuild = Date.now();

  const dogBuilder = new DOGBuilder(mongoose);
  const dog = dogBuilder.build();

  const buildTime = Date.now() - startBuild;
  console.log(`[DOG Bridge] DOG built in ${buildTime}ms. Collections: ${dog.getCollections().join(', ')}`);

  // Translate DOG → Rego + SAR policies
  console.log('[DOG Bridge] Translating DOG to Rego policies...');
  const startTranslate = Date.now();

  const translator = new PolicyTranslator(dog);
  const regoRules = translator.generateAccessControlRego();
  const sarPolicies = translator.generateSARPolicies();

  const translateTime = Date.now() - startTranslate;
  console.log(`[DOG Bridge] Policy translation done in ${translateTime}ms.`);

  // Write Rego to RuleKeeper Manager's policies dir for WASM compilation
  fs.writeFileSync(DERIVED_REGO_PATH, regoRules, 'utf8');
  fs.writeFileSync(DERIVED_SAR_PATH, JSON.stringify(sarPolicies, null, 2), 'utf8');
  console.log(`[DOG Bridge] Wrote derived Rego to ${DERIVED_REGO_PATH}`);

  // Timing metadata for evaluation
  const timings = { buildTime, translateTime };
  const timingsPath = path.join(__dirname, '../../src/evaluation/dog_timings.json');
  fs.writeFileSync(timingsPath, JSON.stringify(timings, null, 2));

  // Standard RuleKeeper initialization
  rulekeeper.init(mongoose);

  return { dog, timings };
}

module.exports = { initWithDOG };

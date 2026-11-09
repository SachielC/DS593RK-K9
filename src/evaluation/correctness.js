/**
 * correctness.js
 * Evaluation harness for correctness measurement:
 * compares DOG-derived policy decisions against manually-written RuleKeeper policies.
 *
 * Metrics:
 *   - Agreement rate: fraction of test cases where both give the same decision
 *   - False allows:   DOG says ALLOW, manual says DENY
 *   - False denies:   DOG says DENY,  manual says ALLOW
 *
 * Run with: node src/evaluation/correctness.js
 */

const fs = require('fs');
const path = require('path');

/** @typedef {{ principal: string, collection: string, operation: string, expected: boolean }} TestCase */

/**
 * Load test cases from a JSON file.
 * Format: array of { principal, collection, operation, manualDecision }
 * @param {string} filePath
 * @returns {TestCase[]}
 */
function loadTestCases(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Run correctness evaluation.
 * @param {TestCase[]}             testCases
 * @param {Function}               manualEval  - (principal, collection, op) => boolean
 * @param {Function}               dogEval     - (principal, collection, op) => boolean
 * @returns {{ agreementRate, falseAllows, falseDenies, total }}
 */
function evaluate(testCases, manualEval, dogEval) {
  let agree = 0, falseAllows = 0, falseDenies = 0;

  for (const tc of testCases) {
    const manual = manualEval(tc.principal, tc.collection, tc.operation);
    const dog    = dogEval(tc.principal, tc.collection, tc.operation);

    if (manual === dog) {
      agree++;
    } else if (dog && !manual) {
      falseAllows++;   // DOG too permissive
    } else {
      falseDenies++;   // DOG too restrictive
    }
  }

  return {
    total:         testCases.length,
    agreementRate: agree / testCases.length,
    falseAllows,
    falseDenies,
  };
}

/**
 * Print a summary table to stdout.
 */
function printResults(results) {
  console.log('\n=== Correctness Evaluation Results ===');
  console.log(`Total test cases : ${results.total}`);
  console.log(`Agreement rate   : ${(results.agreementRate * 100).toFixed(1)}%`);
  console.log(`False allows     : ${results.falseAllows}`);
  console.log(`False denies     : ${results.falseDenies}`);
  const resultsPath = path.join(__dirname, 'correctness_results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${resultsPath}`);
}

module.exports = { loadTestCases, evaluate, printResults };

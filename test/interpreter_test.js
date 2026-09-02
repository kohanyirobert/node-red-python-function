'use strict';
/* The interpreter lookup, and what happens when there is no interpreter at all.
 *
 * This is the check that would have caught the Windows failure. A python.org install lays down
 * `python.exe` and the `py` launcher and NO `python3.exe`, so the node's old hardcoded
 * `spawn('python3')` failed with ENOENT — and because nothing listened for 'error' on the child,
 * that ENOENT was an uncaught exception, which took the whole Node-RED runtime down: every flow,
 * not just this node. Both halves are asserted below, and both are platform-independent, so a
 * POSIX machine tests the Windows failure mode.
 */
const assert = require('assert');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib', 'node-red-python-function.js');

let failures = 0;
function check(name, got, want) {
  if (got === want) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          got  ${JSON.stringify(got)}` +
                `\n          want ${JSON.stringify(want)}`);
    failures++;
  }
}
function checkMatch(name, got, re) {
  if (typeof got === 'string' && re.test(got)) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          got  ${JSON.stringify(got)}` +
                `\n          want match ${re}`);
    failures++;
  }
}

/* A fresh copy of lib/, because the resolved interpreter is cached per module load. */
function loadNode() {
  delete require.cache[require.resolve(LIB)];
  let Ctor = null;
  require(LIB)({
    nodes: {createNode: function () {}, registerType: function (_n, c) { Ctor = c; }},
  });
  return Ctor;
}

function makeNode(Ctor, func) {
  const seen = {errors: [], status: null, handlers: {}};
  const node = {
    on: function (e, fn) { seen.handlers[e] = fn; },
    log: function () {},
    warn: function () {},
    error: function (m) { seen.errors.push(String(m)); },
    status: function (s) { seen.status = s; },
    send: function () {},
    context: function () { return {flow: {get() {}, set() {}}, global: {get() {}, set() {}}}; },
  };
  Ctor.call(node, {name: 'test', func: func || 'return msg'});
  return {node: node, seen: seen};
}

console.log('\nAn interpreter that exists is found');
{
  const {node, seen} = makeNode(loadNode());
  check('a child was spawned', !!node.child, true);
  check('nothing was reported as an error', seen.errors.length, 0);
  checkMatch('the status says it is running', seen.status && seen.status.text, /Running/);
  try { node.child.kill(); } catch (e) { /* already gone */ }
}

console.log('\nNo interpreter: reported on the node, and the runtime survives');
{
  const saved = process.env.NODE_RED_PYTHON;
  process.env.NODE_RED_PYTHON = path.join(__dirname, 'no-such-python-9f3a');
  const {node, seen} = makeNode(loadNode());
  check('no child was spawned', node.child, undefined);
  checkMatch('the failure names the override', seen.errors[0], /NODE_RED_PYTHON/);
  checkMatch('and says it did not run', seen.errors[0], /did not run/);
  checkMatch('the status says so too', seen.status && seen.status.text, /No Python/);

  /* The two paths that used to throw with no child: a message arriving, and the flow stopping.
   * Either one throwing here is an uncaught exception in the real runtime. */
  let threw = null;
  try { seen.handlers.input({payload: 'x', _msgid: 'm1'}); } catch (e) { threw = e.message; }
  check('an inbound message does not throw', threw, null);
  checkMatch('it is reported instead', seen.errors[1], /not running/);
  try { seen.handlers.close(); } catch (e) { threw = e.message; }
  check('stopping the flow does not throw', threw, null);

  if (saved === undefined) { delete process.env.NODE_RED_PYTHON; } else { process.env.NODE_RED_PYTHON = saved; }
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nall checks passed on ${process.platform}`);

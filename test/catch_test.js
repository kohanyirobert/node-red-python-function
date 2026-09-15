'use strict';
/* Can a Catch node see a failure that happened inside Python?
 *
 * Node-RED's contract is not "call node.error". It is `node.error(err, msg)` — the Catch node
 * only fires when the MESSAGE OBJECT is passed as the second argument. One-argument
 * node.error() writes to the debug sidebar and nothing else, so a flow cannot react to it.
 *
 * Both ways Python can fail are checked here:
 *   A. the author calls node.error(...) deliberately
 *   B. the author's code raises, and nobody caught it
 *
 * Before the fix A arrives with no msg (uncatchable) and B kills the interpreter outright.
 */
const assert = require('assert');

const TIMEOUT_MS = 20000;

let Ctor = null;
require('../lib/node-red-python-function.js')({
  nodes: {
    createNode: function () { /* the runtime's own wiring, not needed here */ },
    registerType: function (name, ctor) { Ctor = ctor; },
  },
});
assert.ok(Ctor, 'lib/ did not register a node type');

function contextStore() {
  const store = {};
  return {store: store, get: (k) => store[k], set: (k, v) => {store[k] = v;}};
}

const results = [];
function check(name, got, want) {
  const ok = got === want;
  results.push(ok);
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          got  ${JSON.stringify(got)}` +
                `\n          want ${JSON.stringify(want)}`);
  }
}

/* Build a node instance wired to a stub runtime. `onSettle` fires once the scenario has had
 * its say — either Python sent something back, or it errored, or we ran out of patience. */
function scenario(func, onSettle) {
  const seen = {errors: [], sent: null, exited: false};
  const node = {
    handlers: {},
    on: function (event, fn) { this.handlers[event] = fn; },
    log: function () {},
    warn: function () {},
    /* The whole point: record BOTH arguments, because the second one is the contract. */
    error: function (err, msg) {
      const text = String(err).trim();
      if (/exited with code/.test(text)) seen.exited = true;
      seen.errors.push({text: text, msg: msg});
    },
    status: function () {},
    send: function (msgs) { seen.sent = Array.isArray(msgs) ? msgs[0] : msgs; },
    context: function () { return {flow: contextStore(), global: contextStore()}; },
  };

  Ctor.call(node, {name: 'catch-test', func: func});

  /* Give Python time to start, fail, and be heard. There is no single event that means
   * "the scenario is over", so settle on a timer and inspect whatever arrived. */
  const timer = setTimeout(function () {
    try { node.child.kill(); } catch (e) { /* already gone */ }
    onSettle(seen);
  }, 4000);
  timer.unref && timer.unref();

  node.handlers.input({payload: 'hello', _msgid: 'test-1'});
}

/* A failure is catchable exactly when a msg object rode along with it. */
function catchable(errors) {
  return errors.filter((e) => e.msg && typeof e.msg === 'object');
}

const hardStop = setTimeout(function () {
  console.log('  FAIL  the scenarios never settled');
  process.exit(1);
}, TIMEOUT_MS);

console.log('\nA. node.error() called deliberately from Python');
scenario("node.error('boom')\nreturn msg", function (a) {
  const caught = catchable(a.errors);
  check('the error reached the runtime at all', a.errors.length > 0, true);
  check('it carried the msg, so a Catch node fires', caught.length > 0, true);
  check('and the msg is the one that went in', caught.length > 0 && caught[0].msg._msgid,
        'test-1');

  console.log('\nB. an uncaught Python exception');
  scenario("raise ValueError('kaboom')", function (b) {
    const caught = catchable(b.errors);
    check('the exception was reported', b.errors.length > 0, true);
    check('it carried the msg, so a Catch node fires', caught.length > 0, true);
    check('the traceback names the exception',
          b.errors.some((e) => /kaboom/.test(e.text)), true);
    check('the interpreter stayed up instead of dying', b.exited, false);

    clearTimeout(hardStop);
    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
});

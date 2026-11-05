'use strict';
/* One failure, one entry in the debug sidebar.
 *
 * Every node.error() call is its own entry in the sidebar. The node used to call it once per
 * chunk of stderr, and a pipe delivers a traceback in however many chunks the OS likes, so one
 * Python exception showed up as three entries: "Traceback (most recent call last):", the rest
 * of the traceback, and then "Python Function process exited with code 1".
 *
 * A raise inside the function no longer goes through stderr (it is reported over the channel so
 * a Catch node can take it), but anything that fails outside it still does — such as a return
 * value that cannot be turned into JSON, which kills the interpreter. That is the case driven
 * here, alongside the plain raise and a function that merely writes to stderr and carries on.
 */
const assert = require('assert');

const TIMEOUT_MS = 25000;
/* Comfortably past the node's quiet period for stderr, so every report has been made. */
const SETTLE_MS = 2000;

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
  return {get: (k) => store[k], set: (k, v) => {store[k] = v;}};
}

const results = [];
function check(name, got, want) {
  const ok = got === want;
  results.push(ok);
  console.log(ok ? `  PASS  ${name}`
                 : `  FAIL  ${name}\n          got  ${JSON.stringify(got)}` +
                   `\n          want ${JSON.stringify(want)}`);
}

/* Run one scenario and settle once the first error (or the send) has had time to be followed by
 * any stragglers. Each node.error() call is one sidebar entry, so they are what gets counted. */
function scenario(func, onSettle) {
  const seen = {errors: [], sent: null};
  let timer = null;
  const node = {
    handlers: {},
    on: function (event, fn) { this.handlers[event] = fn; },
    log: function () {},
    warn: function () {},
    error: function (err, msg) {
      seen.errors.push({text: String(err), msg: msg});
      arm();
    },
    status: function () {},
    send: function (msgs) { seen.sent = Array.isArray(msgs) ? msgs[0] : msgs; arm(); },
    context: function () { return {flow: contextStore(), global: contextStore()}; },
  };

  function arm() {
    if (timer) return;
    timer = setTimeout(function () {
      /* Stop the respawned interpreter, if any, before moving on. */
      node.func.attempts = 0;
      try { node.handlers.close(); } catch (e) { /* already gone */ }
      onSettle(seen);
    }, SETTLE_MS);
  }

  Ctor.call(node, {name: 'debug-test', func: func});
  node.handlers.input({payload: 'hello', _msgid: 'test-1'});
}

const hardStop = setTimeout(function () {
  console.log('  FAIL  the scenarios never settled');
  process.exit(1);
}, TIMEOUT_MS);

function done() {
  clearTimeout(hardStop);
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

console.log('\nA. a failure outside the function, which ends the interpreter — one entry');
scenario("return {'payload': {1, 2}}", function (a) {
  check('exactly one error was reported', a.errors.length, 1);
  const text = a.errors.length ? a.errors[0].text : '';
  check('it holds the whole traceback, from the top',
        /^Traceback \(most recent call last\):/.test(text), true);
  check('down to the exception itself', /TypeError: .*not JSON serializable/.test(text), true);
  check('and says the interpreter exited', /exited with code 1/.test(text), true);
  check('nothing to catch: no msg rode along, as before',
        a.errors.length > 0 && a.errors[0].msg, undefined);

  console.log('\nB. a raise in the function — one entry, and still catchable');
  scenario("raise ValueError('kaboom')", function (b) {
    check('exactly one error was reported', b.errors.length, 1);
    check('it names the exception',
          b.errors.length > 0 && /ValueError: kaboom/.test(b.errors[0].text), true);
    check('it carried the msg, so a Catch node fires',
          b.errors.length > 0 && b.errors[0].msg && b.errors[0].msg._msgid, 'test-1');

    console.log('\nC. writing to stderr without failing — reported once, and the msg goes on');
    scenario("import sys\nsys.stderr.write('first line\\n')\nsys.stderr.write('second line\\n')\n" +
             'return msg', function (c) {
      check('the msg was sent', c.sent && c.sent._msgid, 'test-1');
      check('exactly one error was reported', c.errors.length, 1);
      check('holding both lines', c.errors.length > 0 && c.errors[0].text,
            'first line\nsecond line');
      done();
    });
  });
});

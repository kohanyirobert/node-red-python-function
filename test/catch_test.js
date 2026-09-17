'use strict';
/* Does a failure in Python reach a Catch node — and does it do so the same way the built-in
 * Function node does?
 *
 * The built-in node's rules, which this node copies rather than improves on:
 *
 *   node.error("text")        → debug sidebar only. NOT catchable.
 *   node.error("text", msg)   → catchable, because the message rode along.
 *   throw / raise             → catchable. The runtime attaches the message on the author's
 *                               behalf, and the node survives to handle the next message.
 *
 * The third line is the one this node used to get wrong: an escaped exception ended the
 * interpreter instead, so nothing was catchable and every module-level variable was lost.
 */
const assert = require('assert');

const TIMEOUT_MS = 25000;

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
  console.log(ok ? `  PASS  ${name}`
                 : `  FAIL  ${name}\n          got  ${JSON.stringify(got)}` +
                   `\n          want ${JSON.stringify(want)}`);
}

/* Run one scenario against a stub runtime and settle once Python has had its say. */
function scenario(func, onSettle) {
  const seen = {errors: [], sent: null, exited: false};
  const node = {
    handlers: {},
    on: function (event, fn) { this.handlers[event] = fn; },
    log: function () {},
    warn: function () {},
    /* Both arguments are recorded, because the second one is the whole contract. */
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

  const timer = setTimeout(function () {
    try { node.child.kill(); } catch (e) { /* already gone */ }
    onSettle(seen);
  }, 4500);
  timer.unref && timer.unref();

  node.handlers.input({payload: 'hello', _msgid: 'test-1'});
}

/* A failure is catchable exactly when a message object rode along with it. */
function catchable(errors) {
  return errors.filter((e) => e.msg && typeof e.msg === 'object');
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

console.log('\nA. node.error("text") — one argument, like the built-in node: NOT catchable');
scenario("node.error('boom')\nreturn msg", function (a) {
  check('the error was reported', a.errors.length > 0, true);
  check('but no msg rode along, so no Catch node fires', catchable(a.errors).length, 0);

  console.log('\nB. node.error("text", msg) — two arguments: catchable');
  scenario("node.error('boom', msg)\nreturn msg", function (b) {
    const caught = catchable(b.errors);
    check('it carried the msg, so a Catch node fires', caught.length > 0, true);
    check('and the msg is the one that went in',
          caught.length > 0 && caught[0].msg._msgid, 'test-1');

    console.log('\nC. an uncaught exception — catchable, like a thrown error in JavaScript');
    scenario("raise ValueError('kaboom')", function (c) {
      const caught = catchable(c.errors);
      check('it carried the msg, so a Catch node fires', caught.length > 0, true);
      check('the traceback names the exception',
            c.errors.some((e) => /kaboom/.test(e.text)), true);
      check('the interpreter stayed up instead of dying', c.exited, false);

      console.log('\nD. bad data, not an explicit raise — same treatment');
      scenario("msg['payload'].get('nope')\nreturn msg", function (d) {
        check('it carried the msg, so a Catch node fires', catchable(d.errors).length > 0, true);
        check('the traceback names the exception',
              d.errors.some((e) => /AttributeError/.test(e.text)), true);
        check('the interpreter stayed up', d.exited, false);
        done();
      });
    });
  });
});

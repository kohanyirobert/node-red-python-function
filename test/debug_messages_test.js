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
 * here, alongside the plain raise, a function that merely writes to stderr and carries on, one
 * that writes to stderr without pause, and code that cannot even load.
 */
const assert = require('assert');

const TIMEOUT_MS = 60000;
/* Comfortably past the node's longest wait for stderr (3 s for a traceback), so every report has
 * been made. */
const SETTLE_MS = 4000;

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

/* A function that writes to stderr on every message, fed a message every 100 ms for 4 s once its
 * code has loaded. With nothing but a quiet period, none of that would be reported until the
 * messages stopped. */
function streaming(onSettle) {
  const result = {firstAfterMs: Infinity, reports: 0};
  let started = 0;
  const node = {
    handlers: {},
    on: function (event, fn) { this.handlers[event] = fn; },
    log: function () {}, warn: function () {}, status: function () {}, send: function () {},
    error: function () {
      if (result.reports++ === 0) result.firstAfterMs = Date.now() - started;
    },
    context: function () { return {flow: contextStore(), global: contextStore()}; },
  };
  Ctor.call(node, {name: 'stream-test', func: "import sys\nsys.stderr.write('tick\\n')\nreturn msg"});
  /* Start-up is not what is being measured, and on a loaded machine it can take seconds. */
  node.child.on('message', function (m) {
    if (!m || m.ctx !== 'ready') return;
    let n = 0;
    started = Date.now();
    const feed = setInterval(function () {
      node.handlers.input({payload: n, _msgid: `stream-${n++}`});
      if (n === 40) {
        clearInterval(feed);
        node.handlers.close();
        onSettle(result);
      }
    }, 100);
  });
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
    /* The pause makes the two writes two separate chunks, which used to be two entries. */
    scenario("import sys, time\nsys.stderr.write('first line\\n')\ntime.sleep(0.05)\n" +
             "sys.stderr.write('second line\\n')\nreturn msg", function (c) {
      check('the msg was sent', c.sent && c.sent._msgid, 'test-1');
      check('exactly one error was reported', c.errors.length, 1);
      check('holding both lines', c.errors.length > 0 && c.errors[0].text,
            'first line\nsecond line');

      console.log('\nD. stderr that never goes quiet — still reported, within a bounded wait');
      streaming(function (d) {
        /* The cap is 1 s; the rest is room for a slow machine. */
        check('the first report came within 2.5 s of the first input', d.firstAfterMs < 2500, true);
        check('and more followed, rather than one at the very end', d.reports >= 2, true);

        console.log('\nE. code that cannot load — one entry, not one per respawn');
        scenario('x = = 1\nreturn msg', function (e) {
          check('exactly one error was reported', e.errors.length, 1);
          const text = e.errors.length ? e.errors[0].text : '';
          check('it holds the SyntaxError', /SyntaxError/.test(text), true);
          check('and the exit code', /exited with code 1/.test(text), true);
          check('and says to fix it', /Fix it and deploy again/.test(text), true);
          done();
        });
      });
    });
  });
});

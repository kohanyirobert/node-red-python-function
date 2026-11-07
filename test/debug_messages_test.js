'use strict';
/* One failure, one entry in the debug sidebar.
 *
 * Every node.error() call is its own entry in the sidebar. The node used to call it once per
 * chunk of stderr, and a pipe delivers a traceback in however many chunks the OS likes, so one
 * Python exception showed up as three entries: "Traceback (most recent call last):", the rest
 * of the traceback, and then "Python Function process exited with code 1".
 *
 * Python now describes every exception itself, and the entry is what the built-in Function node
 * shows for a thrown error: one line, the exception and where in the author's code it happened
 * (`KeyError: 'missing' (line 3)`). The traceback goes to the log and to the error's stack. It
 * used to be the entry, and the sidebar keeps only the first 1000 characters of one, so a long
 * traceback lost its last line — the one that says what went wrong.
 *
 * Driven here: a return value that cannot be turned into JSON; a plain raise; a raise deep in a
 * call stack; a function that merely writes to stderr and carries on, one that writes to stderr
 * without pause; code that cannot even load; and the crashes Python cannot catch, which restart
 * the interpreter as often as they happen.
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
  const seen = {errors: [], sent: null, logs: []};
  let timer = null;
  const node = {
    handlers: {},
    on: function (event, fn) { this.handlers[event] = fn; },
    log: function (text) { seen.logs.push(String(text)); },
    warn: function () {},
    error: function (err, msg) {
      seen.errors.push({text: String(err), msg: msg, stack: err && err.stack});
      arm();
    },
    status: function () {},
    send: function (msgs) { seen.sent = [].concat(msgs).flat()[0]; arm(); },
    context: function () { return {flow: contextStore(), global: contextStore()}; },
  };

  function arm() {
    if (timer) return;
    timer = setTimeout(function () {
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

/* Feed `steps` one at a time, each once the interpreter is up and the one before has been
 * answered (sent or reported): 'ok' and 'crash' are inputs, 'kill' kills the process from
 * outside, 'exit' is an input that calls sys.exit(). Settles once the last has been answered. */
function sequence(steps, onSettle) {
  const seen = {errors: [], sent: [], status: null};
  const node = {
    handlers: {},
    on: function (event, fn) { this.handlers[event] = fn; },
    log: function () {}, warn: function () {},
    status: function (s) { seen.status = s.text; },
    error: function (err, msg) { seen.errors.push({text: String(err), msg: msg}); },
    send: function (msgs) { seen.sent.push([].concat(msgs).flat()[0]); },
    context: function () { return {flow: contextStore(), global: contextStore()}; },
  };
  Ctor.call(node, {name: 'crash-test', func:
    "import os, sys\nif msg['payload'] == 'crash':\n    os._exit(3)\n" +
    "if msg['payload'] == 'exit':\n    sys.exit(0)\nreturn msg"});
  let answered = 0;
  let step = 0;
  const poll = setInterval(function () {
    if (seen.errors.length + seen.sent.length < answered) return;
    if (!node.child.ready) return;
    if (step === steps.length) {
      clearInterval(poll);
      node.handlers.close();
      onSettle(seen);
      return;
    }
    const what = steps[step++];
    answered = seen.errors.length + seen.sent.length + 1;
    if (what === 'kill') {
      node.child.kill('SIGKILL');
    } else {
      node.handlers.input({payload: what, _msgid: `seq-${step}`});
    }
  }, 20);
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

console.log('\nA. a return value JSON cannot hold — an error like a raise, not a crash');
/* A date, a set or bytes are converted (see compat_test.js); an arbitrary object cannot be. */
scenario("return {'payload': object()}", function (a) {
  check('exactly one error was reported', a.errors.length, 1);
  const text = a.errors.length ? a.errors[0].text : '';
  check('the entry is the exception and the data it failed on — nothing else', text,
        "TypeError: Object of type object is not JSON serializable\n" +
        "when serializing dict item 'payload'");
  /* An Error, not a string: the sidebar then shows it as it shows a JavaScript error. */
  check('it is an error whose stack is the traceback',
        a.errors.length > 0 && /^Traceback[^]*TypeError/.test(a.errors[0].stack), true);
  check('the whole traceback went to the log',
        a.logs.some((l) => /^Traceback/.test(l) && /TypeError/.test(l)), true);
  check('it carried the msg, so a Catch node fires',
        a.errors.length > 0 && a.errors[0].msg && a.errors[0].msg._msgid, 'test-1');

  console.log('\nB. a raise in the function — one entry, and still catchable');
  scenario("raise ValueError('kaboom')", function (b) {
    check('exactly one error was reported', b.errors.length, 1);
    check('it is the exception and its line',
          b.errors.length > 0 && b.errors[0].text, 'ValueError: kaboom (line 1)');
    check('it carried the msg, so a Catch node fires',
          b.errors.length > 0 && b.errors[0].msg && b.errors[0].msg._msgid, 'test-1');
    check('and the traceback rides along as its stack, for the Catch node',
          b.errors.length > 0 && /^Traceback[^]*ValueError: kaboom$/.test(b.errors[0].stack), true);

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
          /* The test's message, sent before the code failed, is told the node is not running. */
          check('the SyntaxError was reported once',
                e.errors.filter((x) => /SyntaxError/.test(x.text)).length, 1);
          check('it is the SyntaxError, where it is, the exit, and what to do',
                e.errors.length > 0 && e.errors[0].text,
                'SyntaxError: invalid syntax (line 1, col 5)\n\n' +
                "Python Function process exited with code 1\n\n" +
                "Function 'debug-test' could not start. Fix it and deploy again");
          check('as an error whose stack is the SyntaxError',
                e.errors.length > 0 && /File "Function node", line 1[^]*SyntaxError/.test(
                  e.errors[0].stack), true);

          console.log('\nF. a raise from deep in a call stack — one short entry, own line numbers');
          /* Two functions in turn: Python folds a frame repeated in a row into one
           * "[Previous line repeated ...]" line, which would keep the traceback short. */
          scenario('def down(n):\n    if n == 0:\n        raise KeyError("missing")\n' +
                   '    return across(n - 1)\ndef across(n):\n    return down(n)\n' +
                   'return down(40)', function (f) {
            check('exactly one error was reported', f.errors.length, 1);
            check('it is the exception and the line in the editor that raised it',
                  f.errors.length > 0 && f.errors[0].text, "KeyError: 'missing' (line 3)");
            check('it carried the msg, so a Catch node fires',
                  f.errors.length > 0 && f.errors[0].msg && f.errors[0].msg._msgid, 'test-1');
            const stack = f.errors.length ? String(f.errors[0].stack) : '';
            check('the stack names the author\'s lines, not the wrapper script\'s',
                  /File "Function node", line 3, in down\n {4}raise KeyError/.test(stack) &&
                  !/File "<string>"/.test(stack), true);

            console.log('\nG. FORCE_COLOR in the environment — no escape codes anywhere');
            /* NO_COLOR wins over FORCE_COLOR, so a shell that sets it would hide the bug. */
            const noColor = process.env.NO_COLOR;
            delete process.env.NO_COLOR;
            process.env.FORCE_COLOR = '1';
            scenario('if True:\nprint(1)\nreturn msg', function (g) {
              delete process.env.FORCE_COLOR;
              if (noColor !== undefined) process.env.NO_COLOR = noColor;
              const text = g.errors.length ? g.errors[0].text : '';
              check('it is the IndentationError, at line 2 of the code',
                    text.split('\n')[0],
                    "IndentationError: expected an indented block after 'if' statement on line 1" +
                    ' (line 2, col 1)');
              check('without ANSI escape codes, in the entry or the log',
                    /\u001b\[/.test(text + g.logs.join('')), false);
              console.log('\nH. crashes Python cannot catch — reported, and restarted every time');
              const crashes = Array(12).fill('crash');
              sequence(crashes.concat(['kill', 'exit', 'ok']), function (h) {
                const texts = h.errors.map((e) => e.text);
                check('each of 12 crashes in a row was one entry, and each restarted',
                      texts.slice(0, 12).every((t) =>
                        t === 'Python Function process exited with code 3, and was restarted'), true);
                check('a kill from outside is reported and restarted too', texts[12],
                      'Python Function process was killed (SIGKILL), and was restarted');
                check('sys.exit() is an error, not a silent exit', texts[13], 'SystemExit: 0 (line 5)');
                check('nothing else was reported', texts.length, 14);
                check('and the node never stopped: the last message went through',
                      h.sent.length === 1 && h.sent[0].payload, 'ok');
                check('its status still says running', h.status, 'Running');
                done();
              });
            });
          });
        });
      });
    });
  });
});

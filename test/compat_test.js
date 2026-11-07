'use strict';
/* Does the Python node do what the built-in JavaScript Function node does, where a flow can
 * tell the difference?
 *
 *   done()       a Complete node fires for every message, and a failure goes through done(err)
 *   values       a date, a set and bytes go out as the JavaScript node would send them; a Buffer
 *                comes in as bytes
 *   req / res    each message gets back its own live http request and response, even with two
 *                in flight, and messages sharing a _msgid stay apart
 *   API          env.get, node.id / name / path / outputCount, On Start and On Stop
 *   timeout      a message that runs too long fails as a JavaScript one does
 *   crashes      the message Python was on gets the crash; the ones behind it still go through
 *   wording      a non-message return is reported in the JavaScript node's words
 */
const assert = require('assert');

const TIMEOUT_MS = 90000;

let Ctor = null;
require('../lib/node-red-python-function.js')({
  nodes: {
    createNode: function () { /* the runtime's own wiring, not needed here */ },
    registerType: function (name, ctor) { Ctor = ctor; },
  },
  util: {getSetting: function (node, name) { return `env:${name}`; }},
  settings: {},
});
assert.ok(Ctor, 'lib/ did not register a node type');

const results = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(ok ? `  PASS  ${name}`
                 : `  FAIL  ${name}\n          got  ${JSON.stringify(got)}` +
                   `\n          want ${JSON.stringify(want)}`);
}

function contextStore() {
  const store = {};
  return {get: (k) => store[k], set: (k, v) => {store[k] = v;}};
}

/* Start a node, feed it `inputs` once its code has loaded (all at once, so they queue), and
 * settle when every input has had done() called, or after `waitMs`. Then stop it the way the
 * runtime does, and wait for that too. */
function run(config, inputs, onSettle, waitMs) {
  const seen = {sent: [], done: [], errors: [], warns: [], closed: false};
  const node = {
    handlers: {},
    on: function (event, fn) { this.handlers[event] = fn; },
    log: function () {},
    warn: function (text) { seen.warns.push(String(text)); },
    error: function (err) { seen.errors.push(String(err)); },
    status: function () {},
    send: function () { throw new Error('sends must go through the send() the runtime passed'); },
    context: function () { return {flow: contextStore(), global: contextStore()}; },
  };
  Ctor.call(node, Object.assign({id: 'n1', name: 'compat', outputs: 1}, config));
  const finishAt = Date.now() + (waitMs || 8000);
  const start = setInterval(function () {
    if (!node.child.ready) return;
    clearInterval(start);
    inputs.forEach(function (msg, i) {
      node.handlers.input(msg,
        function (msgs) { seen.sent.push({input: i, msgs: msgs}); },
        function (err) { seen.done.push({input: i, err: err === undefined ? null : String(err)}); });
    });
    const settle = setInterval(function () {
      if (seen.done.length < inputs.length && Date.now() < finishAt) return;
      clearInterval(settle);
      node.handlers.close(false, function () {
        seen.closed = true;
        onSettle(seen, inputs);
      });
    }, 20);
  }, 20);
}

/* The first message of each send() call, in the order they were sent. */
function firsts(seen) {
  return seen.sent.map((s) => [].concat(s.msgs).flat()[0]);
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

const scenarios = [];
function scenario(title, fn) { scenarios.push({title, fn}); }
function next() {
  const s = scenarios.shift();
  if (!s) return done();
  console.log(`\n${s.title}`);
  s.fn(next);
}

scenario('A. done(): once per message, with the error when it failed', function (then) {
  run({func: "if msg['payload'] == 'raise':\n    raise ValueError('no')\n" +
              "if msg['payload'] == 'none':\n    return None\nreturn msg"},
      [{payload: 'ok', _msgid: 'a'}, {payload: 'raise', _msgid: 'b'}, {payload: 'none', _msgid: 'c'}],
      function (seen) {
        check('every message was done exactly once, in order', seen.done.map((d) => d.input), [0, 1, 2]);
        check('the one that returned is done without an error', seen.done[0].err, null);
        check('the one that raised is done with it, so the runtime hands it to a Catch node',
              seen.done[1].err, 'ValueError: no (line 2)');
        check('returning None is done too, with nothing sent',
              [seen.done[2].err, seen.sent.filter((s) => s.input === 2).length], [null, 0]);
        then();
      });
});

scenario('B. values JSON cannot hold, both ways', function (then) {
  run({func: "import datetime\nreturn {'payload': [datetime.datetime(1970, 1, 1, 12, 30),\n" +
              "    datetime.date(2026, 11, 7), sorted({2, 1}), {3}, b'hi',\n" +
              "    type(msg['payload']).__name__, msg['payload'].decode()]}"},
      [{payload: Buffer.from('yo'), _msgid: 'b'}],
      function (seen) {
        const out = firsts(seen)[0].payload;
        check('a datetime goes out as its ISO string, as a JavaScript Date does in JSON',
              out[0], '1970-01-01T12:30:00');
        check('a date too', out[1], '2026-11-07');
        check('a set goes out as a list', [out[2], out[3]], [[1, 2], [3]]);
        check('bytes go out as a Buffer', Buffer.isBuffer(out[4]) && out[4].toString(), 'hi');
        check('a Buffer comes in as bytes', [out[5], out[6]], ['bytes', 'yo']);
        then();
      });
});

scenario('C. each message gets its own live req/res back, with two in flight', function (then) {
  const req1 = {id: 1, headers: {a: '1'}};
  const req2 = {id: 2, headers: {a: '2'}};
  const res1 = {id: 'r1'};
  const res2 = {id: 'r2'};
  run({func: "import time\ntime.sleep(0.2)\nreturn {'payload': msg['req']['headers']['a'],\n" +
              "        'req': msg['req'], 'res': msg['res']}"},
      [{payload: 1, req: req1, res: res1, _msgid: 'same'}, {payload: 2, req: req2, res: res2, _msgid: 'same'}],
      function (seen) {
        const out = firsts(seen);
        check('both answered, though they share a _msgid', out.map((m) => m.payload), ['1', '2']);
        check('the first got its own request and response back, the live objects',
              out[0].req === req1 && out[0].res === res1, true);
        check('and so did the second', out[1].req === req2 && out[1].res === res2, true);
        check('the outputs carry the _msgid they came in with', out.map((m) => m._msgid), ['same', 'same']);
        then();
      });
});

scenario('D. env.get and node.id / name / path / outputCount', function (then) {
  run({id: 'abc', name: 'who', outputs: 2,
       func: "return {'payload': [env.get('FOO'), node.id, node.name, node.path, node.outputCount]}"},
      [{payload: 0, _msgid: 'd'}],
      function (seen) {
        check('as the JavaScript node has them', firsts(seen)[0].payload,
              ['env:FOO', 'abc', 'who', 'abc', 2]);
        then();
      });
});

scenario('E. On Start runs once before the first message; On Stop when the node stops', function (then) {
  run({initialize: "import math\ncounter = [0]\nnode.warn('started')",
       func: "counter[0] += 1\nreturn {'payload': [counter[0], math.floor(math.pi)]}",
       finalize: "node.warn('stopped after %d' % counter[0])"},
      [{payload: 0, _msgid: 'e1'}, {payload: 0, _msgid: 'e2'}],
      function (seen) {
        check('its imports and variables are there for the function',
              firsts(seen).map((m) => m.payload), [[1, 3], [2, 3]]);
        check('On Start ran once, and On Stop ran before the node finished closing',
              [seen.warns, seen.closed], [['started', 'stopped after 2'], true]);
        then();
      });
});

/* The code never loads, so run() would wait for nothing: watch the reports instead. */
scenario('F. an error in On Start says where, and the node does not start', function (then) {
  const errors = [];
  const node = {
    handlers: {}, on: function (e, fn) { this.handlers[e] = fn; },
    log: function () {}, warn: function () {}, status: function () {}, send: function () {},
    error: function (err) { errors.push(String(err)); },
    context: function () { return {flow: contextStore(), global: contextStore()}; },
  };
  Ctor.call(node, {id: 'f', name: 'setup', initialize: "x = 1\nraise ValueError('bad setup')", func: 'return msg'});
  node.child.on('close', function () {
    setTimeout(function () {
      check('one entry, naming On Start and its line',
            errors, ["ValueError: bad setup (On Start, line 2)\n\nPython Function process exited with code 1" +
                     "\n\nFunction 'setup' could not start. Fix it and deploy again"]);
      then();
    }, 50);
  });
});

scenario('G. a message that runs past the timeout fails as a JavaScript one does', function (then) {
  run({timeout: 1, func: "import time\nif msg['payload'] == 'slow':\n    time.sleep(10)\nreturn msg"},
      [{payload: 'slow', _msgid: 'g1'}, {payload: 'fast', _msgid: 'g2'}],
      function (seen) {
        check('the slow one is done with the timeout',
              seen.done.find((d) => d.input === 0).err, 'Script execution timed out after 1000ms');
        check('the one behind it still went through, on a fresh interpreter',
              [seen.done.find((d) => d.input === 1).err, firsts(seen).map((m) => m.payload)], [null, ['fast']]);
        check('nothing else was reported', seen.errors, []);
        then();
      });
});

scenario('H. a crash fails the message it happened on, and the queue behind it goes on', function (then) {
  run({func: "import os\nif msg['payload'] == 'crash':\n    os._exit(3)\nreturn msg"},
      [{payload: 'crash', _msgid: 'h1'}, {payload: 'after', _msgid: 'h2'}],
      function (seen) {
        check('the crashing message is done with the crash',
              seen.done.find((d) => d.input === 0).err,
              'Python Function process exited with code 3, and was restarted');
        check('the one queued behind it was answered by the fresh interpreter',
              [seen.done.find((d) => d.input === 1).err, firsts(seen).map((m) => m.payload)], [null, ['after']]);
        then();
      });
});

scenario('I. returning something that is not a message, in the JavaScript node\'s words', function (then) {
  run({func: 'return 5'}, [{payload: 0, _msgid: 'i'}], function (seen) {
    check('reported, nothing sent, and still done',
          [seen.errors, seen.sent.length, seen.done[0].err],
          [['Function tried to send a message of type number'], 0, null]);
    then();
  });
});

scenario('J. what holds the message afterwards (Complete, Catch) sees what the function did to it', function (then) {
  run({func: "msg['payload'] = 42\nmsg['added'] = True\ndel msg['gone']\n" +
              "if msg['keep'] == 'raise':\n    raise ValueError('after changing it')\n" +
              "return {'payload': 'something else'}"},
      [{payload: 'in', gone: 1, keep: 'k', _msgid: 'j1'}, {payload: 'in', gone: 1, keep: 'raise', _msgid: 'j2'}],
      function (seen, inputs) {
        const strip = (m) => ({payload: m.payload, added: m.added, gone: m.gone, keep: m.keep, _msgid: m._msgid});
        check('the message that came in now holds the changes', strip(inputs[0]),
              {payload: 42, added: true, gone: undefined, keep: 'k', _msgid: 'j1'});
        check('while what was returned went out as returned', firsts(seen).map((m) => m.payload),
              ['something else']);
        check('and a message that failed holds the changes made before the error', strip(inputs[1]),
              {payload: 42, added: true, gone: undefined, keep: 'raise', _msgid: 'j2'});
        then();
      });
});

next();

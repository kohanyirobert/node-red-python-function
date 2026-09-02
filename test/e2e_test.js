'use strict';
/* Drive the node itself against a stub Node-RED, with no Node-RED installed.
 *
 * This is the check the project did not have. It loads lib/, hands it an input message and
 * speaks the runtime's side of the protocol back, so it exercises the real spawn options and
 * BOTH directions of the IPC channel on whatever platform it runs on: a message in, `node.log`
 * and the returned msg out, and a `flow.set` / `flow.get` round trip, which is the path where
 * Python blocks waiting for an answer.
 *
 * On Windows this fails before the IPC framing fix and passes after it. On POSIX it must pass
 * either way. Run it on both.
 */
const assert = require('assert');

const TIMEOUT_MS = 15000;

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

const flowCtx = contextStore();
const globalCtx = contextStore();
const seen = {log: null, sent: null, spawnError: null};
const failures = [];

const node = {
  handlers: {},
  on: function (event, fn) { this.handlers[event] = fn; },
  log: function (msg) { seen.log = String(msg); },
  warn: function () {},
  error: function (msg) { failures.push(`node.error: ${String(msg).trim()}`); },
  status: function () {},
  send: function (msgs) { seen.sent = Array.isArray(msgs) ? msgs[0] : msgs; finish(); },
  context: function () { return {flow: flowCtx, global: globalCtx}; },
};

const USER_FUNC = [
  "node.log('python is running')",
  "flow.set('counter', 41)",
  "msg['seen'] = flow.get('counter') + 1",
  'return msg',
].join('\n');

Ctor.call(node, {name: 'test', func: USER_FUNC});

// A spawn failure surfaces clearly rather than as a timeout. The node resolves its interpreter
// now (python3, then python, then `py -3` on Windows), so this should not fire; if it does, the
// message says which command failed rather than leaving a 15-second silence.
node.child.on('error', function (err) {
  seen.spawnError = err.code || err.message;
  finish();
});

const timer = setTimeout(function () {
  failures.push(`no result within ${TIMEOUT_MS}ms — the channel is not being read, or what came ` +
                'back could not be parsed. This is what the Windows framing bug looks like.');
  finish();
}, TIMEOUT_MS);

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try { node.child.kill(); } catch (e) { /* already gone */ }

  if (seen.spawnError) {
    console.log(`  FAIL  the interpreter could not be spawned: ${seen.spawnError}`);
    console.log('        Install Python 3, or set NODE_RED_PYTHON to the full path of one.');
    process.exit(1);
  }

  check('Python logged back through the channel', seen.log, 'python is running');
  check('flow.set reached the runtime side', flowCtx.store.counter, 41);
  check('flow.get was answered, so Python unblocked', seen.sent && seen.sent.seen, 42);
  check('the payload survived the round trip', seen.sent && seen.sent.payload, 'hello');
  check('the msgid was restored on the way out', seen.sent && seen.sent._msgid, 'test-1');

  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log(`\nall checks passed on ${process.platform}`);
  process.exit(0);
}

function check(name, got, want) {
  if (got === want) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          got  ${JSON.stringify(got)}` +
                `\n          want ${JSON.stringify(want)}`);
    failures.push(name);
  }
}

node.handlers.input({payload: 'hello', _msgid: 'test-1'});

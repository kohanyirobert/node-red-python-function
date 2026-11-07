/*
 * py-function — a Python Function node for Node-RED with flow/global context.
 *
 * A fork of node-red-contrib-python-function 0.0.5 by Arnau Orriols (MIT), which is unmaintained
 * upstream. Three changes, each one a bug we hit while verifying it for a beginners' course:
 *
 *   1. `flow` and `global_ctx` now exist inside the Python function. Upstream defines only `node`,
 *      so `flow.get(...)` raised NameError and the process died. They are implemented as a
 *      request/reply over the same IPC channel the node already uses.
 *
 *   2. `msg.payload` no longer disappears behind an `http in` node. Upstream's circular-reference
 *      stripper discarded *any* object it had already seen rather than only true cycles, and for an
 *      HTTP request `msg.payload` and `msg.req.body` are the same object — so whichever came second
 *      was silently dropped. Replaced with an ancestor check, which removes cycles and keeps shared
 *      references.
 *
 *   3. The interpreter is looked up rather than hardcoded. Upstream ran `python`, which is
 *      frequently absent on a current Linux distribution; `python3` alone is just as wrong on
 *      Windows, where a python.org install gives `python.exe` and the `py` launcher and no
 *      `python3.exe`. And a failed spawn now reports instead of killing the runtime: an
 *      unhandled 'error' on the child is an uncaught exception, which took all of Node-RED down.
 *
 * `global` is a reserved word in Python, so the global scope is exposed as `global_ctx`.
 */
module.exports = function (RED) {
  var spawn = require('child_process').spawn;
  var spawnSync = require('child_process').spawnSync;

  /* Which interpreter to run.
   *
   * `python3` alone is wrong on Windows: the installer from python.org lays down `python.exe` and
   * the `py` launcher and NO `python3.exe`, so `spawn('python3')` fails with ENOENT on a normal
   * Windows install. `python` alone is wrong on Linux, where it is frequently absent. So try the
   * candidates in turn and keep the first that answers `-V`, with an env override for anyone
   * whose interpreter is somewhere else entirely.
   *
   * Resolved once per runtime, not per node: it cannot change while Node-RED is up. */
  var PYTHON = null;

  function runs(cmd, args) {
    var probe = spawnSync(cmd, args.concat(['-V']), {stdio: 'ignore', windowsHide: true});
    return !probe.error && probe.status === 0;
  }

  /* Returns {cmd, args} or {error} — never null, so every caller has something to report. */
  function resolvePython() {
    if (PYTHON) {
      return PYTHON;
    }
    /* An explicit override is authoritative. Falling back when it does not run would hide the
     * one thing the person setting it wants to know. */
    if (process.env.NODE_RED_PYTHON) {
      var given = process.env.NODE_RED_PYTHON;
      if (runs(given, [])) {
        PYTHON = {cmd: given, args: []};
        return PYTHON;
      }
      return {error: `NODE_RED_PYTHON is set to '${given}', which did not run`};
    }
    var candidates = process.platform === 'win32'
      /* `python` before `py`: the launcher is a shim, and a bare `python.exe` on PATH is what an
       * "Add python.exe to PATH" install gives. Windows also ships a `python` stub that opens the
       * Microsoft Store; it exits non-zero on `-V`, so `runs` rejects it. */
      ? [{cmd: 'python3', args: []}, {cmd: 'python', args: []}, {cmd: 'py', args: ['-3']}]
      : [{cmd: 'python3', args: []}, {cmd: 'python', args: []}];
    for (var i = 0; i < candidates.length; i++) {
      if (runs(candidates[i].cmd, candidates[i].args)) {
        PYTHON = candidates[i];
        return PYTHON;
      }
    }
    var tried = candidates.map((c) => [c.cmd].concat(c.args).join(' ')).join(', ');
    return {error: `no Python found. Tried: ${tried}. Install Python 3, or set ` +
                   'NODE_RED_PYTHON to the full path of an interpreter'};
  }

  /* Serialise msg, dropping only genuine cycles.
   *
   * The upstream version pushed every object into one flat list and dropped any repeat, which
   * silently deletes shared references — the cause of the vanishing payload. Tracking the current
   * ancestor chain instead removes exactly what JSON cannot represent and nothing else. */
  function safeStringify(obj) {
    var ancestors = [];
    return JSON.stringify(obj, function (key, value) {
      if (typeof value !== 'object' || value === null) {
        return value;
      }
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop();
      }
      if (ancestors.indexOf(value) !== -1) {
        return undefined;
      }
      ancestors.push(value);
      return value;
    });
  }

  function scopeFor(self, name) {
    return name === 'global' ? self.context().global : self.context().flow;
  }

  /* How long stderr must stay quiet before what it wrote is reported. Long enough to join the
   * pieces of one traceback. A function that writes to stderr without pause (logging.warning on
   * every message, say) would never go quiet, so nothing waits longer than the max wait or piles
   * up much past STDERR_MAX_CHARS.
   *
   * A traceback is usually the last thing a dying process writes, and its exit belongs in the same
   * entry; on a loaded machine (a Raspberry Pi, say) the exit can come well after 200 ms. So
   * stderr that looks like a traceback is held longer. The exit reports whatever is pending at
   * once, so a crash is reported as soon as it happens either way. */
  var STDERR_QUIET_MS = 200;
  var STDERR_MAX_WAIT_MS = 1000;
  var STDERR_TRACEBACK_QUIET_MS = 2000;
  var STDERR_TRACEBACK_MAX_WAIT_MS = 3000;
  var STDERR_MAX_CHARS = 64 * 1024;
  /* Python's own report of an uncaught exception, or of code that would not compile. */
  var TRACEBACK = /^Traceback \(most recent call last\):|^ {2}File "<string>", line \d+/m;

  /* A failure as Python describes it: {name, message, traceback}. The debug sidebar gets what
   * the built-in Function node gives it for a thrown error — one line, `KeyError: 'nope' (line
   * 3)` — and the traceback goes to the Node-RED log and, as the error's stack, to a Catch node.
   * The whole traceback used to be the entry, and the sidebar keeps only its first 1000
   * characters: a long one lost its last line, the one that says what went wrong. */
  function pythonError(self, failure) {
    var err = new Error(failure.message);
    err.name = failure.name;
    err.stack = failure.traceback;
    self.log(failure.traceback);
    return err;
  }

  function spawnFn(self) {
    var python = resolvePython();
    if (python.error) {
      self.stopped = true;
      self.error(`Cannot start Python: ${python.error}`);
      self.status({fill: 'red', shape: 'dot', text: 'No Python found'});
      return;
    }
    /* The author's code and the node's identity go in as one argument; see CONFIG in the script. */
    self.child = spawn(python.cmd, python.args.concat(['-uc', self.func.code, self.func.config]), {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      /* Python 3.13+ colours its tracebacks when FORCE_COLOR is set, even into a pipe, and the
       * sidebar shows the escape codes as text. */
      env: Object.assign({}, process.env, {PYTHON_COLORS: '0'}),
    });
    /* Without this the runtime dies. A failed spawn emits 'error' on the child, and an
     * unhandled 'error' is an uncaught exception, which takes Node-RED down with it — the whole
     * runtime, every flow, not just this node. That is what `spawn python3 ENOENT` did on
     * Windows. */
    self.child.on('error', function (err) {
      /* 'close' follows with a negative code; this entry already says what happened. */
      self.child.spawnFailed = true;
      self.stopped = true;
      self.error(`Could not run ${python.cmd}: ${err.message}`);
      self.status({fill: 'red', shape: 'dot', text: 'Python failed to start'});
    });
    self.child.stdout.on('data', function (data) {
      self.log(data.toString());
    });
    /* One failure, one entry in the debug sidebar.
     *
     * A pipe has no notion of a message: a traceback reaches 'data' in however many chunks the
     * OS happened to deliver it in, and Python with -u writes it a line or two at a time. Calling
     * node.error per chunk put one traceback across several sidebar entries, and the
     * "exited with code" that follows a crash was yet another. So stderr is collected until it
     * goes quiet, and if the process then ends, the exit is reported in the same entry. The
     * state is kept on the child so the node's close handler can stop a pending report. */
    var child = self.child;
    child.stderrText = '';
    child.stderrTimer = null;
    child.stderrSince = 0;
    /* Set by the node's close handler: anything the child writes while dying is dropped. */
    child.dropStderr = false;
    /* Set when Python reports that its code loaded; see the 'close' handler. */
    child.ready = false;
    function takeStderr() {
      clearTimeout(child.stderrTimer);
      child.stderrTimer = null;
      var text = child.dropStderr ? '' : child.stderrText.replace(/\s+$/, '');
      child.stderrText = '';
      return text;
    }
    function flushStderr() {
      var text = takeStderr();
      if (text) {
        self.error(text);
      }
    }
    child.stderr.setEncoding('utf8');  /* a multi-byte character split across chunks survives */
    child.stderr.on('data', function (data) {
      if (child.dropStderr) {
        return;
      }
      var now = Date.now();
      if (!child.stderrText) {
        child.stderrSince = now;
      }
      child.stderrText += data;
      clearTimeout(child.stderrTimer);
      if (child.stderrText.length >= STDERR_MAX_CHARS) {
        flushStderr();
        return;
      }
      var crash = TRACEBACK.test(child.stderrText);
      var quiet = crash ? STDERR_TRACEBACK_QUIET_MS : STDERR_QUIET_MS;
      var left = (crash ? STDERR_TRACEBACK_MAX_WAIT_MS : STDERR_MAX_WAIT_MS) -
                 (now - child.stderrSince);
      child.stderrTimer = setTimeout(flushStderr, Math.max(0, Math.min(quiet, left)));
    });
    child.on('close', function (exitCode, signal) {
      var text = takeStderr();
      /* spawnFailed: the 'error' handler reported it. dropStderr: the node stopped it. */
      if (child.spawnFailed || child.dropStderr) {
        return;
      }
      /* The node killed it: the message it was on ran past the timeout. As in the JavaScript
       * node, that message fails with the timeout; the ones behind it go to a fresh process. */
      if (child.timedOut !== undefined) {
        if (text) {
          self.error(text);
        }
        var late = self.inflight.get(child.timedOut);
        self.inflight.delete(child.timedOut);
        if (late) {
          late.done(`Script execution timed out after ${self.timeoutMs}ms`);
        }
        restart(self);
        return;
      }
      /* Any other end is a crash. Everything a function can do wrong is reported as an error
       * and the process carries on, so what is left is what Python cannot catch: os._exit(),
       * a crash inside a C extension, or something outside killing it. A crash Python described
       * is an Error like any other failure, with the exit in its message; anything the function
       * wrote to stderr before it is not part of it and goes first. Without a description,
       * stderr is the entry. */
      var crash = child.crash;
      if (crash && text) {
        self.error(text);
      }
      var tail = 'Python Function process ' +
                 (signal ? `was killed (${signal})` : `exited with code ${exitCode}`);
      /* A child that died before its code finished loading failed on that code — a
       * SyntaxError, say — and an identical respawn can only fail the same way. Otherwise it
       * is restarted, every time: a fresh process only waits for the next message, so it cannot
       * crash again on its own, and a counter that gave up after ten would only stop a node
       * whose mistakes come one per message. */
      tail += child.ready ? ', and was restarted'
                          : `\n\nFunction '${self.name}' could not start. Fix it and deploy again`;
      if (crash) {
        crash.message += `\n\n${tail}`;
      }
      var report = crash || (text ? `${text}\n\n` : '') + tail;
      if (!child.ready) {
        self.stopped = true;
        self.error(report);
        self.status({fill: 'red', shape: 'dot', text: 'Stopped, see debug panel'});
        self.inflight.forEach(function (entry) {
          entry.done(notRunning(self));
        });
        self.inflight.clear();
        return;
      }
      /* Python takes one message at a time, in order, so the crash happened on the oldest one
       * not yet answered: it fails with the crash, which a Catch node can then take. */
      var head = self.inflight.keys().next();
      if (head.done) {
        self.error(report);
      } else {
        var culprit = self.inflight.get(head.value);
        self.inflight.delete(head.value);
        culprit.done(report);
      }
      restart(self);
    });
    self.child.on('message', function (response) {
      switch (response.ctx) {
        case 'ready':
          child.ready = true;
          break;
        /* node.send() during the function's turn. */
        case 'send':
          sendResults(self, self.inflight.get(response.msgid), response.value);
          break;
        /* What the function returned, and the end of its turn: done() goes to the runtime, so
         * a Complete node fires, exactly as for the JavaScript node. */
        case 'result': {
          var entry = finish(self, response.msgid);
          var r = response.value;
          /* `return msg` came once: the output is a copy of it, as the JavaScript node clones the
           * first message it sends. */
          var out = r.same ? JSON.parse(JSON.stringify(r.msg)) : r.out;
          if (entry) {
            updateInPlace(entry, r.msg);
          }
          sendResults(self, entry, out);
          if (entry) {
            entry.done();
          }
          break;
        }
        /* node.error is deliberately in here with the rest. A one-argument node.error() reaches
         * the debug sidebar and stops there, and passing the message as a second argument is what
         * makes a Catch node fire — which is exactly how the built-in Function node behaves. This
         * node copies that rather than improving on it. */
        case 'log':
        case 'warn':
          self[response.ctx].apply(self, response.value);
          break;
        case 'error': {
          var args = response.value;
          var turn = self.inflight.get(response.msgid);
          if (turn && args[1] && typeof args[1] === 'object') {
            restoreLive(turn, revive(args[1]));
          }
          self.error.apply(self, args);
          break;
        }
        case 'status':
          self.userStatus = true;  /* cleared on close, as the JavaScript node does */
          self.status.apply(self, response.value);
          break;
        /* An exception nobody caught. The built-in Function node hands a thrown error to the
         * Catch node through done(err), with the message it belongs to; so does this. Outside
         * any message (On Stop) there is none, and it can only be logged. */
        case 'exception': {
          var failed = finish(self, response.msgid);
          if (failed) {
            updateInPlace(failed, response.value.msg);
          }
          var err = pythonError(self, response.value);
          if (failed) {
            failed.done(err);
          } else {
            self.error(err);
          }
          break;
        }
        /* An exception that ended the interpreter. Its exit follows, and reports it. */
        case 'crash':
          child.crash = pythonError(self, response.value);
          break;
        /* Python blocks on a reply for env.get and for flow/global get, so each must always
         * answer, even on error. */
        case 'env_get': {
          var setting = null;
          try {
            var found = (RED.util && RED.util.getSetting) ? RED.util.getSetting(self, response.value)
                                                         : process.env[response.value];
            setting = (found === undefined) ? null : found;
          } catch (err) {
            self.error(`env get failed: ${err.message}`);
          }
          self.child.send({__ctx_reply: true, value: setting});
          break;
        }
        case 'context_get': {
          var value = null;
          try {
            var got = scopeFor(self, response.value.scope).get(response.value.key);
            value = (got === undefined) ? null : got;
          } catch (err) {
            self.error(`context get failed: ${err.message}`);
          }
          self.child.send({__ctx_reply: true, value: value});
          break;
        }
        case 'context_set':
          try {
            scopeFor(self, response.value.scope).set(response.value.key, revive(response.value.value));
          } catch (err) {
            self.error(`context set failed: ${err.message}`);
          }
          break;
        default:
          throw new Error(`Don't know what to do with ${response.ctx}`);
      }
    });
    self.log(`Python function '${self.name}' running on PID ${self.child.pid}`);
    self.status({fill: 'green', shape: 'dot', text: 'Running'});
  }

  /* Marks the live req/res of an http in node on the copy Python gets, so they can be put back
   * wherever Python returns them. They are objects JSON cannot carry. */
  var LIVE = '__nodered_live__';

  function notRunning(self) {
    return `Function '${self.name}' is not running. Fix the code and deploy again`;
  }

  /* Hand a message to Python. Each input gets a number of its own, which every reply carries:
   * the message's _msgid is not enough, as messages split from one share it. */
  function deliver(self, seq, msg) {
    var copy = JSON.parse(safeStringify(msg));
    ['req', 'res'].forEach(function (key) {
      if (msg[key] && copy[key] && typeof copy[key] === 'object') {
        copy[key][LIVE] = key;
      }
    });
    self.child.send({seq: seq, msg: copy});
  }

  /* A fresh interpreter, and every message the dead one had not answered goes to it, in order.
   * They had not started: Python takes one at a time, and the one it was on has been settled. */
  function restart(self) {
    spawnFn(self);
    self.inflight.forEach(function (entry, seq) {
      deliver(self, seq, entry.msg);
    });
    armTimeout(self);
  }

  /* The timeout runs for the message Python is on: the oldest one not yet answered. Python
   * cannot be interrupted from outside, so a message that runs past it costs the process, as a
   * timed-out script costs the JavaScript node its run. */
  function armTimeout(self) {
    clearTimeout(self.timeoutTimer);
    self.timeoutTimer = null;
    var head = self.inflight.keys().next();
    if (!self.timeoutMs || head.done || !self.child) {
      return;
    }
    var child = self.child;
    var seq = head.value;
    self.timeoutTimer = setTimeout(function () {
      if (self.child === child && self.inflight.has(seq)) {
        child.timedOut = seq;
        child.kill('SIGKILL');
      }
    }, self.timeoutMs);
  }

  /* The message's turn is over: forget it, and start the clock on the next. */
  function finish(self, seq) {
    var entry = self.inflight.get(seq);
    self.inflight.delete(seq);
    armTimeout(self);
    return entry;
  }

  /* Buffers come back from Python as {type: 'Buffer', data: [...]}, which is what one becomes in
   * JSON; make them Buffers again. */
  function revive(value) {
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        value[i] = revive(value[i]);
      }
    } else if (value && typeof value === 'object') {
      var keys = Object.keys(value);
      if (keys.length === 2 && value.type === 'Buffer' && Array.isArray(value.data)) {
        return Buffer.from(value.data);
      }
      for (var k = 0; k < keys.length; k++) {
        value[keys[k]] = revive(value[keys[k]]);
      }
    }
    return value;
  }

  /* Make the message that came in what the function left it as; see _result in the script. */
  function updateInPlace(entry, view) {
    if (!view || typeof view !== 'object' || Array.isArray(view)) {
      return;
    }
    revive(view);
    restoreLive(entry, view);
    var target = entry.msg;
    Object.keys(target).forEach(function (key) {
      if (key !== '_msgid' && !Object.prototype.hasOwnProperty.call(view, key)) {
        delete target[key];
      }
    });
    Object.keys(view).forEach(function (key) {
      if (key !== '_msgid') {
        target[key] = view[key];
      }
    });
  }

  function restoreLive(entry, msg) {
    ['req', 'res'].forEach(function (key) {
      if (msg[key] && msg[key][LIVE] === key && entry.msg[key] !== undefined) {
        msg[key] = entry.msg[key];
      }
    });
  }

  /* The JavaScript node's sendResults, for what came back from Python. */
  function sendResults(self, entry, msgs) {
    if (msgs == null) {
      return;
    } else if (!Array.isArray(msgs)) {
      msgs = [msgs];
    }
    var msgCount = 0;
    for (var m = 0; m < msgs.length; m++) {
      if (msgs[m]) {
        if (!Array.isArray(msgs[m])) {
          msgs[m] = [msgs[m]];
        }
        for (var n = 0; n < msgs[m].length; n++) {
          var msg = msgs[m][n];
          if (msg === null || msg === undefined) {
            continue;
          }
          if (typeof msg === 'object' && !Array.isArray(msg)) {
            revive(msg);
            if (entry) {
              restoreLive(entry, msg);
              msg._msgid = entry.msg._msgid;
            }
            msgCount++;
          } else {
            self.error(`Function tried to send a message of type ${Array.isArray(msg) ? 'Array' : typeof msg}`);
            msgs[m][n] = null;
          }
        }
      }
    }
    if (msgCount > 0) {
      if (entry) {
        entry.send(msgs);
      } else {
        self.send(msgs);
      }
    }
  }

  function PythonFunction(config) {
    var self = this;
    RED.nodes.createNode(self, config);
    self.name = config.name;
    /* The messages handed to Python and not yet answered, by input number, in order: each one's
     * send and done, and the message itself, for the live req/res and for a crash to blame. */
    self.inflight = new Map();
    self.seq = 0;
    var timeout = Number(config.timeout) > 0 ? Number(config.timeout)
                : (RED.settings && RED.settings.globalFunctionTimeout > 0
                   ? Number(RED.settings.globalFunctionTimeout) : 0);
    self.timeoutMs = timeout * 1000;
    self.timeoutTimer = null;
    self.func = {
      code: `
import ast
import datetime
import decimal
import json
import linecache
import os
import sys
import traceback


class _Channel(object):
    """Wraps fd 3. On Windows, Node's IPC pipe wraps every message in a libuv frame;
    on POSIX it is plain newline-delimited JSON with no header. This makes both look
    like the POSIX form to the rest of the script.

    The frame is 16 bytes, and it is four little-endian uint32s, not two uint64s
    (libuv, src/win/pipe.c): flags, reserved1, data_length, reserved2. Reading the
    length below as one 8-byte field is correct only because libuv zeroes the header
    and never writes reserved2 - and writing one is accepted only because the values
    laid down are flags=1, reserved1=0, data_length=n, reserved2=0, which is what the
    parent validates (flags must be within 0x07, reserved2 must be zero, or the
    channel is aborted). Anything that changes those four words has to keep that true.
    """

    def __init__(self, raw, framed):
        self._raw = raw
        self._framed = framed

    def _read_exact(self, n):
        buf = b''
        while len(buf) < n:
            chunk = self._raw.read(n - len(buf))
            if not chunk:
                return b''
            buf += chunk
        return buf

    # A frame bigger than this is not a frame. The length field is 64 bits, so a channel that
    # has fallen out of step with the framing reads a garbage length and asks for terabytes;
    # the read then dies with MemoryError, which kills the child without ever saying what went
    # wrong. Fail loudly instead.
    MAX_PAYLOAD = 64 * 1024 * 1024

    def readline(self):
        if not self._framed:
            return self._raw.readline()
        header = self._read_exact(16)
        if not header:
            return b''
        length = int.from_bytes(header[8:16], 'little')
        if length > self.MAX_PAYLOAD:
            raise RuntimeError(
                'IPC frame claims %d bytes, which cannot be right: this channel is out of step '
                'with the frame header it is being read with.' % length)
        return self._read_exact(length)

    def write(self, data):
        if not self._framed:
            self._raw.write(data)
        else:
            self._raw.write((1).to_bytes(8, 'little') + len(data).to_bytes(8, 'little') + data)


if sys.version_info[0]<3:
    channel = os.fdopen(3, "r+")
else:
    channel = _Channel(os.fdopen(3, "r+b", buffering=0), os.name == 'nt')


class Msg(object):
    SEND = 'send'
    LOG = 'log'
    WARN = 'warn'
    ERROR = 'error'
    # Separate from ERROR on purpose: this one is not the author calling node.error(), it is an
    # exception nobody caught, and only this one is handed to the Catch node.
    EXCEPTION = 'exception'
    # An exception that ends the interpreter: one outside the author's function, or code that
    # does not compile. Sent instead of printing a traceback to stderr.
    CRASH = 'crash'
    # The function returned: its result, and the end of the message's turn. node.send() calls
    # during the turn are SEND; only this one tells Node the message is done.
    RESULT = 'result'
    ENV_GET = 'env_get'
    STATUS = 'status'
    # Sent once, when the code has loaded: a process that dies before this failed on its code,
    # and respawning it cannot help.
    READY = 'ready'
    CONTEXT_GET = 'context_get'
    CONTEXT_SET = 'context_set'

    def __init__(self, ctx, value, msgid, encoded=None):
        self.ctx = ctx
        self.value = value
        self.msgid = msgid
        self.encoded = encoded  # the value already as JSON, when it was built from parts

    def dumps(self):
        # The value on its own: one JSON cannot hold is then reported against the author's data
        # ("when serializing dict item 'payload'"), not also against this envelope's 'value'.
        if self.encoded is None:
            self.encoded = json.dumps(self.value, default=_to_json)
        return '{"ctx": %s, "value": %s, "msgid": %s}\\n' % (
            json.dumps(self.ctx), self.encoded, json.dumps(self.msgid))


def _to_json(o):
    """What JSON cannot hold, made into what a JavaScript Function node would have sent."""
    if isinstance(o, (datetime.datetime, datetime.date, datetime.time)):
        return o.isoformat()  # what a JavaScript Date becomes in JSON
    if isinstance(o, (set, frozenset)):
        return list(o)
    if isinstance(o, (bytes, bytearray)):
        return {'type': 'Buffer', 'data': list(bytearray(o))}  # Node makes it a Buffer again
    if isinstance(o, decimal.Decimal):
        return float(o)
    raise TypeError('Object of type %s is not JSON serializable' % type(o).__name__)


def _view(msg):
    """msg as it can travel back, or None if the function left in it something JSON cannot hold:
    the original then keeps what it had, rather than this turning into an error of its own."""
    if msg is None:
        return None
    try:
        json.dumps(msg, default=_to_json)
        return msg
    except Exception:
        return None


def _from_json(d):
    """A Buffer arrives as {"type": "Buffer", "data": [...]}; Python code wants bytes."""
    if len(d) == 2 and d.get('type') == 'Buffer' and isinstance(d.get('data'), list):
        return bytes(bytearray(d['data']))
    return d


# Inbound messages that arrive while we are waiting for a context reply. Node and Python share one
# channel, so an input can land in the middle of a flow.get round trip; park it and serve it after.
_pending_inputs = []


def _read_object():
    raw = channel.readline()
    if not raw:
        raise RuntimeError('Received EOF!')
    return json.loads(raw, object_hook=_from_json)


def _await_context_reply():
    while True:
        obj = _read_object()
        if isinstance(obj, dict) and obj.get('__ctx_reply'):
            return obj.get('value')
        _pending_inputs.append(obj)


def _next_input():
    if _pending_inputs:
        return _pending_inputs.pop(0)
    while True:
        obj = _read_object()
        if isinstance(obj, dict) and obj.get('__ctx_reply'):
            continue  # a reply nobody is waiting for; drop it
        return obj


class Context(object):
    """flow / global context, proxied to the Node side over the IPC channel."""

    def __init__(self, scope, channel):
        self.__scope = scope
        self.__channel = channel

    def __write(self, ctx, value):
        self.__channel.write(Msg(ctx, value, None).dumps().encode('utf-8'))

    def get(self, key):
        self.__write(Msg.CONTEXT_GET, {'scope': self.__scope, 'key': key})
        return _await_context_reply()

    def set(self, key, value):
        self.__write(Msg.CONTEXT_SET, {'scope': self.__scope, 'key': key, 'value': value})


# What the node was deployed with: the code of its three tabs, and who it is.
CONFIG = json.loads(sys.argv[1])


class Node(object):
    # The same names the JavaScript Function node gives node.
    id = CONFIG['id']
    name = CONFIG['name']
    path = CONFIG['path']
    outputCount = CONFIG['outputCount']

    def __init__(self, msgid, channel):
        self.__msgid = msgid
        self.__channel = channel

    def send(self, msg):
        self.send_to_node(Msg(Msg.SEND, msg, self.__msgid))

    def log(self, *args):
        self.send_to_node(Msg(Msg.LOG, args, self.__msgid))

    def warn(self, *args):
        self.send_to_node(Msg(Msg.WARN, args, self.__msgid))

    def error(self, *args):
        self.send_to_node(Msg(Msg.ERROR, args, self.__msgid))

    def status(self, *args):
        self.send_to_node(Msg(Msg.STATUS, args, self.__msgid))

    # In JavaScript the function works on the message itself, so whatever holds it afterwards —
    # a Complete or Catch node — sees what the function did to it. Python works on a copy, so
    # the copy goes back with the result, and Node applies it to the original.
    def _result(self, msgs, msg):
        """Not for the author to call. The dispatch loop hands back what the function returned."""
        same = msgs is msg  # return msg: send it once
        out = json.dumps(msgs, default=_to_json)  # fails against the author's data alone
        if same:
            view = out
        else:
            try:
                view = json.dumps(msg, default=_to_json)
            except Exception:
                view = 'null'  # see _view
        encoded = '{"out": %s, "same": %s, "msg": %s}' % (
            'null' if same else out, 'true' if same else 'false', view)
        self.send_to_node(Msg(Msg.RESULT, None, self.__msgid, encoded=encoded))

    def _uncaught(self, report, msg=None):
        """Not for the author to call. The dispatch loop reports an escaped exception here."""
        report['msg'] = _view(msg)
        self.send_to_node(Msg(Msg.EXCEPTION, report, self.__msgid))

    def send_to_node(self, msg):
        self.__channel.write(msg.dumps().encode('utf-8'))


class Env(object):
    """env.get(name): the flow, group and global environment variables, as in JavaScript."""

    def get(self, name):
        channel.write(Msg(Msg.ENV_GET, name, None).dumps().encode('utf-8'))
        return _await_context_reply()


env = Env()
flow = Context('flow', channel)
# 'global' is a reserved word in Python, hence the name.
global_ctx = Context('global', channel)
# On Start and On Stop run outside any message, and use node too.
node = Node(None, channel)


# The author's code is not spliced into this script: it arrives as an argument and is compiled
# under a file name of its own, the function as the body of python_function. A traceback then
# gives the line in the editor ("Function node", line 2), not the line of this script it used to
# sit on (178). On Start and On Stop get names of their own the same way.
FILENAME = 'Function node'
OWN_FILES = (FILENAME, 'On Start', 'On Stop')


def _describe(etype, value, tb):
    """A failure the way the built-in Function node shows one: the exception and where in the
    author's code it happened, with the whole traceback alongside for the log and Catch node."""
    where = None
    if issubclass(etype, SyntaxError):
        name, message = etype.__name__, value.msg or ''
        if value.filename in OWN_FILES:
            where = _where(value.filename, 'line %s, col %s' % (value.lineno, value.offset))
            tb = None  # the frames are this script parsing it, which the author did not write
    else:
        lines = ''.join(traceback.format_exception_only(etype, value)).strip().split('\\n')
        name, _, first = lines[0].partition(': ')
        message = '\\n'.join([first] + lines[1:])
    if where is None:
        own = [frame for frame in traceback.extract_tb(tb) if frame[0] in OWN_FILES]
        if own:
            where = _where(own[-1][0], 'line %s' % own[-1][1])
    if where:
        lines = message.split('\\n')
        lines[0] = (lines[0] + ' (%s)' % where).lstrip()
        message = '\\n'.join(lines)
    return {'name': name, 'message': message,
            'traceback': ''.join(traceback.format_exception(etype, value, tb)).rstrip()}


def _where(filename, position):
    return position if filename == FILENAME else '%s, %s' % (filename, position)


def _crash(etype, value, tb):
    try:
        channel.write(Msg(Msg.CRASH, _describe(etype, value, tb), None).dumps().encode('utf-8'))
        if hasattr(channel, 'flush'):
            channel.flush()
    except Exception:
        sys.__excepthook__(etype, value, tb)  # the channel is what failed: stderr it is


sys.excepthook = _crash


def _compile(source, filename, tree=None):
    # Registered so a traceback can quote the author's lines, as it does for a file on disk.
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
    return compile(tree or ast.parse(source, filename), filename, 'exec')


def _load():
    body = ast.parse(CONFIG['func'], FILENAME).body
    tree = ast.parse('def python_function(msg):\\n    pass\\n', FILENAME)
    if body:
        tree.body[0].body = body
    exec(_compile(CONFIG['func'], FILENAME, tree), globals())
    # On Start runs once, before the first message, in this module: an import or a variable it
    # sets is there for the function. (The JavaScript node keeps them apart; Python has no
    # module setup of its own, so this is where imports go.)
    if CONFIG['initialize'].strip():
        exec(_compile(CONFIG['initialize'], 'On Start'), globals())
    if CONFIG['finalize'].strip():
        return _compile(CONFIG['finalize'], 'On Stop')
    return None


_finalize = _load()
channel.write(Msg(Msg.READY, None, None).dumps().encode('utf-8'))
if hasattr(channel, 'flush'):
    channel.flush()  # Python 2's file object buffers; the _Channel above does not
while True:
    turn = _next_input()
    if turn.get('__stop'):
        break
    msg = turn['msg']
    # Node numbers every input. _msgid is not enough: messages split from one share it.
    node = Node(turn['seq'], channel)
    # An uncaught exception used to escape this loop and end the process. The flow then saw a
    # dead interpreter rather than a failed message: nothing for a Catch node to catch, and
    # every module-level variable gone with it. The built-in Function node hands a thrown error
    # to the Catch node, so report it on that channel and keep going. Handing back the result is
    # inside too: one JSON cannot hold is the author's mistake like any other. So is sys.exit(),
    # which would otherwise end the process with nothing said.
    try:
        node._result(python_function(msg), msg)
    except (Exception, SystemExit):
        etype, value, tb = sys.exc_info()
        # tb_next: skip this loop's frame
        node._uncaught(_describe(etype, value, tb.tb_next), msg)
node = Node(None, channel)
if _finalize:
    try:
        exec(_finalize, globals())
    except (Exception, SystemExit):
        etype, value, tb = sys.exc_info()
        node._uncaught(_describe(etype, value, tb.tb_next))
`,
      config: JSON.stringify({
        func: config.func || '',
        initialize: config.initialize || '',
        finalize: config.finalize || '',
        id: config.id || null,
        name: config.name || '',
        path: self._path || config.id || null,
        outputCount: Number(config.outputs) || 1,
      }),
      finalize: !!(config.finalize && config.finalize.trim()),
    };
    spawnFn(self);
    self.on('input', function (msg, send, done) {
      /* Node-RED 1.0+ passes both; a caller without them gets what they would have done. */
      send = send || function (msgs) { self.send(msgs); };
      done = done || function (err) { if (err) { self.error(err, msg); } };
      /* No process when its code could not load. And send() on a closed IPC channel throws
       * hard enough to take the whole runtime down with it. Report it on the message. */
      if (self.stopped || !self.child) {
        done(notRunning(self));
        self.status({fill: 'red', shape: 'dot', text: 'Stopped, see debug panel'});
        return;
      }
      var seq = ++self.seq;
      self.inflight.set(seq, {msg: msg, send: send, done: done});
      /* Between a crash and its restart there is no channel; the restart delivers it. */
      if (self.child.connected) {
        deliver(self, seq, msg);
      }
      if (self.inflight.size === 1) {
        armTimeout(self);
      }
    });
    /* How long On Stop gets before the process is killed anyway. */
    var STOP_WAIT_MS = 5000;
    self.on('close', function (removed, done) {
      done = (typeof done === 'function') ? done : function () {};
      clearTimeout(self.timeoutTimer);
      self.stopped = true;
      if (self.userStatus) {
        self.status({});
      }
      var child = self.child;
      /* There is no child when no interpreter was found, and killing undefined throws. */
      if (!child) {
        done();
        return;
      }
      /* Drop, not report: whatever is pending belongs to code the redeploy just replaced. */
      child.dropStderr = true;
      clearTimeout(child.stderrTimer);
      child.stderrText = '';
      if (!self.func.finalize || !child.connected) {
        child.kill();
        done();
        return;
      }
      /* On Stop runs in Python once it is free; give it a while, then stop it regardless. */
      var force = setTimeout(function () { child.kill(); }, STOP_WAIT_MS);
      child.once('close', function () {
        clearTimeout(force);
        done();
      });
      child.send({__stop: true});
    });
  }

  RED.nodes.registerType('node-red-python-function', PythonFunction);
};

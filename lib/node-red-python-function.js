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
  var util = require('util');

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
      self.error(`Cannot start Python: ${python.error}`);
      self.status({fill: 'red', shape: 'dot', text: 'No Python found'});
      return;
    }
    /* The author's code goes in as an argument of its own; see FILENAME in the script. */
    self.child = spawn(python.cmd, python.args.concat(['-uc', self.func.code, self.func.source]), {
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
      self.error(crash || (text ? `${text}\n\n` : '') + tail);
      if (!child.ready) {
        self.status({fill: 'red', shape: 'dot', text: 'Stopped, see debug panel'});
        return;
      }
      spawnFn(self);
    });
    self.child.on('message', function (response) {
      switch (response.ctx) {
        case 'ready':
          child.ready = true;
          break;
        case 'send':
          sendResults(self, response.msgid, response.value);
          break;
        /* node.error is deliberately in here with the rest. A one-argument node.error() reaches
         * the debug sidebar and stops there, and passing the message as a second argument is what
         * makes a Catch node fire — which is exactly how the built-in Function node behaves. This
         * node copies that rather than improving on it. */
        case 'log':
        case 'warn':
        case 'error':
        case 'status':
          self[response.ctx].apply(self, response.value);
          break;
        /* An exception nobody caught. The built-in Function node hands a thrown error to the
         * Catch node on the author's behalf, so this does the same: the message the exception
         * belongs to is looked up and passed along with the traceback. */
        case 'exception':
          reportError(self, response.msgid, response.value);
          break;
        /* An exception that ended the interpreter. Its exit follows, and reports it. */
        case 'crash':
          child.crash = pythonError(self, response.value);
          break;
        /* Python blocks on a reply for get, so this must always answer, even on error. */
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
            scopeFor(self, response.value.scope).set(response.value.key, response.value.value);
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

  /* The messages currently inside Python, keyed by _msgid. Python takes one at a time, so this
   * normally holds a single entry; the cap exists only so a function that never returns cannot
   * grow it without bound. */
  var INFLIGHT_CAP = 32;

  function rememberInflight(self, msg) {
    if (!msg || msg._msgid === undefined) {
      return;
    }
    self.inflight.set(msg._msgid, msg);
    while (self.inflight.size > INFLIGHT_CAP) {
      self.inflight.delete(self.inflight.keys().next().value);
    }
  }

  /* Report an uncaught Python exception the way the runtime expects. */
  function reportError(self, msgid, failure) {
    var msg = self.inflight.get(msgid);
    if (msg) {
      self.inflight.delete(msgid);
    }
    /* With msg a Catch node fires. An exception raised outside any message's turn has none, so
     * it can only reach the sidebar. */
    self.error(pythonError(self, failure), msg);
  }

  function sendResults(self, _msgid, msgs) {
    self.inflight.delete(_msgid);
    if (msgs == null) {
      return;
    } else if (!util.isArray(msgs)) {
      msgs = [msgs];
    }
    var msgCount = 0;
    for (var m = 0; m < msgs.length; m++) {
      if (msgs[m]) {
        if (util.isArray(msgs[m])) {
          for (var n = 0; n < msgs[m].length; n++) {
            msgs[m][n]._msgid = _msgid;
            msgCount++;
          }
        } else {
          msgs[m]._msgid = _msgid;
          msgCount++;
        }
      }
    }
    if (msgCount > 0) {
      // Restore the live req/res objects, which cannot survive JSON.
      if (self.req !== undefined) {
        msgs[0].req = self.req;
      }
      if (self.res !== undefined) {
        msgs[0].res = self.res;
      }
      self.send(msgs);
    }
  }

  function PythonFunction(config) {
    var self = this;
    RED.nodes.createNode(self, config);
    self.name = config.name;
    /* Kept so a failure coming back from Python can be tied to the message that caused it. */
    self.inflight = new Map();
    self.func = {
      code: `
import ast
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
    STATUS = 'status'
    # Sent once, when the code has loaded: a process that dies before this failed on its code,
    # and respawning it cannot help.
    READY = 'ready'
    CONTEXT_GET = 'context_get'
    CONTEXT_SET = 'context_set'

    def __init__(self, ctx, value, msgid):
        self.ctx = ctx
        self.value = value
        self.msgid = msgid

    def dumps(self):
        # The value on its own: one JSON cannot hold is then reported against the author's data
        # ("when serializing dict item 'payload'"), not also against this envelope's 'value'.
        return '{"ctx": %s, "value": %s, "msgid": %s}\\n' % (
            json.dumps(self.ctx), json.dumps(self.value), json.dumps(self.msgid))

    @classmethod
    def loads(cls, json_string):
        return cls(**json.loads(json_string))


# Inbound messages that arrive while we are waiting for a context reply. Node and Python share one
# channel, so an input can land in the middle of a flow.get round trip; park it and serve it after.
_pending_inputs = []


def _read_object():
    raw = channel.readline()
    if not raw:
        raise RuntimeError('Received EOF!')
    return json.loads(raw)


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


class Node(object):
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

    def _uncaught(self, report):
        """Not for the author to call. The dispatch loop reports an escaped exception here."""
        self.send_to_node(Msg(Msg.EXCEPTION, report, self.__msgid))

    def send_to_node(self, msg):
        self.__channel.write(msg.dumps().encode('utf-8'))


flow = Context('flow', channel)
# 'global' is a reserved word in Python, hence the name.
global_ctx = Context('global', channel)


# The author's code is not spliced into this script: it arrives as an argument and is compiled
# under a file name of its own, as the body of python_function. A traceback then gives the line
# in the editor ("Function node", line 2), not the line of this script it used to sit on (178).
FILENAME = 'Function node'
SOURCE = sys.argv[1]


def _describe(etype, value, tb):
    """A failure the way the built-in Function node shows one: the exception and where in the
    author's code it happened, with the whole traceback alongside for the log and Catch node."""
    where = None
    if issubclass(etype, SyntaxError):
        name, message = etype.__name__, value.msg or ''
        if value.filename == FILENAME:
            where = 'line %s, col %s' % (value.lineno, value.offset)
            tb = None  # the frames are this script parsing it, which the author did not write
    else:
        lines = ''.join(traceback.format_exception_only(etype, value)).strip().split('\\n')
        name, _, first = lines[0].partition(': ')
        message = '\\n'.join([first] + lines[1:])
    if where is None:
        own = [frame[1] for frame in traceback.extract_tb(tb) if frame[0] == FILENAME]
        if own:
            where = 'line %s' % own[-1]
    if where:
        lines = message.split('\\n')
        lines[0] = (lines[0] + ' (%s)' % where).lstrip()
        message = '\\n'.join(lines)
    return {'name': name, 'message': message,
            'traceback': ''.join(traceback.format_exception(etype, value, tb)).rstrip()}


def _crash(etype, value, tb):
    try:
        channel.write(Msg(Msg.CRASH, _describe(etype, value, tb), None).dumps().encode('utf-8'))
        if hasattr(channel, 'flush'):
            channel.flush()
    except Exception:
        sys.__excepthook__(etype, value, tb)  # the channel is what failed: stderr it is


sys.excepthook = _crash


def _load():
    # Registered so a traceback can quote the author's lines, as it does for a file on disk.
    linecache.cache[FILENAME] = (len(SOURCE), None, SOURCE.splitlines(True), FILENAME)
    body = ast.parse(SOURCE, FILENAME).body
    tree = ast.parse('def python_function(msg):\\n    pass\\n', FILENAME)
    if body:
        tree.body[0].body = body
    exec(compile(tree, FILENAME, 'exec'), globals())


_load()
channel.write(Msg(Msg.READY, None, None).dumps().encode('utf-8'))
if hasattr(channel, 'flush'):
    channel.flush()  # Python 2's file object buffers; the _Channel above does not
while True:
    msg = _next_input()
    msgid = msg["_msgid"]
    node = Node(msgid, channel)
    # An uncaught exception used to escape this loop and end the process. The flow then saw a
    # dead interpreter rather than a failed message: nothing for a Catch node to catch, and
    # every module-level variable gone with it. The built-in Function node hands a thrown error
    # to the Catch node, so report it on that channel and keep going. The send is inside too: a
    # return value JSON cannot hold (a set, a datetime) is the author's mistake like any other.
    # So is sys.exit(), which would otherwise end the process with nothing said.
    try:
        node.send(python_function(msg))
    except (Exception, SystemExit):
        etype, value, tb = sys.exc_info()
        node._uncaught(_describe(etype, value, tb.tb_next))  # tb_next: skip this loop's frame
`,
      source: config.func,
    };
    spawnFn(self);
    self.on('input', function (msg) {
      if (msg.req !== undefined) {
        self.req = msg.req;
      }
      if (msg.res !== undefined) {
        self.res = msg.res;
      }
      /* The child is gone when its code could not load, and send() on a closed IPC channel
       * throws hard enough to take the whole runtime down with it. Report it on the node. */
      if (!self.child || !self.child.connected) {
        self.error(`Function '${self.name}' is not running. Fix the code and deploy again`, msg);
        self.status({fill: 'red', shape: 'dot', text: 'Stopped, see debug panel'});
        return;
      }
      rememberInflight(self, msg);
      self.child.send(JSON.parse(safeStringify(msg)));
    });
    self.on('close', function () {
      /* There is no child when no interpreter was found, and killing undefined throws. */
      if (self.child) {
        /* Drop, not report: whatever is pending belongs to code the redeploy just replaced. */
        self.child.dropStderr = true;
        clearTimeout(self.child.stderrTimer);
        self.child.stderrText = '';
        self.child.kill();
      }
    });
  }

  RED.nodes.registerType('node-red-python-function', PythonFunction);
};

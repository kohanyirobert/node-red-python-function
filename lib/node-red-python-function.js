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
 *   3. `python3` is used instead of `python`. On a current distribution `python` is frequently
 *      absent entirely, and upstream fails at spawn with no useful message.
 *
 * `global` is a reserved word in Python, so the global scope is exposed as `global_ctx`.
 */
module.exports = function (RED) {
  var spawn = require('child_process').spawn;
  var util = require('util');

  function indentLines(fnCode, depth) {
    return fnCode.split('\n').map((line) => Array(depth).join(' ') + line).join('\n');
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

  function spawnFn(self) {
    self.child = spawn('python3', ['-uc', self.func.code], {stdio: ['pipe', 'pipe', 'pipe', 'ipc']});
    self.child.stdout.on('data', function (data) {
      self.log(data.toString());
    });
    self.child.stderr.on('data', function (data) {
      self.error(data.toString());
    });
    self.child.on('close', function (exitCode) {
      if (exitCode) {
        self.error(`Python Function process exited with code ${exitCode}`);
        if (self.func.attempts) {
          spawnFn(self);
          self.func.attempts--;
        } else {
          self.error(`Function '${self.name}' has failed more than 10 times. Fix it and deploy again`);
          self.status({fill: 'red', shape: 'dot', text: 'Stopped, see debug panel'});
        }
      }
    });
    self.child.on('message', function (response) {
      switch (response.ctx) {
        case 'send':
          sendResults(self, response.msgid, response.value);
          break;
        case 'log':
        case 'warn':
        case 'error':
        case 'status':
          self[response.ctx].apply(self, response.value);
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

  function sendResults(self, _msgid, msgs) {
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
    self.func = {
      code: `
import os
import json
import sys

if sys.version_info[0]<3:
    channel = os.fdopen(3, "r+")
else:
    channel = os.fdopen(3, "r+b", buffering=0)


class Msg(object):
    SEND = 'send'
    LOG = 'log'
    WARN = 'warn'
    ERROR = 'error'
    STATUS = 'status'
    CONTEXT_GET = 'context_get'
    CONTEXT_SET = 'context_set'

    def __init__(self, ctx, value, msgid):
        self.ctx = ctx
        self.value = value
        self.msgid = msgid

    def dumps(self):
        return json.dumps(vars(self)) + "\\n"

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

    def send_to_node(self, msg):
        self.__channel.write(msg.dumps().encode('utf-8'))


flow = Context('flow', channel)
# 'global' is a reserved word in Python, hence the name.
global_ctx = Context('global', channel)


def python_function(msg):
` + indentLines(config.func, 4) +
`
while True:
    msg = _next_input()
    msgid = msg["_msgid"]
    node = Node(msgid, channel)
    res_msgs = python_function(msg)
    node.send(res_msgs)
`,
      attempts: 10
    };
    spawnFn(self);
    self.on('input', function (msg) {
      if (msg.req !== undefined) {
        self.req = msg.req;
      }
      if (msg.res !== undefined) {
        self.res = msg.res;
      }
      self.child.send(JSON.parse(safeStringify(msg)));
    });
    self.on('close', function () {
      self.child.kill();
    });
  }

  RED.nodes.registerType('node-red-python-function', PythonFunction);
};

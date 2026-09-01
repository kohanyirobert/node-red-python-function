# Node-RED Python Function

`@kohanyirobert/node-red-python-function`

Write Node-RED **Function** nodes in Python — with `flow` and `global` context that actually work.

A fork of [`node-red-contrib-python-function`](https://github.com/arnauorriols/node-red-contrib-python-function)
0.0.5 by Arnau Orriols (MIT), which has had no upstream activity since 2020.

We picked it for a beginners' course, verified it properly, and hit three bugs. This is that
package with the three fixed.

## What is different

### 1 · `flow` and `global_ctx` exist

Upstream defines only `node` in the Python preamble, so `flow.get(...)` raises `NameError` and the
Python process dies — the node emits nothing and the flow silently stops.

```python
n = flow.get('count') or 0
flow.set('count', n + 1)
msg['payload'] = {'count': flow.get('count')}
return msg
```

Both scopes are available. `global` is a reserved word in Python, so the global scope is
**`global_ctx`**:

```python
global_ctx.set('seen', (global_ctx.get('seen') or 0) + 1)
```

They are proxied to the Node side over the IPC channel the node already uses. `get` is a
request/reply and blocks until Node answers; `set` is fire-and-forget. Inbound messages that arrive
mid-round-trip are parked and served afterwards rather than being mistaken for a reply.

### 2 · `msg.payload` survives behind an `http in` node

Upstream's circular-reference stripper discarded **any** object it had already seen, not only true
cycles. For an HTTP request `msg.payload` and `msg.req.body` are the same object, so whichever the
serialiser reached second was silently deleted — and `payload` lost that race.

The fork tracks the current ancestor chain instead, which removes exactly what JSON cannot
represent and nothing else. Python now sees the same keys JavaScript does:

```
upstream 0.0.5 : ["_msgid", "req", "res"]
this fork      : ["_msgid", "payload", "req", "res"]
javascript     : ["_msgid", "payload", "req", "res"]
```

### 3 · Spawns `python3`, not `python`

On a current distribution `python` is frequently absent, and upstream fails at spawn with nothing
useful in the log.

## Unchanged from upstream

Multiple outputs, `node.send` / `log` / `warn` / `error` / `status`, and the restoration of the live
`req` / `res` objects onto the outgoing message all work as they did. The editor UI is upstream's.

## Install

```bash
npm install @kohanyirobert/node-red-python-function
```

The node appears in the palette as **python function**, type `node-red-python-function`. It is a
**separate node type from upstream's**, deliberately: Node-RED refuses to start with two packages
registering the same type, and being able to install both at once is what made it possible to prove
which behaviours were the node's fault rather than the flow's.

Requires `python3` on `PATH`. No Python dependencies.

## Verified against

Node-RED 4.x · Node 24.14.1 · Python 3.14.7.

| | upstream 0.0.5 | **this fork** | JS Function |
|---|---|---|---|
| `for` loop with an `if` | works | **works** | works |
| two outputs | works | **works** | works |
| behind an `http in` node | answers | **answers** | answers |
| `msg.payload` behind `http in` | **missing** | **present** | present |
| `flow.get` / `flow.set` | **NameError** | **works** | works |
| `global` scope | **NameError** | **works** as `global_ctx` | works |

## Tests

```bash
npm test
```

Two of them, and **both have to be run on Windows as well as on a POSIX box** — that is the
point of them:

| | |
|---|---|
| `test/e2e_test.js` | drives the node against a stub Node-RED, with no Node-RED installed: a message in, `node.log` and the returned `msg` out, and a `flow.set` / `flow.get` round trip, which is where Python blocks waiting for an answer. It exercises the real spawn options and both directions of the IPC channel |
| `test/channel_test.py` | the framing itself, read out of `lib/` rather than copied so it cannot drift. It forces the framed and unframed paths on, so a POSIX machine can test the Windows one — including a captured Windows frame, a payload whose length puts a newline inside the header, a frame split across reads, two frames in one write, and an impossible length |

Node's `ipc` channel frames every message on Windows and does not on POSIX, so a change here
passing on one platform says nothing about the other. That asymmetry is what let a crash on
every single message ship: `UnicodeDecodeError: 'utf-32-le' codec can't decode bytes`, on the
first message a node received, before the user's function ran.

`npm test` runs `python3`, which is what the node itself spawns (see §3 above).

## Licence

MIT, as upstream. Original copyright Arnau Orriols.

# Node-RED Python Function

`@kohanyirobert/node-red-python-function`

Write Node-RED **Function** nodes in Python — with `flow` and `global` context that actually work.

A fork of [`node-red-contrib-python-function`](https://github.com/arnauorriols/node-red-contrib-python-function)
0.0.5 by Arnau Orriols (MIT), which has had no upstream activity since 2020.

We picked it for a beginners' course, verified it properly, and kept hitting bugs. This is that
package with five of them fixed.

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

### 3 · The interpreter is looked up, not hardcoded

Upstream ran `python`, which is frequently absent on a current Linux distribution. Naming
`python3` instead — which this package did until 1.0.2 — is just as wrong on **Windows**, where
an installer from python.org lays down `python.exe` and the `py` launcher and **no
`python3.exe`**. So the node tries `python3`, then `python`, then `py -3` on Windows, and keeps
the first that answers `-V`. Set `NODE_RED_PYTHON` to a full path to override; an override that
does not run is reported rather than quietly ignored.

A failed spawn now **reports on the node** instead of killing Node-RED. Nothing listened for
`error` on the child, so `spawn python3 ENOENT` was an uncaught exception — it took the whole
runtime down, every flow, not just this node:

```
2 Sep 19:51:28 - [info] [node-red-python-function:clean the lines] Python function running on PID undefined
[red] Uncaught Exception:
2 Sep 19:51:28 - [error] Error: spawn python3 ENOENT
```

### 4 · The code box appears on every Node-RED

Upstream's edit dialog called `ace.edit(...)` directly. That worked only because Node-RED used to
load ACE into every editor page. **Node-RED 5 loads just the editor `settings.js` selects, and
the default is Monaco**, so `ace` is undefined, `oneditprepare` throws, and the dialog opens with
Name, Function and Outputs and **an empty box where the code should be** — with no way to write
or read the Python.

The dialog now asks Node-RED for an editor through `RED.editor.createEditor`, which returns
whichever one the runtime has (Monaco, ACE or the plain textarea) behind one interface, and has
been available since Node-RED 0.x. Node-RED maps `ace/mode/python` to Monaco's Python itself.
A `.size()` call left over from jQuery 2 went at the same time.

### 5 · A raise reaches the Catch node, like a throw does

The built-in Function node has three rules, and this node now follows all three rather than
inventing its own:

| in the node | Catch node |
|---|---|
| `node.error("text")` | does **not** fire — debug sidebar only |
| `node.error("text", msg)` | fires; the message rode along |
| `raise` / `throw` | fires; the runtime attaches the message for you |

The first two lines always worked here. The third did not. Nothing wrapped the author's function,
so a `raise` escaped the dispatch loop and **ended the interpreter**: the flow saw a dead process
rather than a failed message, every module-level variable went with it, and the only trace was
`Python Function process exited with code 1` — itself uncatchable. A `KeyError` on a malformed API
response did the same, which is how most people met it.

Now an escaped exception is reported on its own channel, carrying the message it belongs to:

```python
raise ValueError('kaboom')   # caught, with the traceback; the interpreter stays up
msg['payload'].get('nope')   # same, for an error nobody wrote on purpose
node.error('boom')           # logged only — exactly as in the built-in node
node.error('boom', msg)      # caught
```

The message that entered the node is held until Python answers for it, which is how the traceback
gets tied back to it. An exception raised outside any message's turn — during import, say — has no
message to carry and so is logged only.

**`node.error` deliberately did not change.** Making a one-argument call catchable would be more
convenient and would stop this behaving like the node it is modelled on, so the convenience was
left out.

### 6 · One failure, one entry in the debug sidebar

Whatever Python wrote to stderr went to the sidebar one pipe chunk at a time, so a single traceback
arrived as several entries — typically `Traceback (most recent call last):`, then the rest of it,
then `Python Function process exited with code 1` on its own. A `raise` inside the function was
already a single entry after §5; this covers everything that still fails outside it, such as
returning something JSON cannot hold.

- stderr is collected until it has been quiet for 200 ms, and reported as one entry. A function
  that writes to stderr without pause (`logging.warning` on every message, say) is still reported
  at least once a second, and in pieces of about 64 KB at most. The flip side: stderr written close
  together — by two messages in quick succession, or just before a crash — shares an entry.
  Trailing whitespace is trimmed, so stderr that is only whitespace is not reported.
- When the interpreter dies, the exit code goes in the same entry as the error that killed it.
  stderr that looks like a traceback waits up to 2 s for that exit rather than 200 ms, so a slow
  machine does not split them; the flip side is that a traceback a live function prints itself
  (`traceback.print_exc()`) shows up up to 2 s late.
- Code that cannot even load — a `SyntaxError`, an `IndentationError` — is no longer respawned ten
  times. Each respawn ran the same code and failed the same way, so the same traceback landed in
  the sidebar eleven times. Python now says when its code has loaded; a process that dies before
  that is reported once and the node stops until the next deploy.
- Python 3.13+ colours its tracebacks when `FORCE_COLOR` is set, even into a pipe, and the sidebar
  showed the escape codes as text. The interpreter is started with `PYTHON_COLORS=0`.

### 7 · An error reads like the built-in node's: one line, and the line number in the editor

After §6 a crash was one entry holding the whole traceback, and the sidebar shows only the first
1000 characters of an entry (`debugMaxLength`). A long traceback — returning a `set`, a `datetime`
or `bytes` gives one — lost its last line, the one that says what went wrong, along with the exit
code and the notice that the node had stopped. And every line number pointed into the script the
node wraps around the author's code: line 2 of the function was `line 178`.

The built-in Function node shows a thrown error as one line, `TypeError: ...`, and keeps the stack
for the Catch node. This node now does the same:

```
KeyError: 'missing' (line 3)
```

```
TypeError: Object of type set is not JSON serializable
when serializing dict item 'payload'
```

- The entry is the exception and where in the function it happened — `(line N)`, or
  `(line N, col M)` for code that does not compile — and, if the interpreter died, how it ended.
- The whole traceback goes to the Node-RED log, and to a Catch node as `msg.error.stack`.
- The author's code is no longer pasted into the wrapper script. It is passed to Python as an
  argument and compiled as a file of its own, `Function node`, so a traceback reads
  `File "Function node", line 3, in down` and quotes the author's line.

### 8 · A failure never stops the node; only code that cannot load does

Upstream restarted a crashed interpreter ten times, then stopped the node with `Function '…' has
failed more than 10 times. Fix it and deploy again`. The count never reset, so ten mistakes spread
over a week stopped a node as surely as ten in a row. The built-in Function node has nothing like
it: a thrown error kills nothing.

- Returning something JSON cannot hold — a `set`, a `datetime`, `bytes` — is now an error like a
  `raise`: one entry, catchable, and the interpreter stays up. It used to kill it. So does
  `sys.exit()`, which used to end the interpreter without a word.
- What still ends it is what Python cannot catch: `os._exit()`, a crash inside a C extension, or
  something outside killing it. That is one entry — `Python Function process exited with code 3,
  and was restarted`, or `was killed (SIGKILL)` — and a fresh interpreter, every time. There is
  no limit, because there is no loop to break: a fresh interpreter only waits for the next
  message, so it cannot crash again on its own.
- Code that cannot load is the one case that stops the node until the next deploy (§6): a
  respawn would run the same code and fail the same way, straight away.

## Unchanged from upstream

Multiple outputs, `node.send` / `log` / `warn` / `error` / `status`, and the restoration of the live
`req` / `res` objects onto the outgoing message all work as they did.

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

| | |
|---|---|
| Linux | Node-RED 4.1.14 and 5.0.6 · Node 24.14.1 · Python 3.14.7 |
| Windows Server 2022 | Node-RED 4.1.14 and 5.0.6 · Node 24.20.0 · Python 3.13.0 (no `python3.exe`) |

On Windows, both Node-RED versions: the dialog opens with the code in it, an edit saves and reads
back, and a deployed flow ran Python end to end — `flow` and `global_ctx` round trips included,
which is the path that blocks waiting on the IPC channel.

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

Five of them, and **all have to be run on Windows as well as on a POSIX box** — that is the
point of them:

| | |
|---|---|
| `test/catch_test.js` | which failures reach a Catch node: `node.error` with and without `msg`, a `raise`, and an error nobody raised on purpose — and that the interpreter survives the last two |
| `test/debug_messages_test.js` | one failure is one short entry in the debug sidebar, shaped like the built-in node's: a return value JSON cannot hold (an error like a raise, catchable, the traceback in the log), a `raise`, one from deep in a call stack (the line numbers are the editor's), a function that only writes to stderr, one that writes to it without pause, code that cannot load, no colour codes under `FORCE_COLOR`, and crashes Python cannot catch — twelve in a row, a kill from outside — each reported once and restarted, never stopping the node |
| `test/interpreter_test.js` | the interpreter lookup, and the two paths that used to throw when there was no interpreter — a message arriving and the flow stopping. Platform-independent, so a POSIX machine tests the Windows failure mode |
| `test/channel_test.py` | the framing itself, read out of `lib/` rather than copied so it cannot drift. It forces the framed and unframed paths on, so a POSIX machine can test the Windows one — including a captured Windows frame, a payload whose length puts a newline inside the header, a frame split across reads, two frames in one write, and an impossible length |

Node's `ipc` channel frames every message on Windows and does not on POSIX, so a change here
passing on one platform says nothing about the other. That asymmetry is what let a crash on
every single message ship: `UnicodeDecodeError: 'utf-32-le' codec can't decode bytes`, on the
first message a node received, before the user's function ran.

`npm test` runs `python3`, which is what the node itself spawns (see §3 above).

## Licence

MIT, as upstream. Original copyright Arnau Orriols.

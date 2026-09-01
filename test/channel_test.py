#!/usr/bin/env python3
"""Unit-test the IPC channel's framing, both platforms, from one place.

The class under test is read out of `lib/node-red-python-function.js` rather than copied, so
this cannot drift from the code that actually ships. `framed` is forced on and off here: a
POSIX box can therefore test the Windows path, which is the whole reason the Windows bug
reached a cohort unnoticed.
"""
import json
import os
import re
import struct
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, os.pardir, "lib", "node-red-python-function.js")

src = open(SRC).read()
# End the slice at whatever follows the class, rather than at one particular line: the Python 2
# branch this used to key on is exactly the kind of thing a later change deletes, and then the
# test fails to find its own subject instead of failing honestly.
_tail = src[src.index("class _Channel"):]
_cls = re.split(r"\n(?=channel\s*=|if sys\.version_info)", _tail, maxsplit=1)[0]
# The class is executed on its own, so hand it the modules the module around it imports.
_ns = {"os": os, "json": json, "sys": sys, "struct": struct}
exec(_cls, _ns)
Channel = _ns["_Channel"]

TYPE_DATA = 1
HEADER = 16


def frame(payload, typ=TYPE_DATA):
    """A message as Node's IPC pipe writes it on Windows."""
    return typ.to_bytes(8, "little") + len(payload).to_bytes(8, "little") + payload


def reader(data, framed, close=True):
    r, w = os.pipe()
    os.write(w, data)
    if close:
        os.close(w)
    return Channel(os.fdopen(r, "rb", buffering=0), framed)


def writer(framed):
    r, w = os.pipe()
    return Channel(os.fdopen(w, "wb", buffering=0), framed), r


class Checks(object):
    def __init__(self):
        self.passed = self.failed = 0

    def __call__(self, name, got, want):
        if got == want:
            self.passed += 1
            print("  PASS  %s" % name)
        else:
            self.failed += 1
            print("  FAIL  %s\n          got  %r\n          want %r" % (name, got, want))


check = Checks()

print("Windows: framed reads")
# The bytes a student captured off fd 3 on Windows 11 / Node 22, which is what started this.
CAPTURED = (b"\x01\x00\x00\x00\x00\x00\x00\x00!\x00\x00\x00\x00\x00\x00\x00"
            b'{"payload":"hello","_msgid":"1"}\n')
line = reader(CAPTURED, True).readline()
check("a captured Windows frame yields the JSON line", line,
      b'{"payload":"hello","_msgid":"1"}\n')
check("and it parses", json.loads(line), {"payload": "hello", "_msgid": "1"})

# A 10-byte payload puts 0x0a in the length field, so the header itself contains a newline.
# Anything that reads the header with readline() truncates here.
tiny = b'{"a":123}\n'
assert len(tiny) == 10 and b"\x0a" in frame(tiny)[:HEADER]
check("a newline inside the header does not truncate it",
      reader(frame(tiny), True).readline(), tiny)

check("two frames in one write are read one at a time",
      [reader(frame(b'{"n":1}\n') + frame(b'{"n":2}\n'), True).readline()],
      [b'{"n":1}\n'])
c = reader(frame(b'{"n":1}\n') + frame(b'{"n":2}\n'), True)
c.readline()
check("  and the second one follows", c.readline(), b'{"n":2}\n')

# A frame split across reads: the header arrives, the payload comes later.
r, w = os.pipe()
c = Channel(os.fdopen(r, "rb", buffering=0), True)
f = frame(b'{"payload":"split"}\n')
os.write(w, f[:9])
threading.Timer(0.05, lambda: (os.write(w, f[9:]), os.close(w))).start()
check("a frame split mid-header is reassembled", c.readline(), b'{"payload":"split"}\n')

check("EOF part-way through a header reads as EOF",
      reader(b"\x01\x00\x00\x00\x00\x00\x00\x00", True).readline(), b"")
check("EOF with nothing at all reads as EOF", reader(b"", True).readline(), b"")

# A length that cannot be real means the channel is out of step with the framing. Without a
# bound this asks read() for terabytes and the process dies with MemoryError, taking one of the
# node's ten respawn attempts with it and explaining nothing.
huge = (1).to_bytes(8, "little") + (2 ** 62).to_bytes(8, "little")
try:
    reader(huge, True).readline()
    outcome = "no error"
except RuntimeError:
    outcome = "refused"
except MemoryError:
    outcome = "MemoryError"
check("an impossible frame length is refused, not allocated", outcome, "refused")

print("\nWindows: framed writes")
c, r = writer(True)
c.write(b'{"ctx":"send"}\n')
check("a write is framed with the type and the length",
      os.read(r, 4096), frame(b'{"ctx":"send"}\n'))

print("\nPOSIX: unchanged, in both directions")
c = reader(b'{"payload":"one"}\n{"payload":"two"}\n', False)
check("plain newline-delimited reads, first", c.readline(), b'{"payload":"one"}\n')
check("plain newline-delimited reads, second", c.readline(), b'{"payload":"two"}\n')
c, r = writer(False)
c.write(b'{"x":1}\n')
check("a write carries no header", os.read(r, 4096), b'{"x":1}\n')

print("\n%d passed, %d failed" % (check.passed, check.failed))
sys.exit(1 if check.failed else 0)

"""dev/qt-scroll-fixture.pyw -- a REAL Qt scroll container, for measuring posted wheel messages.

WHY
  R27 made the auto long screenshot POST WM_MOUSEWHEEL at the target instead of moving the real
  cursor. R29 measured that the message must go to the LEAF control, not the top-level window,
  and proved it on WinForms (TextBox first-visible-line 0 -> 3) and Chromium (scrollTop 180 ->
  349.6). Qt was never measured -- and Qt is the one desktop toolkit whose wheel routing is
  genuinely different (QApplication delivers the event to the widget under the CURSOR, so a posted
  message may be ignored or misrouted).

WHAT IT IS
  A QMainWindow with a 400-row QListWidget. One window, one scrollbar, and -- crucially -- it
  LOGS ITS OWN SCROLLBAR VALUE. That log is the ground truth: "did it scroll" is a number, not an
  opinion about pixels.

RUN (from the host; a sandboxed shell cannot even show this window):
  python dev/qt-scroll-fixture.pyw --x 60 --y 60 --w 420 --h 320 --log <path> --info <path>

ASCII ONLY: the console is GBK.
"""

import json
import os
import sys

from PyQt5 import QtCore, QtWidgets


def arg(name, default):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


X = int(arg("--x", "60"))
Y = int(arg("--y", "60"))
W = int(arg("--w", "420"))
H = int(arg("--h", "320"))
LOG = arg("--log", os.path.join(os.environ.get("TEMP", "."), "qt-scroll.log"))
INFO = arg("--info", "")
SECONDS = int(arg("--seconds", "60"))

with open(LOG, "w", encoding="utf-8") as f:
    f.write("start\n")


def log(line):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


app = QtWidgets.QApplication(sys.argv)

win = QtWidgets.QMainWindow()
win.setWindowTitle("DSH-QT-SCROLL")

items = QtWidgets.QListWidget()
items.setFont(QtWidgets.QListWidget().font())
font = items.font()
font.setPointSize(14)
items.setFont(font)
for i in range(1, 401):
    items.addItem("ITEM %03d ----------------------------" % i)
win.setCentralWidget(items)

# Topmost so the probe can see it even with other windows around (the WinForms fixture does the
# same for the same reason: a covered fixture answers "nothing scrolled" about the occluder).
win.setWindowFlag(QtCore.Qt.WindowStaysOnTopHint, True)
win.setGeometry(X, Y, W, H)

bar = items.verticalScrollBar()
bar.valueChanged.connect(lambda v: log("value=%d" % v))


def write_info():
    try:
        local = items.viewport().rect().center()
        g = items.viewport().mapToGlobal(local)
        payload = {
            "ok": True,
            "pid": os.getpid(),
            "toolkit": "qt",
            "qt": QtCore.QT_VERSION_STR,
            "x": win.x(),
            "y": win.y(),
            "w": win.width(),
            "h": win.height(),
            "cx": g.x(),
            "cy": g.y(),
            "value": bar.value(),
            # The probe resolves the window through ps/windows.ps1 (visible + titled + not a tool
            # window). Reporting the native handle makes "the fixture is up but the probe cannot
            # see it" a diagnosable state instead of a mystery.
            "hwnd": int(win.winId()),
            "visible": bool(win.isVisible()),
            "minimized": bool(win.isMinimized()),
            "state": int(win.windowState()),
            "frame": [win.frameGeometry().x(), win.frameGeometry().y(), win.frameGeometry().width(), win.frameGeometry().height()],
            "flags": int(win.windowFlags()),
        }
        if INFO:
            with open(INFO, "w", encoding="utf-8") as f:
                json.dump(payload, f)
        log("shown " + json.dumps(payload))
    except Exception as exc:  # never let the fixture die silently
        log("info-error " + repr(exc))


qt_raise = lambda: (win.raise_(), win.activateWindow())
QtCore.QTimer.singleShot(250, qt_raise)
QtCore.QTimer.singleShot(400, write_info)
QtCore.QTimer.singleShot(SECONDS * 1000, app.quit)

win.show()
app.exec_()

# DSH screenshot plugin - global hotkey daemon.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File hotkey.ps1 `
#       -Out <events.jsonl> [-Keys "ctrl+alt+a=shot,ctrl+alt+o=ocr"] [-FocusTitle "DeepSeek Harness"]
#
# Why a separate long-lived process instead of Electron's globalShortcut:
#   * RegisterHotKey is a plain Win32 API - it works from ANY process, at any integrity level,
#     with no Electron involvement. Whether the plugin host half can `import('electron')` is
#     not something we control, so the fallback has to exist anyway; making it the ONLY path
#     means one mechanism and one failure mode.
#   * It also lets us raise the DSH window (SetForegroundWindow) from the same process that saw
#     the key - the only moment where the Win10+ foreground-activation rules actually allow it.
#
# !! Design rule learned here: the message loop and the JSON writer BOTH live in the compiled
#    C# class. The first draft called back into a PowerShell scriptblock from inside the native
#    loop; that is re-entrant runspace use and is not something to bet a hotkey on. PowerShell
#    now only parses arguments, calls Run(), and reports the exit code.
#
# Output protocol: one compact JSON object per line, written and flushed immediately:
#   {"ok":true,"stage":"register","key":"ctrl+alt+a","action":"shot","id":1}
#   {"ok":true,"stage":"fire","key":"ctrl+alt+a","action":"shot","id":1,"focused":true,"at":"..."}
#   {"ok":false,"stage":"register","key":"ctrl+alt+a","error":"already taken","win32":1409}
# The Node host tails this file. Nothing but the final summary goes to stdout: a daemon's stdout
# is a pipe nobody drains, and it would eventually block on a full buffer.
#
# ASCII only: the console is GBK and Windows PowerShell 5.1 mis-decodes BOM-less UTF-8.

param(
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Keys = 'shot=ctrl+alt+x|ctrl+alt+shift+x,ocr=ctrl+alt+o,translate=ctrl+alt+f,scroll=ctrl+alt+l',
  [string]$FocusTitle = 'DeepSeek Harness',
  # Safety net only - the Node host kills this process on plugin unload. A hotkey daemon that
  # outlives its host keeps swallowing the user's keystrokes, which is worse than not having one.
  [int]$MaxMinutes = 720,
  # The host's pid. If the host dies WITHOUT running its dispose (task manager kill, crash),
  # child.kill() never happens and this daemon would keep swallowing the user's keys for up to
  # MaxMinutes. Watching the parent turns "up to 12 hours" into "up to ~2 seconds".
  [int]$ParentPid = 0,
  # Register, report, exit. Used by the self-test and by "which of my candidates are free?".
  [switch]$ProbeOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not ('DshHotkey' -as [type])) {
  Add-Type @"
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class DshHotkey {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG lpMsg);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG lpMsg);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();
  // Parent-liveness check. WaitForSingleObject(handle, 0) returns WAIT_OBJECT_0 (0) once the
  // process has exited, and it does not allocate or throw - unlike Process.GetProcessById.
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  const uint SYNCHRONIZE = 0x00100000;
  const uint WAIT_OBJECT_0 = 0;
  static IntPtr parentHandle = IntPtr.Zero;
  // True when the parent is gone (or when we never had a handle to it in the first place).
  public static bool ParentGone(int pid) {
    if (pid <= 0) return false;
    if (parentHandle == IntPtr.Zero) {
      parentHandle = OpenProcess(SYNCHRONIZE, false, pid);
      if (parentHandle == IntPtr.Zero) return true;   // cannot even open it -> already gone
    }
    return WaitForSingleObject(parentHandle, 0) == WAIT_OBJECT_0;
  }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  public const int WM_HOTKEY = 0x0312;
  public const uint PM_REMOVE = 0x0001;
  public const uint MOD_ALT = 0x0001, MOD_CONTROL = 0x0002, MOD_SHIFT = 0x0004, MOD_WIN = 0x0008;
  public const uint MOD_NOREPEAT = 0x4000;

  [StructLayout(LayoutKind.Sequential)] public struct MSG {
    public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
    public uint time; public int ptX; public int ptY; public uint lPrivate;
  }

  static StreamWriter log;

  public static string Esc(string s) {
    if (s == null) return "";
    var b = new StringBuilder();
    foreach (char c in s) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < ' ') b.Append(' ');
      else b.Append(c);
    }
    return b.ToString();
  }

  static void Emit(string json) {
    try { if (log != null) log.WriteLine(json); } catch { }
  }

  static int ResolveVk(string n) {
    n = n.Trim().ToLowerInvariant();
    if (n.Length == 1) {
      char c = char.ToUpperInvariant(n[0]);
      if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z')) return (int)c;
    }
    if (n.Length >= 2 && n[0] == 'f') {
      int num;
      if (int.TryParse(n.Substring(1), out num) && num >= 1 && num <= 24) return 0x6F + num;
    }
    switch (n) {
      case "space": return 0x20;
      case "printscreen": return 0x2C;
      case "insert": return 0x2D;
      case "home": return 0x24;
      case "end": return 0x23;
      case "pagedown": return 0x22;
      case "pageup": return 0x21;
      case "delete": return 0x2E;
      case "tab": return 0x09;
      default: return 0;
    }
  }

  public static IntPtr FindByTitle(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, sb.Capacity);
      string t = sb.ToString();
      if (t.Length > 0 && t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // AttachThreadInput is the standard workaround for the Win10+ rule that SetForegroundWindow
  // is a silent no-op for a process the user did not just interact with.
  public static bool Activate(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    try {
      if (IsIconic(h)) ShowWindow(h, 9);
      uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
      uint myThread = GetCurrentThreadId();
      bool attached = false;
      if (fgThread != myThread) attached = AttachThreadInput(fgThread, myThread, true);
      try {
        BringWindowToTop(h);
        return SetForegroundWindow(h);
      } finally {
        if (attached) AttachThreadInput(fgThread, myThread, false);
      }
    } catch { return false; }
  }

  // spec: "shot=ctrl+alt+x|ctrl+alt+shift+x,ocr=ctrl+alt+o,translate=ctrl+alt+f"
  //
  // Each action may list SEVERAL candidate chords, separated by '|', tried left to right.
  // Why this exists: Ctrl+Alt+A - the chord everyone reaches for first, because QQ uses it -
  // is *already taken* on a machine with QQ running, and RegisterHotKey then fails with
  // win32 1409. Silently losing the flagship hotkey would look exactly like "the feature does
  // not work", so the daemon walks the candidate list and reports which one it actually got.
  // Candidate lists must not share chords across actions: the first action to claim one wins.
  public static int Run(string outPath, string spec, string focusTitle, int maxMs, bool probeOnly, int parentPid) {
    // FileShare.ReadWrite, not the StreamWriter(string,bool,Encoding) default (FileShare.Read).
    // Two reasons, both measured:
    //   1. the host reads this file while we are appending to it - that already worked, but
    //      only by luck of the default; making it explicit means a future .NET change cannot
    //      silently start failing every read.
    //   2. the self-test injects a synthetic {"stage":"fire"} line to prove the Node half's
    //      callback wiring. With FileShare.Read that write is denied (EBUSY) and the only way
    //      to exercise the fire path would be a human pressing the key.
    var fs = new FileStream(outPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
    log = new StreamWriter(fs, new UTF8Encoding(false));
    log.AutoFlush = true;

    var ids = new List<int>();
    var keys = new List<string>();
    var acts = new List<string>();
    int next = 1;

    string[] chunks = spec.Split(',');
    foreach (string raw in chunks) {
      string item = raw.Trim();
      if (item.Length == 0) continue;
      string action = "shot";
      int eq = item.IndexOf('=');
      if (eq >= 0) { action = item.Substring(0, eq).Trim(); item = item.Substring(eq + 1).Trim(); }
      if (action.Length == 0) action = "shot";

      bool claimed = false;
      string[] candidates = item.Split('|');
      foreach (string candRaw in candidates) {
        string cand = candRaw.Trim();
        if (cand.Length == 0) continue;

        uint mods = 0; int vk = 0; string bad = "";
        foreach (string tokRaw in cand.Split('+')) {
          string tok = tokRaw.Trim().ToLowerInvariant();
          if (tok.Length == 0) continue;
          if (tok == "ctrl" || tok == "control") mods |= MOD_CONTROL;
          else if (tok == "alt") mods |= MOD_ALT;
          else if (tok == "shift") mods |= MOD_SHIFT;
          else if (tok == "win" || tok == "meta") mods |= MOD_WIN;
          else { int v = ResolveVk(tok); if (v == 0) bad = tok; else vk = v; }
        }
        if (bad.Length > 0 || vk == 0) {
          Emit("{\"ok\":false,\"stage\":\"parse\",\"key\":\"" + Esc(cand) + "\",\"action\":\"" + Esc(action) + "\",\"error\":\"unsupported key token: " + Esc(bad) + "\"}");
          continue;
        }
        int id = next++;
        if (RegisterHotKey(IntPtr.Zero, id, mods | MOD_NOREPEAT, (uint)vk)) {
          ids.Add(id); keys.Add(cand); acts.Add(action);
          Emit("{\"ok\":true,\"stage\":\"register\",\"key\":\"" + Esc(cand) + "\",\"action\":\"" + Esc(action) + "\",\"id\":" + id + "}");
          claimed = true;
          break;                                  // first free candidate wins for this action
        }
        int code = Marshal.GetLastWin32Error();
        Emit("{\"ok\":false,\"stage\":\"register\",\"key\":\"" + Esc(cand) + "\",\"action\":\"" + Esc(action) + "\",\"error\":\"RegisterHotKey failed (already taken by another app?)\",\"win32\":" + code + "}");
      }
      if (!claimed) {
        Emit("{\"ok\":false,\"stage\":\"exhausted\",\"action\":\"" + Esc(action) + "\",\"error\":\"every candidate chord for this action is taken\"}");
      }
    }
    Emit("{\"ok\":true,\"stage\":\"ready\",\"count\":" + ids.Count + "}");

    if (probeOnly) {
      foreach (int id in ids) { try { UnregisterHotKey(IntPtr.Zero, id); } catch { } }
      Emit("{\"ok\":true,\"stage\":\"stopped\",\"probeOnly\":true}");
      log.Dispose(); log = null;
      return ids.Count > 0 ? 0 : 2;
    }

    if (ids.Count == 0) {
      Emit("{\"ok\":false,\"stage\":\"fatal\",\"error\":\"no hotkey could be registered\"}");
      log.Dispose(); log = null;
      return 2;
    }

    var lastFire = new Dictionary<int, uint>();
    uint start = GetTickCount();
    bool stop = false;
    bool parentGone = false;
    int ticks = 0;
    try {
      while (!stop) {
        MSG msg;
        while (PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE)) {
          if (msg.message == WM_HOTKEY) {
            int hid = (int)msg.wParam;
            int idx = ids.IndexOf(hid);
            if (idx < 0) continue;
            uint now = GetTickCount();
            uint prev;
            if (lastFire.TryGetValue(hid, out prev) && (now - prev) < 350) continue;
            lastFire[hid] = now;
            bool focused = false;
            if (focusTitle.Length > 0) {
              try { focused = Activate(FindByTitle(focusTitle)); } catch { }
            }
            Emit("{\"ok\":true,\"stage\":\"fire\",\"key\":\"" + Esc(keys[idx]) + "\",\"action\":\"" + Esc(acts[idx]) +
                 "\",\"id\":" + hid + ",\"focused\":" + (focused ? "true" : "false") +
                 ",\"at\":\"" + DateTime.UtcNow.ToString("o") + "\"}");
            continue;
          }
          TranslateMessage(ref msg);
          DispatchMessage(ref msg);
        }
        if (maxMs > 0 && (GetTickCount() - start) > (uint)maxMs) stop = true;
        // Check the parent roughly every 2 seconds. A daemon that outlives its host keeps
        // swallowing the user's keystrokes even though the plugin it belonged to is gone.
        if (++ticks >= 40) {
          ticks = 0;
          if (ParentGone(parentPid)) {
            parentGone = true;
            Emit("{\"ok\":true,\"stage\":\"parent-gone\",\"pid\":" + parentPid + ",\"at\":\"" + DateTime.UtcNow.ToString("o") + "\"}");
            stop = true;
          }
        }
        System.Threading.Thread.Sleep(50);
      }
    } finally {
      foreach (int id in ids) { try { UnregisterHotKey(IntPtr.Zero, id); } catch { } }
      Emit("{\"ok\":true,\"stage\":\"stopped\"" + (parentGone ? ",\"reason\":\"parent-gone\"" : "") + ",\"at\":\"" + DateTime.UtcNow.ToString("o") + "\"}");
      log.Dispose(); log = null;
    }
    return 0;
  }
}
"@
}

$outPath = [System.IO.Path]::GetFullPath($Out)
$outDir = [System.IO.Path]::GetDirectoryName($outPath)
if (-not [System.IO.Directory]::Exists($outDir)) { [System.IO.Directory]::CreateDirectory($outDir) | Out-Null }

$code = [DshHotkey]::Run($outPath, $Keys, $FocusTitle, ($MaxMinutes * 60 * 1000), [bool]$ProbeOnly, $ParentPid)
Write-Output ("hotkey daemon exited with " + $code)
exit $code

import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const WS_PORT = 8038;
const RETRY_DELAYS = [1000, 2000, 5000, 10000];

function modePill(mode) {
  switch (mode) {
    case "watching":      return { label: "Watching · read-only", cls: "tp-pill tp-pill-watch" };
    case "interactive":   return { label: "Interactive · live", cls: "tp-pill tp-pill-interactive" };
    case "locked-by-other": return { label: "Locked by another tab", cls: "tp-pill tp-pill-locked" };
    case "acquiring":     return { label: "Connecting…", cls: "tp-pill tp-pill-busy" };
    case "stopping":      return { label: "Stopping…", cls: "tp-pill tp-pill-busy" };
    case "disconnected":  return { label: "Disconnected", cls: "tp-pill tp-pill-disconnected" };
    default:              return { label: mode, cls: "tp-pill" };
  }
}

export default function TerminalPanel({ project }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const modeRef = useRef("disconnected");
  const retryCount = useRef(0);
  const retryTimer = useRef(null);

  const [mode, setMode] = useState("disconnected");
  const [controlHolder, setControlHolder] = useState(null);
  const [taskInput, setTaskInput] = useState("");
  const [stopConfirming, setStopConfirming] = useState(false);
  const [fallback, setFallback] = useState(null); // { stateFile }
  const [fallbackNotes, setFallbackNotes] = useState("");
  const [savingFallback, setSavingFallback] = useState(false);

  const updateMode = useCallback((m) => {
    modeRef.current = m;
    setMode(m);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.hostname}:${WS_PORT}/api/projects/${project.id}/terminal`);
    wsRef.current = ws;

    ws.onopen = () => {
      retryCount.current = 0;
      updateMode("watching");
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      switch (msg.type) {
        case "scrollback":
        case "output":
          termRef.current?.write(msg.data);
          break;
        case "state":
          updateMode(msg.mode);
          setControlHolder(msg.controlHolder ?? null);
          break;
        case "error":
          termRef.current?.writeln(`\r\n\x1b[31m[Dashboard] ${msg.message}\x1b[0m`);
          if (msg.fallback) {
            // od-stop timed out — this state comes from the REST call, not WS
          }
          break;
        case "idle_warning":
          termRef.current?.writeln(`\r\n\x1b[33m[Dashboard] Idle — auto-release in ${msg.secondsLeft}s\x1b[0m`);
          break;
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;
      }
    };

    ws.onclose = () => {
      updateMode("disconnected");
      const delay = RETRY_DELAYS[Math.min(retryCount.current, RETRY_DELAYS.length - 1)];
      retryCount.current++;
      retryTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {};
  }, [project.id, updateMode]);

  // Mount terminal once
  useEffect(() => {
    const term = new Terminal({
      theme: {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#58a6ff",
        selectionBackground: "rgba(88,166,255,0.3)",
        black: "#484f58", brightBlack: "#6e7681",
        red: "#ff7b72",    brightRed: "#ffa198",
        green: "#3fb950",  brightGreen: "#56d364",
        yellow: "#d29922", brightYellow: "#e3b341",
        blue: "#58a6ff",   brightBlue: "#79c0ff",
        magenta: "#bc8cff",brightMagenta: "#d2a8ff",
        cyan: "#39c5cf",   brightCyan: "#56d4dd",
        white: "#b1bac4",  brightWhite: "#f0f6fc",
      },
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'SF Mono', monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // Route input only when interactive
    const d = term.onData((data) => {
      if (modeRef.current === "interactive") {
        wsRef.current?.send(JSON.stringify({ type: "input", data }));
      }
    });

    return () => {
      d.dispose();
      term.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Connect WS on mount, disconnect on unmount
  useEffect(() => {
    connect();
    return () => {
      clearTimeout(retryTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // ResizeObserver — refit on container size change
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return;
      try {
        fitRef.current.fit();
        const { cols, rows } = termRef.current;
        wsRef.current?.send(JSON.stringify({ type: "resize", cols, rows }));
      } catch {}
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  async function handleTakeControl() {
    updateMode("acquiring");
    try {
      const res = await fetch(`/api/projects/${project.id}/terminal/take-control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(taskInput ? { task: taskInput } : {})
      });
      if (res.ok) {
        wsRef.current?.send(JSON.stringify({ type: "claim-control" }));
        // Mode is updated via the WS state message after claim-control
      } else {
        const d = await res.json();
        updateMode(res.status === 409 ? "locked-by-other" : "watching");
        if (d.controlHolder) setControlHolder(d.controlHolder);
        termRef.current?.writeln(`\r\n\x1b[31m[Dashboard] ${d.error || "Take control failed"}\x1b[0m`);
      }
    } catch {
      updateMode("watching");
    }
  }

  async function handleRelease() {
    await fetch(`/api/projects/${project.id}/terminal/release-control`, { method: "POST" });
    // Mode will update via WS
  }

  async function handleStopConfirm() {
    setStopConfirming(false);
    updateMode("stopping");
    try {
      const res = await fetch(`/api/projects/${project.id}/terminal/send-od-stop`, { method: "POST" });
      const d = await res.json();
      if (!d.ok && d.fallback) {
        setFallback({ stateFile: d.stateFile });
        updateMode("interactive"); // stay interactive until fallback resolved
      }
      // Success: WS broadcasts the new "watching" state
    } catch {
      updateMode("interactive");
    }
  }

  async function handleLocalStop() {
    setSavingFallback(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/terminal/stop-local`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: fallbackNotes })
      });
      if (res.ok) {
        setFallback(null);
        setFallbackNotes("");
        // Release control
        await fetch(`/api/projects/${project.id}/terminal/release-control`, { method: "POST" });
      }
    } catch {}
    setSavingFallback(false);
  }

  const pill = modePill(mode);
  const idleSec = controlHolder?.idleSec ?? 0;
  const idleMin = Math.floor(idleSec / 60);
  const idleS = idleSec % 60;
  const idleLabel = `${idleMin}:${String(idleS).padStart(2, "0")}`;

  return (
    <div className="terminal-panel">
      <div className="tp-header">
        <span className={pill.cls}>{pill.label}</span>
        {mode === "interactive" && (
          <span className="tp-idle-badge" title="Time since last keystroke">
            idle {idleLabel}
          </span>
        )}
        <div className="tp-actions">
          {mode === "watching" && (
            <div className="tp-take-row">
              <input
                className="tp-task-input"
                placeholder="Task description (optional)"
                value={taskInput}
                onChange={e => setTaskInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleTakeControl()}
              />
              <button className="tp-btn tp-btn-take" onClick={handleTakeControl}>
                Take Control
              </button>
            </div>
          )}
          {mode === "locked-by-other" && (
            <span className="tp-locked-hint">
              Taken {controlHolder?.takenAt ? new Date(controlHolder.takenAt).toLocaleTimeString() : ""}
            </span>
          )}
          {mode === "interactive" && !stopConfirming && !fallback && (
            <>
              <button className="tp-btn tp-btn-release" onClick={handleRelease} title="Release without stopping timer">
                Release
              </button>
              <button className="tp-btn tp-btn-stop" onClick={() => setStopConfirming(true)}>
                Stop &amp; Exit
              </button>
            </>
          )}
          {mode === "stopping" && (
            <span className="tp-busy-hint">Waiting for /od-stop…</span>
          )}
        </div>
      </div>

      {stopConfirming && (
        <div className="tp-confirm-bar">
          <span>Run <code>/od-stop</code> in the Claude session and release control?</span>
          <button className="tp-btn tp-btn-stop" onClick={handleStopConfirm}>Confirm</button>
          <button className="tp-btn tp-btn-cancel" onClick={() => setStopConfirming(false)}>Cancel</button>
        </div>
      )}

      {fallback && (
        <div className="tp-fallback">
          <p className="tp-fallback-title">
            <strong>/od-stop timed out.</strong> Enter notes manually to close the timer:
          </p>
          <textarea
            className="tp-fallback-notes"
            rows={5}
            placeholder="What happened during this session? (one line per bullet)"
            value={fallbackNotes}
            onChange={e => setFallbackNotes(e.target.value)}
          />
          <div className="tp-fallback-actions">
            <button
              className="tp-btn tp-btn-stop"
              disabled={savingFallback || !fallbackNotes.trim()}
              onClick={handleLocalStop}
            >
              {savingFallback ? "Saving…" : "Stop timer locally"}
            </button>
            <button className="tp-btn tp-btn-cancel" onClick={() => setFallback(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="tp-xterm-wrap" ref={containerRef} />
    </div>
  );
}

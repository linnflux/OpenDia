import { useState, useEffect, useRef, useMemo } from "react";

const BG_STORAGE_KEY = "opendia-bg-image";
const BG_POSITION_KEY = "opendia-bg-position";

function getActions({ onRefresh, onUploadBg, onClearBg, onReposition, hasBg, themes, currentTheme, onSetTheme, onOpenAnalytics, isAdmin, onOpenBilling, onOpenNewsletter }) {
  return [
    { id: "refresh", icon: "\u21BB", label: "Refresh Board", shortcut: "R", action: onRefresh },
    ...themes.map((t) => ({
      id: `theme-${t.name}`,
      icon: t.name === currentTheme ? "\u25C9" : "\u25D0",
      label: `Theme: ${t.label}`,
      action: () => onSetTheme(t.name),
    })),
    { id: "analytics", icon: "\u{1F4CA}", label: "Open Analytics", action: onOpenAnalytics },
    ...(isAdmin ? [
      { id: "billing", icon: "\u{1F4B0}", label: "Open Billing", action: onOpenBilling },
      { id: "newsletter", icon: "\u{1F4F0}", label: "Open Newsletter", action: onOpenNewsletter },
    ] : []),
    { id: "upload-bg", icon: "\u{1F5BC}", label: "Upload Background Image", action: onUploadBg },
    ...(hasBg
      ? [
          { id: "reposition-bg", icon: "\u2316", label: "Reposition Background Image", action: onReposition },
          { id: "clear-bg", icon: "\u2715", label: "Remove Background Image", action: onClearBg },
        ]
      : []),
  ];
}

export default function CommandPalette({ open, onClose, onRefresh, projects, companies, onSelectProject, onSelectCompany, theme, themes, onSetTheme, onOpenAnalytics, isAdmin, onOpenBilling, onOpenNewsletter }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const [bgImage, setBgImage] = useState(() => localStorage.getItem(BG_STORAGE_KEY));
  const [bgPosition, setBgPosition] = useState(() => localStorage.getItem(BG_POSITION_KEY) || "center");
  const [repositionMode, setRepositionMode] = useState(false);
  const origPosRef = useRef(null);

  // Apply background image to body
  useEffect(() => {
    if (bgImage) {
      document.body.style.backgroundImage = `url(${bgImage})`;
      document.body.style.backgroundSize = "cover";
      document.body.style.backgroundPosition = bgPosition;
      document.body.style.backgroundAttachment = "fixed";
      document.body.classList.add("has-bg");
    } else {
      document.body.style.backgroundImage = "";
      document.body.style.backgroundSize = "";
      document.body.style.backgroundPosition = "";
      document.body.style.backgroundAttachment = "";
      document.body.classList.remove("has-bg");
    }
  }, [bgImage, bgPosition]);

  // Load background on mount (even when palette is closed)
  useEffect(() => {
    const saved = localStorage.getItem(BG_STORAGE_KEY);
    if (saved) setBgImage(saved);
  }, []);

  function handleUploadBg() {
    onClose();
    // Small delay so the palette closes before the file dialog opens
    setTimeout(() => fileRef.current?.click(), 100);
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      localStorage.setItem(BG_STORAGE_KEY, dataUrl);
      setBgImage(dataUrl);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function handleClearBg() {
    localStorage.removeItem(BG_STORAGE_KEY);
    localStorage.removeItem(BG_POSITION_KEY);
    setBgImage(null);
    setBgPosition("center");
    onClose();
  }

  function handleStartReposition() {
    origPosRef.current = bgPosition;
    setRepositionMode(true);
    onClose();
  }

  function handleRepositionMouseMove(e) {
    const x = Math.round((e.clientX / window.innerWidth) * 100);
    const y = Math.round((e.clientY / window.innerHeight) * 100);
    document.body.style.backgroundPosition = `${x}% ${y}%`;
  }

  function handleRepositionClick(e) {
    const x = Math.round((e.clientX / window.innerWidth) * 100);
    const y = Math.round((e.clientY / window.innerHeight) * 100);
    const pos = `${x}% ${y}%`;
    localStorage.setItem(BG_POSITION_KEY, pos);
    setBgPosition(pos);
    setRepositionMode(false);
  }

  function handleRepositionCancel() {
    document.body.style.backgroundPosition = origPosRef.current || "center";
    setBgPosition(origPosRef.current || "center");
    setRepositionMode(false);
  }

  const actions = useMemo(
    () => getActions({
      onRefresh: () => { onRefresh(); onClose(); },
      onUploadBg: handleUploadBg,
      onClearBg: handleClearBg,
      onReposition: handleStartReposition,
      hasBg: !!bgImage,
      themes,
      currentTheme: theme,
      onSetTheme: (name) => { onSetTheme(name); onClose(); },
      onOpenAnalytics: () => { onOpenAnalytics?.(); onClose(); },
      isAdmin,
      onOpenBilling: () => { onOpenBilling?.(); onClose(); },
      onOpenNewsletter: () => { onOpenNewsletter?.(); onClose(); },
    }),
    [bgImage, bgPosition, onRefresh, onClose, themes, theme, onSetTheme, onOpenAnalytics, isAdmin, onOpenBilling, onOpenNewsletter]
  );

  const filteredActions = useMemo(() => {
    if (!query) return actions;
    const q = query.toLowerCase();
    return actions.filter((a) => a.label.toLowerCase().includes(q));
  }, [query, actions]);

  const filteredProjects = useMemo(() => {
    if (!query || !projects) return [];
    const q = query.toLowerCase();
    const scored = [];
    for (const p of projects) {
      let score = 0;
      if ((p.tmux_session || "").toLowerCase().includes(q)) score += 4;
      if ((p.name || "").toLowerCase().includes(q)) score += 3;
      if ((p.company_name || "").toLowerCase().includes(q)) score += 2;
      if ((p.division || "").toLowerCase().includes(q)) score += 1;
      if (score > 0) scored.push({ p, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map((s) => s.p);
  }, [query, projects]);

  const filteredCompanies = useMemo(() => {
    if (!query || !companies) return [];
    const q = query.toLowerCase();
    const scored = [];
    for (const c of companies) {
      let score = 0;
      if ((c.companyName || "").toLowerCase().includes(q)) score += 3;
      if ((c.companyShort || "").toLowerCase().includes(q)) score += 3;
      if (score > 0) {
        if (c.openProjects.length > 0) score += 2;
        scored.push({ c, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5).map((s) => s.c);
  }, [query, companies]);

  const filtered = useMemo(() => {
    const projectItems = filteredProjects.map((p) => ({
      id: `project-${p.id}`,
      icon: "\u25A3",
      label: p.name,
      sublabel: p.company_name || "",
      tmux: p.tmux_session || "",
      action: () => { onSelectProject(p); onClose(); },
    }));
    const companyItems = filteredCompanies.map((c) => ({
      id: `company-${c.key}`,
      icon: "\u{1F3E2}",
      label: c.companyName,
      sublabel: c.openProjects.length > 0
        ? `Client \u00b7 ${c.openProjects.length} open`
        : "Client \u00b7 no open work",
      action: () => { onSelectCompany(c.key); },
    }));
    return [...filteredActions, ...projectItems, ...companyItems];
  }, [filteredActions, filteredProjects, filteredCompanies, onSelectProject, onSelectCompany, onClose]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!repositionMode) return;
    function onKey(e) {
      if (e.key === "Escape") handleRepositionCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [repositionMode, bgPosition]);

  function handleKeyDown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter" && filtered[activeIndex]) {
      e.preventDefault();
      filtered[activeIndex].action();
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  if (repositionMode) {
    return (
      <>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
        <div
          className="bg-reposition-overlay"
          onMouseMove={handleRepositionMouseMove}
          onClick={handleRepositionClick}
        >
          <div className="bg-reposition-hint">
            Click to set focal point &nbsp;&middot;&nbsp; <kbd>Esc</kbd> to cancel
          </div>
        </div>
      </>
    );
  }

  if (!open) {
    return (
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
    );
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
      <div className="cp-backdrop" onClick={onClose}>
        <div className="cp-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="cp-input-row">
            <span className="cp-search-icon">&#x2315;</span>
            <input
              ref={inputRef}
              className="cp-input"
              placeholder="Search projects or type a command..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="cp-results">
            {filtered.length === 0 && (
              <div className="cp-empty">No matching commands</div>
            )}
            {filtered.map((action, i) => (
              <button
                key={action.id}
                className={`cp-item ${i === activeIndex ? "cp-item-active" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => action.action()}
              >
                <span className="cp-item-icon">{action.icon}</span>
                <span className="cp-item-label">
                  {action.label}
                  {action.sublabel && <span className="cp-item-sub"> — {action.sublabel}</span>}
                </span>
                {action.tmux && (
                  <span className="card-tmux">{action.tmux}</span>
                )}
                {action.shortcut && (
                  <kbd className="cp-kbd">{action.shortcut}</kbd>
                )}
              </button>
            ))}
          </div>
          <div className="cp-footer">
            <kbd className="cp-kbd-sm">&uarr;&darr;</kbd> navigate
            <kbd className="cp-kbd-sm">Enter</kbd> select
            <kbd className="cp-kbd-sm">Esc</kbd> close
          </div>
        </div>
      </div>
    </>
  );
}

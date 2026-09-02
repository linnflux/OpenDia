import { useState, useEffect, useRef, useMemo } from "react";
import { NAV_ITEMS } from "../constants.js";

const BG_STORAGE_KEY = "opendia-bg-image";
const BG_POSITION_KEY = "opendia-bg-position";

// The wallpaper lives in localStorage, which caps around 5MB, and base64
// inflates a file by a third — so anything past roughly 3.7MB on disk cannot
// be stored. It used to fail silently: setItem threw before setBgImage ran,
// so the upload appeared to work and nothing changed.
//
// The image is painted with background-size: cover, so a 5200px-wide photo is
// being scaled down to the viewport anyway. Downscaling before storage costs
// nothing visible and takes a 20MB photo to about 2.4MB.
//
// The ladder is walked by ATTEMPTING the write rather than predicting the
// quota — it varies by browser and by whatever else is already stored, so the
// only honest test is to try it.
const RESIZE_STEPS = [
  { edge: 2560, quality: 0.82 },
  { edge: 2048, quality: 0.78 },
  { edge: 1600, quality: 0.72 },
  { edge: 1280, quality: 0.68 },
];
// Below this, store the original untouched: keeps PNG transparency and avoids
// re-encoding something that already fits.
const STORE_DIRECT_UNDER = 2 * 1024 * 1024;

function tryStore(dataUrl) {
  try {
    localStorage.setItem(BG_STORAGE_KEY, dataUrl);
    return true;
  } catch {
    return false;                              // QuotaExceededError
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// createImageBitmap honours EXIF orientation, so phone photos don't come out
// rotated. Falls back to an <img> for browsers without it.
async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("decode failed"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toJpeg(bitmap, maxEdge, quality) {
  const w = bitmap.width, h = bitmap.height;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  // JPEG has no alpha; paint a black base so transparent PNGs don't go pink
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

/** Returns {dataUrl, resizedTo} on success, or null if it never fit. */
async function storeBackground(file) {
  if (file.size <= STORE_DIRECT_UNDER) {
    const dataUrl = await readAsDataUrl(file);
    if (tryStore(dataUrl)) return { dataUrl, resizedTo: null };
  }
  const bitmap = await decode(file);
  try {
    for (const { edge, quality } of RESIZE_STEPS) {
      // Skip steps that wouldn't actually shrink an already-small image
      if (edge >= Math.max(bitmap.width, bitmap.height) && edge !== RESIZE_STEPS[0].edge) continue;
      const dataUrl = toJpeg(bitmap, edge, quality);
      if (tryStore(dataUrl)) {
        return { dataUrl, resizedTo: Math.min(edge, Math.max(bitmap.width, bitmap.height)) };
      }
    }
    return null;
  } finally {
    bitmap.close?.();
  }
}

// Destinations come from NAV_ITEMS, the same array the sidebar renders, so the
// palette can never fall out of sync with the visible navigation. Only the
// palette-specific commands (theme, refresh, wallpaper) are listed here.
function getActions({ onRefresh, onUploadBg, onClearBg, onReposition, hasBg, onOpenThemeModal, onNavigate, isAdmin, defaultBgs, onSelectDefaultBg, onNewTask }) {
  return [
    ...(onNewTask ? [{ id: "new-task", icon: "+", label: "New Task\u2026", action: onNewTask }] : []),
    { id: "refresh", icon: "\u21BB", label: "Refresh Board", action: onRefresh },
    { id: "theme-select", icon: "\u25D0", label: "Select Theme\u2026", action: onOpenThemeModal },
    ...NAV_ITEMS
      .filter((item) => !item.adminOnly || isAdmin)
      .map((item) => ({
        id: `nav-${item.key}`,
        icon: item.icon,
        label: `Open ${item.label}`,
        action: () => onNavigate(item.key),
      })),
    { id: "upload-bg", icon: "\u{1F5BC}", label: "Upload Background Image", action: onUploadBg },
    // Bundled starter pack (public/wallpapers/manifest.json). One action per
    // wallpaper so they are searchable like everything else in the palette;
    // absent manifest = no entries = the feature simply isn't there.
    ...defaultBgs.map((w) => ({
      id: `default-bg-${w.file}`,
      icon: "\u{1F304}",
      label: `Background: ${w.label}`,
      action: () => onSelectDefaultBg(w),
    })),
    ...(hasBg
      ? [
          { id: "reposition-bg", icon: "\u2316", label: "Reposition Background Image", action: onReposition },
          { id: "clear-bg", icon: "\u2715", label: "Remove Background Image", action: onClearBg },
        ]
      : []),
  ];
}

export default function CommandPalette({ open, onClose, onRefresh, projects, companies, onSelectProject, onSelectCompany, onOpenThemeModal, onNavigate, isAdmin, onNotify, onNewTask = null }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const [bgImage, setBgImage] = useState(() => localStorage.getItem(BG_STORAGE_KEY));
  const [bgPosition, setBgPosition] = useState(() => localStorage.getItem(BG_POSITION_KEY) || "center");
  const [repositionMode, setRepositionMode] = useState(false);
  const origPosRef = useRef(null);
  // The bundled starter pack. 404 (pack never generated) → empty list.
  const [defaultBgs, setDefaultBgs] = useState([]);
  useEffect(() => {
    fetch("/wallpapers/manifest.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setDefaultBgs(d?.wallpapers || []))
      .catch(() => {});
  }, []);

  async function handleSelectDefaultBg(w) {
    onClose();
    try {
      const r = await fetch(`/wallpapers/${encodeURIComponent(w.file)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      // Same store ladder as an upload — bundled files are pre-sized to the
      // ladder's top edge, so this normally stores directly.
      const result = await storeBackground(blob);
      if (!result) { onNotify?.("That wallpaper didn't fit browser storage"); return; }
      setBgImage(result.dataUrl);
      onNotify?.(`Background set — ${w.label}`);
    } catch (err) {
      console.error("default background failed:", err);
      onNotify?.("Couldn't load that wallpaper");
    }
  }

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

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = "";                       // allow re-picking the same file
    if (!file) return;
    try {
      const result = await storeBackground(file);
      if (!result) {
        onNotify?.("That image is too large for browser storage, even resized");
        return;
      }
      setBgImage(result.dataUrl);
      if (result.resizedTo) {
        onNotify?.(`Background set — resized to ${result.resizedTo}px to fit browser storage`);
      }
    } catch (err) {
      console.error("background upload failed:", err);
      onNotify?.("Couldn't read that image");
    }
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
      onOpenThemeModal: () => { onOpenThemeModal(); onClose(); },
      onNavigate: (key) => { onNavigate?.(key); onClose(); },
      isAdmin,
      defaultBgs,
      onSelectDefaultBg: handleSelectDefaultBg,
      onNewTask: onNewTask ? () => { onNewTask(); onClose(); } : null,
    }),
    [bgImage, bgPosition, onRefresh, onClose, onOpenThemeModal, onNavigate, isAdmin, defaultBgs, onNewTask]
  );

  const filteredActions = useMemo(() => {
    if (!query) return actions;
    const q = query.toLowerCase();
    return actions.filter((a) => a.label.toLowerCase().includes(q));
  }, [query, actions]);

  const filteredProjects = useMemo(() => {
    if (!query || !projects) return [];
    const q = query.toLowerCase();
    // A bare integer is almost always a card id — the operators speak in
    // them ("card #42"). Exact id match outranks every text match, but text
    // scoring still runs so "2026" can also find names containing it.
    const idQuery = /^\d+$/.test(query.trim()) ? Number(query.trim()) : null;
    const scored = [];
    for (const p of projects) {
      let score = 0;
      if (idQuery !== null && p.id === idQuery) score += 20;
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
      // Lead with the card number so an id search visibly hit its card.
      sublabel: `#${p.id}${p.company_name ? ` \u00B7 ${p.company_name}` : ""}`,
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

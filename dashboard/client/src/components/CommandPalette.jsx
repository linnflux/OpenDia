import { useState, useEffect, useRef, useMemo } from "react";

const BG_STORAGE_KEY = "opendia-bg-image";

function getActions({ onRefresh, onUploadBg, onClearBg, hasBg }) {
  return [
    { id: "refresh", icon: "\u21BB", label: "Refresh Board", shortcut: "R", action: onRefresh },
    { id: "upload-bg", icon: "\u{1F5BC}", label: "Upload Background Image", action: onUploadBg },
    ...(hasBg
      ? [{ id: "clear-bg", icon: "\u2715", label: "Remove Background Image", action: onClearBg }]
      : []),
  ];
}

export default function CommandPalette({ open, onClose, onRefresh }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const [bgImage, setBgImage] = useState(() => localStorage.getItem(BG_STORAGE_KEY));

  // Apply background image to body
  useEffect(() => {
    if (bgImage) {
      document.body.style.backgroundImage = `url(${bgImage})`;
      document.body.style.backgroundSize = "cover";
      document.body.style.backgroundPosition = "center";
      document.body.style.backgroundAttachment = "fixed";
      document.body.classList.add("has-bg");
    } else {
      document.body.style.backgroundImage = "";
      document.body.style.backgroundSize = "";
      document.body.style.backgroundPosition = "";
      document.body.style.backgroundAttachment = "";
      document.body.classList.remove("has-bg");
    }
  }, [bgImage]);

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
    setBgImage(null);
    onClose();
  }

  const actions = useMemo(
    () => getActions({ onRefresh: () => { onRefresh(); onClose(); }, onUploadBg: handleUploadBg, onClearBg: handleClearBg, hasBg: !!bgImage }),
    [bgImage, onRefresh, onClose]
  );

  const filtered = useMemo(() => {
    if (!query) return actions;
    const q = query.toLowerCase();
    return actions.filter((a) => a.label.toLowerCase().includes(q));
  }, [query, actions]);

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
              placeholder="Type a command..."
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
                <span className="cp-item-label">{action.label}</span>
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

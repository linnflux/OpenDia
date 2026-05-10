import { useEffect } from "react";

export default function ThemeModal({ themes, currentTheme, onSelect, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="theme-modal-backdrop" onClick={onClose}>
      <div className="theme-modal" onClick={(e) => e.stopPropagation()}>
        <div className="theme-modal-header">
          <span className="theme-modal-title">Select Theme</span>
          <button className="theme-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="theme-modal-grid">
          {themes.map((t) => (
            <button
              key={t.name}
              className={`theme-modal-card${currentTheme === t.name ? " active" : ""}`}
              style={{
                background: t.preview.bg,
                borderColor: currentTheme === t.name ? t.preview.accent : t.preview.border,
              }}
              onClick={() => { onSelect(t.name); onClose(); }}
            >
              <div className="theme-modal-surface" style={{ background: t.preview.surface }}>
                <span className="theme-modal-dot" style={{ background: t.preview.accent }} />
                <span className="theme-modal-dot" style={{ background: t.preview.text, opacity: 0.5 }} />
              </div>
              <span className="theme-modal-name" style={{ color: t.preview.text }}>
                {t.label}
                {currentTheme === t.name && <span className="theme-modal-check" style={{ color: t.preview.accent }}> ✓</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

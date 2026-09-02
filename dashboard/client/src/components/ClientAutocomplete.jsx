import { useEffect, useMemo, useState } from "react";

// Shared client/company typeahead (extracted from InboxModal). Base behavior
// is name-string in/out; `onSelect` additionally hands back the company row,
// and `allowCreate` appends a "+ New client" pseudo-item (select fires
// onSelect({ __create: true, name }) — the caller owns what create means).
export default function ClientAutocomplete({
  value, onChange, companies,
  onSelect = null, allowCreate = false,
  placeholder = "Client name", autoFocus = false,
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const items = useMemo(() => {
    if (!value) return [];
    const q = value.toLowerCase();
    const scored = [];
    for (const c of companies || []) {
      let score = 0;
      if ((c.short_name || "").toLowerCase().includes(q)) score += 3;
      if ((c.name || "").toLowerCase().includes(q)) score += 2;
      if (score > 0) scored.push({ c, score });
    }
    scored.sort((a, b) => b.score - a.score);
    let results = scored.slice(0, 8).map((s) => s.c);
    const exact = results.length === 1 && results[0].name.toLowerCase() === q;
    // Hide if the current value is already an exact match
    if (exact && !allowCreate) return [];
    if (exact) results = [];
    if (allowCreate && value.trim() && !exact) {
      results = [...results, { __create: true, name: value.trim() }];
    }
    return results;
  }, [value, companies, allowCreate]);

  const showList = open && items.length > 0;

  function select(item) {
    if (item.__create) {
      onSelect?.(item);
    } else {
      onChange(item.name);
      onSelect?.(item);
    }
    setOpen(false);
    setActiveIdx(0);
  }

  function handleKeyDown(e) {
    if (!showList) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      select(items[activeIdx]);
    } else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
    }
  }

  // Reset active index when matches change
  useEffect(() => { setActiveIdx(0); }, [items.length]);

  return (
    <div className="client-autocomplete-wrap">
      <input
        className="inbox-edit-input"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      {showList && (
        <ul className="client-autocomplete-list">
          {items.map((c, i) => (
            <li
              key={c.__create ? "__create" : c.id}
              className={`client-autocomplete-item${i === activeIdx ? " active" : ""}${c.__create ? " create" : ""}`}
              onMouseDown={() => select(c)}
            >
              {c.__create ? `+ New client "${c.name}"` : c.name}
              {!c.__create && c.short_name && c.short_name !== c.name && (
                <span className="client-autocomplete-short">{c.short_name}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

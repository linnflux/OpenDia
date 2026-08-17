import { useState, useEffect } from "react";

// One avatar recipe for the whole app: the agent's stylized portrait when
// ~/OpenDia/agents/<slug>/avatar.png exists (served through the scoped
// /api/file endpoint), a monogram circle otherwise. The accent ring comes
// from CSS, never the image, so it always matches the theme.
export default function AgentAvatar({ slug, name, size = "card" }) {
  const [broken, setBroken] = useState(false);
  // A regenerated avatar should appear without a hard refresh: reset the
  // error state whenever the agent changes.
  useEffect(() => { setBroken(false); }, [slug]);

  const initials = (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

  const src = `/api/file?path=${encodeURIComponent(`~/OpenDia/agents/${slug}/avatar.png`)}`;

  return (
    <span className={`agent-avatar size-${size}`} aria-hidden="true">
      {broken ? (
        <span className="agent-avatar-initials">{initials}</span>
      ) : (
        <img src={src} alt="" onError={() => setBroken(true)} />
      )}
    </span>
  );
}

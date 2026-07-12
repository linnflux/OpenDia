// Single source of truth for division colors/logos and project status
// metadata. Previously copy-pasted (and drifted — WordFlux was #111111 in
// some files, #3b82f6 in others) across App.jsx, Card.jsx, CardModal.jsx,
// InboxCard.jsx, ClientPanel.jsx, ClientCard.jsx, StatusSidebar.jsx.

export const DIVISION_COLORS = {
  WordFlux: { bg: "#111111", text: "#ffffff", uppercase: true },
  WatchThreat: { bg: "#5e97f2", text: "#fff" },
  AmPen: { bg: "#5a7a94", text: "#fff" },
  "Bedford AI": { bg: "#f5f0e8", text: "#2b0000" },
  "ADA Web Work": { bg: "#15489f", text: "#fff" },
  Linnflux: { bg: "#54af4d", text: "#fff" },
  FluxCC: { bg: "#2d1a0e", text: "#d4a528" },
  // Internal, non-billable. These were offered by /od-go and /od-new but had
  // never existed in the divisions table, so their cards silently rendered
  // with no division at all.
  Admin: { bg: "#4b5563", text: "#fff" },
  Onboarding: { bg: "#7c6f9f", text: "#fff" },
};

export const DIVISION_LOGOS = {
  WordFlux: "/divisions/wordflux-h.png",
  WatchThreat: "/divisions/watchthreat-h.png",
  AmPen: "/divisions/ampen.png",
  "Bedford AI": "/divisions/bedford-ai-h.png",
  "ADA Web Work": "/divisions/ada-web-work.png",
  Linnflux: "/divisions/linnflux.png",
  FluxCC: "/divisions/fluxcc.png",
};

export const STATUS_OPTIONS = [
  { key: "in_progress", label: "In Progress", color: "#3b82f6" },
  { key: "wfhuman",    label: "WFHuman",     color: "#f59e0b" },
  { key: "ice",        label: "Ice",          color: "#6b7280" },
  { key: "completed",  label: "Completed",    color: "#22c55e" },
];

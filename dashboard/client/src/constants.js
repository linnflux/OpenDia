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
  Linnflux: "/divisions/linnflux-h.png",
  FluxCC: "/divisions/fluxcc.png",
};

// The subset that reads as a badge on a board card: horizontal wordmarks,
// ~2.5:1 or wider. Square marks scale to a ~16px blob at card size and say
// less than the text pill does, so divisions without a horizontal keep the
// pill — as do divisions with no artwork, like Admin.
//
// ampen-h is AmPen_Lite_Logo from ampen.us (835x293, self-contained navy
// panel); ada-web-work-h is ADA-Web-Work-Logo-Horizontal from Drive
// (1135x305). FluxCC has no horizontal ANYWHERE — flux.cc's own header
// renders the 1981x1374 mark beside plain text, and Drive/templates carry
// only that same file — so it keeps the pill until one is drawn.
export const DIVISION_WORDMARKS = {
  WordFlux: DIVISION_LOGOS.WordFlux,
  WatchThreat: DIVISION_LOGOS.WatchThreat,
  AmPen: "/divisions/ampen-h.png",
  "Bedford AI": DIVISION_LOGOS["Bedford AI"],
  "ADA Web Work": "/divisions/ada-web-work-h.png",
  Linnflux: DIVISION_LOGOS.Linnflux,
};

export const STATUS_OPTIONS = [
  { key: "in_progress", label: "In Progress", color: "#3b82f6" },
  { key: "wfhuman",    label: "WFHuman",     color: "#f59e0b" },
  { key: "ice",        label: "Ice",          color: "#6b7280" },
  { key: "completed",  label: "Completed",    color: "#22c55e" },
];

// Every destination in the app, in sidebar order. NavSidebar and the Ctrl+K
// palette both build their lists from this, so a view can never end up in one
// surface and not the other — which is exactly how Billing and Newsletter
// ended up palette-only, and Sweep ended up in three places at once.
//
// `icon` is the palette's text glyph; NavSidebar renders its own SVGs keyed by
// `key`. `badge` names which count feeds the row, or null for no badge.
export const NAV_SECTIONS = [
  {
    title: "WORK",
    items: [
      { key: "board",    label: "Board",    icon: "▣",     badge: null },
      { key: "today",    label: "Today",    icon: "\u{1F4C5}",  badge: null },
      { key: "inbox",    label: "Inbox",    icon: "\u{1F4E5}",  badge: "inbox" },
      { key: "clients",  label: "Clients",  icon: "\u{1F3E2}",  badge: null },
      { key: "planrooms", label: "Planrooms", icon: "\u{1F5FA}", badge: null },
      { key: "runrooms", label: "Runrooms", icon: "\u{1F9ED}",  badge: null },
    ],
  },
  {
    title: "REVIEW",
    items: [
      { key: "sweep",     label: "Sweep",     icon: "⚡",    badge: "sweep" },
      { key: "analytics", label: "Analytics", icon: "\u{1F4CA}", badge: null },
    ],
  },
  {
    title: "ADMIN",
    adminOnly: true,
    items: [
      { key: "billing",    label: "Billing",    icon: "\u{1F4B0}", badge: null },
      { key: "newsletter", label: "Newsletter", icon: "\u{1F4F0}", badge: null },
      { key: "rooms",      label: "Rooms",      icon: "\u{1F6AA}", badge: null },
      { key: "agents",     label: "Agents",     icon: "\u{1F916}", badge: null },
      { key: "mailroom",   label: "Mailroom",   icon: "\u{1F4EC}", badge: null },
      { key: "socal",      label: "SoCal",      icon: "\u{1F4E3}", badge: null },
      { key: "system",     label: "System",     icon: "\u{1F5A5}", badge: null },
    ],
  },
];

export const NAV_ITEMS = NAV_SECTIONS.flatMap((s) =>
  s.items.map((i) => ({ ...i, section: s.title, adminOnly: !!s.adminOnly }))
);

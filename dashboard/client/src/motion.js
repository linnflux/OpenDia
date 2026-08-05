import { flushSync } from "react-dom";

// Card → modal morph, built on the View Transitions API.
//
// Why not a hand-rolled FLIP: a card is ~280x140 and the modal is
// min(95vw, 780px) x 92vh — about 6x in each axis. Transforming the real modal
// down to 18% and back squashes a page of text, tabs and an xterm pane, and
// undoing that means counter-scaling every child; animating width/height
// relayouts that subtree every frame. The browser morphs the box AND
// cross-fades the differing content, which is the part that is actually hard.
//
// There is deliberately no fallback animation. Without the API, or under
// reduced motion, this falls through to the instant behaviour the app had
// before — a second animation path would be a second thing to keep correct
// across six call sites, for a case that does not arise on any browser in use.

export const MORPH = "card-morph";

// Elements we wrote view-transition-name onto, so cleanup can never leak one.
// A stuck name would silently break the *next* transition with a duplicate.
let held = [];
let running = null;

export function supported() {
  return typeof document !== "undefined" &&
    typeof document.startViewTransition === "function";
}

export function prefersReducedMotion() {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * How much of an element is inside the viewport, 0..1.
 *
 * The board scrolls inside .app-main, so a card can be half-clipped or gone
 * entirely by the time the modal closes — the 30s poll and the active-timer
 * pin both reorder the grid underneath an open modal.
 */
export function visibleRatio(el) {
  if (!el) return 0;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return 0;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  return (w * h) / (r.width * r.height);
}

/** The visible board card for a project, or null. */
export function cardElement(projectId) {
  const el = document.querySelector(`[data-project-id="${projectId}"]`);
  return el && visibleRatio(el) >= 0.6 ? el : null;
}

export function modalElement() {
  return document.querySelector("[data-card-modal]");
}

/** The status filter pill a card flies into when its status changed. */
export function statusPillElement(statusKey) {
  const el = document.querySelector(`[data-status-key="${statusKey}"]`);
  return el && visibleRatio(el) >= 0.6 ? el : null;
}

function hold(el) {
  if (!el) return;
  el.style.viewTransitionName = MORPH;
  held.push(el);
}

function release() {
  for (const el of held) el.style.viewTransitionName = "";
  held = [];
  document.documentElement.classList.remove("vt-no-origin", "vt-no-target");
}

/**
 * Run `update` inside a view transition, morphing `from` into `to()`.
 *
 * @param from  element that holds the morph name for the OLD capture (or null)
 * @param update  the React state change; called synchronously
 * @param to  called AFTER the update to find the element for the NEW capture
 * @param flag  optional class on <html> so CSS can style a one-sided morph
 */
export function morph({ from, update, to, flag }) {
  if (!supported() || prefersReducedMotion()) {
    update();
    return;
  }

  // A second transition while one is in flight would capture a frozen frame.
  running?.skipTransition();
  release();

  hold(from);
  if (flag) document.documentElement.classList.add(flag);

  let vt;
  try {
    vt = document.startViewTransition(() => {
      // Hand the name over before the new capture: it must be unique among
      // rendered elements, and the card and the modal are both in the DOM.
      if (from) from.style.viewTransitionName = "";
      // startViewTransition runs this outside the React event handler, so
      // automatic batching would otherwise flush the state change AFTER the
      // callback returns and the new capture would see an unchanged DOM.
      flushSync(update);
      hold(to?.());
    });
  } catch {
    // Never let an animation failure swallow the actual state change.
    release();
    update();
    return;
  }

  running = vt;
  // A skipped transition rejects `ready`; nothing is listening, so silence it.
  vt.ready?.catch(() => {});
  vt.finished
    ?.catch(() => {})
    .finally(() => {
      if (running === vt) running = null;
      release();
    });
}

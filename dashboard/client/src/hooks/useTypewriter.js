import { useEffect, useRef, useState } from "react";

// An accelerating reveal for already-rendered markdown.
//
// The HTML is parsed once and mounted complete, then every text node is
// blanked and refilled character by character. Bold, headings, lists and links
// are therefore laid out correctly from the first frame — only the characters
// appear. Re-parsing a growing markdown slice each frame flickers instead
// (a half-typed `**bold` is unclosed markdown, so the layout snaps), and a
// span per character bloats the DOM for no gain.

const START_CPS = 18;
const END_CPS = 420;
const RAMP_MS = 3500;
const MAX_MS = 9000;

function prefersReducedMotion() {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * @param {object} opts
 * @param {string} opts.html  sanitised, already-parsed markup
 * @param {boolean} opts.animate  false renders instantly (replays, reduced motion)
 * @returns {{ref, done, skip}}
 */
export default function useTypewriter({ html, animate }) {
  const ref = useRef(null);
  const [done, setDone] = useState(!animate);
  const skipRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = html || "";
    skipRef.current = false;

    if (!animate || prefersReducedMotion() || !html) {
      setDone(true);
      return;
    }

    // Snapshot the text nodes, then pin the finished height so the pane never
    // grows under the reader while it fills in.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let total = 0;
    let n;
    while ((n = walker.nextNode())) {
      const text = n.nodeValue;
      if (!text) continue;
      nodes.push({ node: n, text });
      total += text.length;
    }
    if (!total) { setDone(true); return; }

    el.style.minHeight = `${el.getBoundingClientRect().height}px`;
    for (const item of nodes) item.node.nodeValue = "";
    setDone(false);

    // If the ramp alone would overrun the budget, raise the terminal rate
    // rather than let a long report crawl.
    const rampChars = ((START_CPS + END_CPS) / 2) * (RAMP_MS / 1000);
    const remaining = Math.max(0, total - rampChars);
    const endCps = remaining > 0
      ? Math.max(END_CPS, remaining / Math.max(0.1, (MAX_MS - RAMP_MS) / 1000))
      : END_CPS;

    let raf = 0;
    let last = performance.now();
    const started = last;
    let shown = 0;

    function frame(now) {
      const dt = (now - last) / 1000;
      last = now;
      if (skipRef.current) {
        shown = total;
      } else {
        const t = Math.min(1, (now - started) / RAMP_MS);
        const cps = START_CPS + (endCps - START_CPS) * t * t;   // easeInQuad
        shown = Math.min(total, shown + cps * dt);
      }

      let budget = Math.floor(shown);
      for (const item of nodes) {
        if (budget <= 0) {
          if (item.node.nodeValue !== "") item.node.nodeValue = "";
          continue;
        }
        const take = Math.min(budget, item.text.length);
        const next = item.text.slice(0, take);
        if (item.node.nodeValue !== next) item.node.nodeValue = next;
        budget -= take;
      }

      if (shown >= total) {
        el.style.minHeight = "";
        setDone(true);
        return;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      el.style.minHeight = "";
    };
  }, [html, animate]);

  return { ref, done, skip: () => { skipRef.current = true; } };
}

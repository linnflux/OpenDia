import { useMemo } from "react";

function daysSince(isoString) {
  if (!isoString) return 9999;
  // SQLite stores as "YYYY-MM-DD HH:MM:SS" — treat as UTC
  const dt = new Date(isoString.replace(" ", "T") + "Z");
  return (Date.now() - dt.getTime()) / 86400000;
}

function staleness(days) {
  if (days < 3) return "fresh";
  if (days < 7) return "warm";
  return "stale";
}

function relativeTime(days) {
  if (days < 1) return "today";
  if (days < 2) return "1d ago";
  if (days < 7) return `${Math.floor(days)}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function useCompanies(projects) {
  return useMemo(() => {
    const map = new Map();

    for (const p of projects) {
      // Group key: prefer notion_id for stability, fall back to name
      const key = p.company_notion_id || p.company_name || "__unknown__";
      if (!map.has(key)) {
        map.set(key, {
          key,
          companyName: p.company_name || p.company_short || "Unknown",
          companyShort: p.company_short || p.company_name || "?",
          companyNotionId: p.company_notion_id || null,
          companyWebsite: p.company_website || null,
          openProjects: [],
          completedProjects: [],
        });
      }
      const co = map.get(key);
      if (p.status === "completed") {
        co.completedProjects.push(p);
      } else {
        co.openProjects.push(p);
      }
    }

    const companies = [];
    for (const co of map.values()) {
      // Deduped divisions from open projects only
      const divSet = new Set();
      for (const p of co.openProjects) {
        if (p.division) divSet.add(p.division);
      }
      co.divisions = Array.from(divSet).sort();

      // Status counts
      co.statusCounts = { in_progress: 0, wfhuman: 0, ice: 0 };
      for (const p of co.openProjects) {
        if (co.statusCounts[p.status] !== undefined) co.statusCounts[p.status]++;
      }

      // Last activity = MAX updated_at across open projects
      let maxUpdated = null;
      for (const p of co.openProjects) {
        if (!maxUpdated || (p.updated_at && p.updated_at > maxUpdated)) {
          maxUpdated = p.updated_at;
        }
      }
      co.lastActivity = maxUpdated;
      const days = daysSince(maxUpdated);
      co.stalenessKey = staleness(days);
      co.relativeTime = relativeTime(days);

      // Action-urgency sort score: higher = needs attention sooner
      co.score = days + (co.statusCounts.wfhuman > 0 ? 7 : 0);

      // Next step from most recently updated open project
      const withNextStep = [...co.openProjects]
        .sort((a, b) => ((b.updated_at || "") > (a.updated_at || "") ? 1 : -1))
        .find((p) => p.next_step);
      co.nextStep = withNextStep?.next_step || null;

      // Sort open/completed by updated_at DESC
      co.openProjects.sort((a, b) => ((b.updated_at || "") > (a.updated_at || "") ? 1 : -1));
      co.completedProjects.sort((a, b) => ((b.updated_at || "") > (a.updated_at || "") ? 1 : -1));

      companies.push(co);
    }

    // Sort by action urgency DESC, tiebreak alphabetical
    companies.sort((a, b) => {
      const diff = b.score - a.score;
      if (Math.abs(diff) > 0.01) return diff;
      return a.companyName.localeCompare(b.companyName);
    });

    return companies;
  }, [projects]);
}

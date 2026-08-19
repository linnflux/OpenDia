import { useEffect, useState } from "react";
import { certitudeColor, SparkThinking } from "./SparkPanel.jsx";

// The card modal's Spark tab, reduced to a doorway.
//
// Decisions happen in the Planroom now — this tab answers "what does the plan
// say, is anything running, and how do I get there" in one glance, and starts
// a scan without leaving the card. No Do it / Adjust / runroom buttons here:
// two surfaces that both decide is two surfaces that can disagree.
//
// `spark` is the useSparkRun hook CardModal still owns, so a scan started from
// here keeps streaming (the tab dot, the thinking line) exactly as before.

function rel(iso) {
  if (!iso) return "";
  const t = new Date(iso.length === 16 ? `${iso}:00` : iso).getTime();
  if (Number.isNaN(t)) return iso;
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function SparkDoorway({ spark, project, isAdmin, showToast, onOpenPlanroom }) {
  const [plan, setPlan] = useState(null);
  const [loaded, setLoaded] = useState(false);

  // Re-read the standing plan whenever the run's status moves: a finished
  // scan has just rewritten it, and this is the cheapest way to show that.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/planrooms/${project.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) { setPlan(d?.plan || null); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [project.id, spark.status]);

  const live = ["scanning", "acting", "proposing"].includes(spark.status);
  const standing = plan?.planroom || null;
  // A live result outranks the plan on disk; the plan outranks nothing.
  const report = spark.result || null;
  const step = report?.next_step?.text || standing?.step?.text || plan?.title || null;
  const pct = report?.certitude?.pct ?? standing?.certitude?.pct ?? null;
  const route = report?.next_step?.route || standing?.route || null;

  async function sparkNow() {
    const res = await spark.start();
    if (res?.error) showToast(res.error);
  }

  return (
    <div className="spark-panel">
      <div className="spark-stage spark-doorway">
        {(spark.status === "scanning" || spark.status === "acting") && (
          <div className="spark-doorway-live">
            <SparkThinking verb={spark.verb} />
          </div>
        )}
        {spark.status === "proposing" && (
          <div className="spark-doorway-live spark-doorway-waiting">
            decision waiting in the Planroom
          </div>
        )}

        {pct != null ? (
          <div className="spark-doorway-summary">
            <span className="spark-doorway-pct" style={{ color: certitudeColor(pct) }}>{pct}%</span>
            <div className="spark-doorway-step">
              <p>{step}</p>
              <div className="spark-doorway-meta">
                {route && <span className="spark-chip">{route}</span>}
                {standing?.sparked_at && (
                  <span className="spark-chip">
                    sparked {rel(standing.sparked_at)}
                    {standing.sparked_by ? ` · ${standing.sparked_by.replace(/^agent:/, "")}` : ""}
                  </span>
                )}
                {plan?.status === "adopted" && plan.adopted_by?.tmux_session && (
                  <span className="spark-chip">in runroom {plan.adopted_by.tmux_session}</span>
                )}
              </div>
            </div>
          </div>
        ) : loaded && !live ? (
          <p className="spark-idle-copy">
            No plan yet for this card. Spark it — a sweep across every message front ending in
            one next step, a confidence number, and a way to get it done.
          </p>
        ) : null}

        <div className="spark-decision-buttons">
          <button className="spark-btn spark-btn-primary" onClick={() => onOpenPlanroom?.(project.id)}>
            Open Planroom
          </button>
          {spark.status === "scanning" ? (
            <button className="spark-btn" onClick={spark.cancel} disabled={spark.busy}>Cancel</button>
          ) : (
            <button className="spark-btn" onClick={sparkNow} disabled={spark.busy || live || !isAdmin}
                    title={isAdmin ? (live ? "A spark is already running" : "Refresh the plan with a new scan") : "Spark runs are admin-only"}>
              {spark.busy ? "Starting…" : "Spark now"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

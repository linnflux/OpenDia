import { useEffect, useState } from "react";

let cached = null;

export default function useCompaniesList() {
  const [companies, setCompanies] = useState(cached || []);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    fetch("/api/companies")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          cached = data.companies || [];
          setCompanies(cached);
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { companies, loading };
}

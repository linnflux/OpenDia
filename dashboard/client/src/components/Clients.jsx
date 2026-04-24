import { useState, useEffect } from "react";
import { useCompanies } from "../hooks/useCompanies.js";
import ClientCard from "./ClientCard.jsx";
import ClientPanel from "./ClientPanel.jsx";

export default function Clients({ projects, onProjectClick, pendingKey, onPendingConsumed }) {
  const companies = useCompanies(projects);
  const [selectedKey, setSelectedKey] = useState(null);

  // Ctrl+K jump: auto-open a company panel when pendingKey is set
  useEffect(() => {
    if (pendingKey) {
      setSelectedKey(pendingKey);
      onPendingConsumed?.();
    }
  }, [pendingKey, onPendingConsumed]);

  const activeCompanies = companies.filter((c) => c.openProjects.length > 0);
  const selectedCompany = companies.find((c) => c.key === selectedKey) || null;

  function handleOpen(key) {
    setSelectedKey(key);
  }

  function handleClose() {
    setSelectedKey(null);
  }

  return (
    <div className="clients-view">
      {activeCompanies.length === 0 ? (
        <div className="clients-empty">No clients with open projects.</div>
      ) : (
        <div className="clients-grid">
          {activeCompanies.map((company) => (
            <ClientCard key={company.key} company={company} onOpen={handleOpen} />
          ))}
        </div>
      )}
      <ClientPanel
        company={selectedCompany}
        onClose={handleClose}
        onProjectClick={(project) => {
          onProjectClick(project);
        }}
      />
    </div>
  );
}

export function ReportsPage() {
  return (
    <section className="screen">
      <div className="grid g3">
        <div className="card pad">
          <div style={{ fontSize: 26 }}>📄</div>
          <h4 style={{ margin: "10px 0 4px", fontSize: 14 }}>Monthly report</h4>
          <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 14px" }}>
            KPIs, best posts, pillar &amp; avatar performance — exported to PDF.
          </p>
          <button className="btn btn-primary" disabled>Export PDF</button>
        </div>
        <div className="card pad">
          <div style={{ fontSize: 26 }}>🔗</div>
          <h4 style={{ margin: "10px 0 4px", fontSize: 14 }}>Shareable link</h4>
          <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 14px" }}>
            Read-only dashboard link for your team — revocable.
          </p>
          <button className="btn" disabled>Create link</button>
        </div>
        <div className="card pad">
          <div style={{ fontSize: 26 }}>📧</div>
          <h4 style={{ margin: "10px 0 4px", fontSize: 14 }}>Weekly digest</h4>
          <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 14px" }}>
            Auto-emailed summary every Monday.
          </p>
          <button className="btn" disabled>Enable</button>
        </div>
      </div>
      <div className="demo-note" style={{ marginTop: 18 }}>Reports &amp; sharing arrive in Phase 2.</div>
    </section>
  );
}

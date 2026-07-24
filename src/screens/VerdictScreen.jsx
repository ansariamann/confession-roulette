export default function VerdictScreen() {
  return (
    <div className="screen" id="verdict-screen">
      <div className="screen-icon">⚖️</div>
      <h1 className="screen-title">Verdict</h1>
      <p className="screen-subtitle">
        The crowd has spoken. See how people judged each anonymous confession.
      </p>

      <div className="glass-card" style={{ width: '100%', maxWidth: 400, textAlign: 'center' }}>
        <h2 style={{ marginBottom: '0.5rem' }}>Coming Soon</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Verdict results and reactions will appear here.
        </p>
      </div>
    </div>
  );
}

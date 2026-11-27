export function StatusBadge({ value }) {
  const normalized = String(value || '').toLowerCase();
  const palette = {
    healthy: { bg: '#dcfce7', text: '#166534' },
    warning: { bg: '#fef3c7', text: '#92400e' },
    critical: { bg: '#fee2e2', text: '#991b1b' },
    unhealthy: { bg: '#f3f4f6', text: '#374151' },
    recovered: { bg: '#dbeafe', text: '#1d4ed8' },
    partial: { bg: '#fef3c7', text: '#a16207' }
  };
  const style = palette[normalized] || { bg: '#e2e8f0', text: '#334155' };
  return (
    <span style={{ display: 'inline-block', padding: '0.35rem 0.7rem', borderRadius: 999, background: style.bg, color: style.text, fontWeight: 700, textTransform: 'capitalize' }}>
      {value || 'unknown'}
    </span>
  );
}

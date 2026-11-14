import { useCallback, useMemo } from 'react';
import { List } from 'react-window';
import { Check, ChevronRight } from 'lucide-react';

export const age = (value) => {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(new Date(value))) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 3600)}h`;
};

function AlertRow({ index, style, ariaAttributes, alerts, onSelect, onAcknowledge, busy }) {
  const alert = alerts[index],
    id = String(alert._id);
  return (
    <div
      {...ariaAttributes}
      style={style}
      className={`alert-item ${alert.severity} ${alert.state === 'resolved' ? 'resolved' : ''}`}
    >
      <div className="alert-stripe" />
      <div className="alert-body">
        <button className="alert-title" onClick={() => onSelect(alert)}>
          {alert.title || `${alert.type} · ${alert.sid}`}
        </button>
        <p>
          {Number.isFinite(alert.value)
            ? `${Math.round(alert.value * 10) / 10} ${alert.unit || ''}`
            : alert.detail}
          {alert.confirmCount > 0 ? ` · ${alert.confirmCount} neighbours confirm` : ''}
        </p>
        <div className="alert-actions">
          <span className={`severity-label ${alert.severity}`}>
            {alert.state === 'resolved'
              ? 'Resolved'
              : alert.severity === 'critical'
                ? 'Critical'
                : 'Warning'}
          </span>
          {alert.state === 'open' && (
            <button onClick={() => onAcknowledge(alert)} disabled={busy === id}>
              Acknowledge
            </button>
          )}
          {alert.state === 'ack' && (
            <span>
              <Check size={11} /> Acknowledged
            </span>
          )}
        </div>
      </div>
      <time className="alert-age">{age(alert.openedAt)}</time>
    </div>
  );
}

export default function AlertList({ alerts, onSelect, onAcknowledge, busy, height = 360 }) {
  const rowProps = useMemo(
    () => ({ alerts, onSelect, onAcknowledge, busy }),
    [alerts, onSelect, onAcknowledge, busy],
  );
  const rowKey = useCallback((index) => String(alerts[index]._id), [alerts]);
  if (!alerts.length)
    return (
      <div className="empty-state">
        <span className="quiet-check">
          <Check size={22} />
        </span>
        <strong>No active alerts</strong>
        <p>New incidents appear here as readings arrive.</p>
      </div>
    );
  return (
    <List
      rowComponent={AlertRow}
      rowCount={alerts.length}
      rowHeight={108}
      rowProps={rowProps}
      rowKey={rowKey}
      overscanCount={3}
      style={{ height, width: '100%' }}
    />
  );
}

export function AlertDetails({ alert, onClose, onSelectSource }) {
  if (!alert) return null;
  return (
    <section className="dialog-card">
      <div className="panel-heading">
        <h2>{alert.title}</h2>
        <button className="text-button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="dialog-content">
        <span className={`status-tag ${alert.severity}`}>
          {alert.severity} · {alert.state}
        </span>
        <p>{alert.detail}</p>
        <button className="button" onClick={() => onSelectSource(alert.sid)}>
          Inspect {alert.sid}
          <ChevronRight size={15} />
        </button>
        <h3>Timeline</h3>
        <div className="timeline">
          {(alert.timeline || []).map((entry, i) => (
            <div key={`${entry.ts}-${i}`}>
              <time>{new Date(entry.ts).toLocaleTimeString()}</time>
              <span>{entry.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

import React, {useEffect, useId, useRef} from 'react';
import {Link} from 'react-router-dom';
import {Inbox, LoaderCircle, X} from 'lucide-react';
import {invoiceStateNames, isolationReasonNames, networkStateNames, serviceStatusNames, ticketStatusNames, ticketSteps} from '../lib/format.js';

export function Button({variant = 'primary', icon: Icon, children, className = '', type = 'button', ...rest}) {
  return <button type={type} className={`btn ${variant} ${className}`} {...rest}>{Icon && <Icon size={15} aria-hidden="true"/>}{children}</button>;
}

export function ButtonLink({variant = 'secondary', icon: Icon, children, ...rest}) {
  return <Link className={'btn ' + variant} {...rest}>{Icon && <Icon size={15} aria-hidden="true"/>}{children}</Link>;
}

export function IconButton({label, icon: Icon, ...rest}) {
  return <button type="button" className="icon-btn" aria-label={label} title={label} {...rest}><Icon size={17}/></button>;
}

export function Field({label, name, type = 'text', required = false, hint, children, as, defaultValue, className = '', ...rest}) {
  const id = useId();
  let control;
  if (children) control = <select id={id} name={name} required={required} {...(rest.value === undefined ? {defaultValue: defaultValue ?? ''} : {})} {...rest}>{children}</select>;
  else if (as === 'textarea') control = <textarea id={id} name={name} required={required} defaultValue={defaultValue} rows={3} {...rest}/>;
  else control = <input id={id} type={type} name={name} required={required} defaultValue={defaultValue} {...rest}/>;
  return (
    <div className={'field ' + className}>
      <label htmlFor={id}>{label}{required && <span className="req" aria-hidden="true"> *</span>}</label>
      {control}
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function Dialog({title, onClose, children, size = 'md'}) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    const first = node?.querySelector('[autofocus], input:not([readonly]):not([type=hidden]), select, textarea, button:not(.dialog-close)');
    (first || node)?.focus();
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab' && node) {
        const items = [...node.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled);
        if (!items.length) return;
        const [head, tail] = [items[0], items[items.length - 1]];
        if (e.shiftKey && document.activeElement === head) { e.preventDefault(); tail.focus(); }
        else if (!e.shiftKey && document.activeElement === tail) { e.preventDefault(); head.focus(); }
      }
    };
    node?.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      node?.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section ref={ref} tabIndex={-1} className={'dialog ' + size} role="dialog" aria-modal="true" aria-label={title}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn dialog-close" onClick={onClose} aria-label="Tutup"><X size={18}/></button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function FormActions({onCancel, pending, submitLabel = 'Simpan', disabled}) {
  return (
    <div className="dialog-actions">
      <Button variant="ghost" onClick={onCancel}>Batal</Button>
      <Button type="submit" disabled={pending || disabled}>{pending ? 'Memproses…' : submitLabel}</Button>
    </div>
  );
}

export function Alert({tone = 'info', children, onDismiss}) {
  if (!children) return null;
  return (
    <div className={'alert ' + tone} role={tone === 'error' ? 'alert' : undefined}>
      <div>{children}</div>
      {onDismiss && <button type="button" onClick={onDismiss}>Tutup</button>}
    </div>
  );
}

export function PageHeader({eyebrow, title, description, actions}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Figures({children, cols}) {
  return <div className="figures" style={cols ? {'--cols': cols} : undefined}>{children}</div>;
}

export function Figure({label, value, sub, tone, to, icon: Icon}) {
  const body = <>
    {Icon && <span className={'figure-icon ' + (tone || 'teal')} aria-hidden="true"><Icon size={18}/></span>}
    <span className="figure-label">{label}</span><strong className={'figure-value ' + (tone || '')}>{value}</strong>{sub && <span className="figure-sub">{sub}</span>}
  </>;
  return to ? <Link to={to} className="figure link">{body}</Link> : <div className="figure">{body}</div>;
}

export function Section({title, sub, actions, children, flush}) {
  return (
    <section className={'section ' + (flush ? 'flush' : '')}>
      {(title || actions) && (
        <div className="section-head">
          <div>{title && <h2>{title}</h2>}{sub && <p>{sub}</p>}</div>
          {actions && <div className="section-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

// Penanda status tipografis: kotak penuh = selesai, kotak kosong = berjalan, merah = berisiko.
export function InvoiceStatus({state}) {
  return <span className={'mark mark-' + state}><i aria-hidden="true"/>{invoiceStateNames[state] || state}</span>;
}

export function ServiceStatus({status}) {
  const tone = {active: 'paid', pending: 'unpaid', suspended: 'overdue', terminated: 'muted'}[status] || 'unpaid';
  return <span className={'mark mark-' + tone}><i aria-hidden="true"/>{serviceStatusNames[status] || status}</span>;
}

export function NetworkStatus({state = 'unconfigured', reason}) {
  const tone = {provisioned: 'paid', isolated: 'overdue', error: 'unpaid', unconfigured: 'muted'}[state] || 'muted';
  const label = networkStateNames[state] || state;
  return <span className={'mark mark-' + tone}><i aria-hidden="true"/>{label}{state === 'isolated' && reason ? ' · ' + (isolationReasonNames[reason] || reason) : ''}</span>;
}

export function Checkbox({label, name, defaultChecked, hint, ...rest}) {
  return (
    <label className="check">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} {...rest}/>
      <span>{label}{hint && <small>{hint}</small>}</span>
    </label>
  );
}

export function TicketBadge({status, team}) {
  const steps = ticketSteps(team);
  const index = steps.indexOf(status);
  return <span className={'ticket-badge t-' + status}><b>{index + 1}/{steps.length}</b>{ticketStatusNames[status] || status}</span>;
}

export function TicketStage({status, team}) {
  const steps = ticketSteps(team);
  const current = steps.indexOf(status);
  return (
    <ol className="stage" style={{'--steps': steps.length}} aria-label={'Progres ticket: ' + (ticketStatusNames[status] || status)}>
      {steps.map((step, index) => (
        <li key={step} className={index < current ? 'done' : index === current ? 'current' : ''}>
          <span>{String(index + 1).padStart(2, '0')}</span><small>{ticketStatusNames[step]}</small>
        </li>
      ))}
    </ol>
  );
}

export function Details({entries, columns = 1}) {
  return (
    <dl className={'details cols-' + columns}>
      {entries.filter(Boolean).map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value === null || value === undefined || value === '' ? '—' : value}</dd></div>
      ))}
    </dl>
  );
}

export function Empty({title = 'Belum ada data', desc}) {
  return <div className="empty"><Inbox size={22} aria-hidden="true"/><b>{title}</b>{desc && <p>{desc}</p>}</div>;
}

export function Loading({label = 'Memuat data…'}) {
  return <div className="loading" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true"/>{label}</div>;
}

// Menampilkan loading/error untuk sekumpulan query sebelum konten dirender.
export function QueryGate({queries, children}) {
  const failed = queries.find(q => q.isError);
  if (failed) return <Alert tone="error">Gagal memuat data: {failed.error.message} <button type="button" className="link-btn" onClick={() => queries.forEach(q => q.refetch())}>Coba lagi</button></Alert>;
  if (queries.some(q => q.isPending)) return <Loading/>;
  return children();
}

export function Tabs({tabs, current, onChange}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([id, label, count]) => (
        <button key={id} type="button" role="tab" aria-selected={current === id} className={current === id ? 'current' : ''} onClick={() => onChange(id)}>
          {label}{count !== undefined && <span>{count}</span>}
        </button>
      ))}
    </div>
  );
}

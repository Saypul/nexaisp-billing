import React from 'react';
import {Link} from 'react-router-dom';
import {agingBuckets} from '../lib/billing.js';
import {compactIdr, idr, num, percent} from '../lib/format.js';

// Pita umur piutang: lima kolom bergaris rambut dengan angka besar; kolom lewat jatuh tempo diberi aksen.
export default function AgingStrip({summary, active}) {
  return (
    <div className="aging" role="list" aria-label="Umur piutang">
      {agingBuckets.map((b, index) => {
        const {amount, count} = summary.buckets[b.key];
        const share = percent(amount, summary.total);
        return (
          <Link role="listitem" key={b.key} to={'/receivables?bucket=' + b.key} className={'aging-col ' + (index && amount ? 'late ' : '') + (active === b.key ? 'active' : '')} title={idr(amount)}>
            <span className="aging-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="aging-label">{b.label}</span>
            <strong className="aging-amount">{compactIdr(amount)}</strong>
            <span className="aging-meta">{num(count)} invoice · {share}%</span>
            <span className="aging-bar" aria-hidden="true"><i style={{width: share + '%'}}/></span>
          </Link>
        );
      })}
    </div>
  );
}

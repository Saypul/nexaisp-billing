import React, {useEffect, useState} from 'react';
import {fetchBlob} from '../api/client.js';

// Gambar dari API yang butuh header Authorization (tidak bisa lewat <img src> biasa).
export default function AuthImage({url, alt, label, className = 'event-photo'}) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl;
    setSrc(null);
    setFailed(false);
    fetchBlob(url, controller.signal)
      .then(blob => { if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setSrc(objectUrl); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url]);
  if (failed) return <span className="fineprint">Gambar tidak dapat dimuat.</span>;
  if (!src) return <span className="fineprint">Memuat gambar…</span>;
  return (
    <a className={className} href={src} target="_blank" rel="noopener noreferrer">
      <img src={src} alt={alt} loading="lazy"/>
      {label && <span>{label}</span>}
    </a>
  );
}

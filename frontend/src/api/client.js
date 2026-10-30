// Klien HTTP tunggal untuk /api. Token disimpan di modul agar semua request memakai sesi yang sama.
let token = null;
let onUnauthorized = () => {};

export const setToken = value => { token = value; };
export const setUnauthorizedHandler = fn => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function messageOf(payload, status) {
  const detail = payload?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map(d => d.msg).join(', ');
  return `HTTP ${status}`;
}

export async function api(path, {method = 'GET', body, signal} = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      signal,
      headers: {
        ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
        ...(token ? {Authorization: `Bearer ${token}`} : {}),
      },
      ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Server tidak dapat dihubungi. Periksa koneksi jaringan.', 0);
  }
  const payload = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(messageOf(payload, res.status), res.status);
  }
  return payload;
}

export async function fetchBlob(url, signal) {
  const res = await fetch(url, {signal, headers: token ? {Authorization: `Bearer ${token}`} : {}});
  if (!res.ok) throw new ApiError('Berkas tidak tersedia', res.status);
  return res.blob();
}

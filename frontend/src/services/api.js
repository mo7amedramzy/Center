const apiBaseUrl = (import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '');

export async function request(path, { token, ...options } = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'تعذر تنفيذ الطلب');
  return payload;
}

const TOKEN_KEY = 'copybolt_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'something went wrong');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  health: () => request('/health'),
  signup: (body) => request('/signup', { method: 'POST', body }),
  login: (body) => request('/login', { method: 'POST', body }),
  me: () => request('/me'),
  options: () => request('/options'),
  generate: (body) => request('/generate', { method: 'POST', body }),
  history: () => request('/history'),
  billingConfigured: () => request('/billing/configured'),
  checkout: () => request('/billing/checkout', { method: 'POST' }),
  portal: () => request('/billing/portal', { method: 'POST' }),
  adminStats: () => request('/admin/stats'),
};

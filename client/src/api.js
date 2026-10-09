const TOKEN_KEY = 'profitai_token';

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
    const err = new Error(data.error || 'שגיאה');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  health: () => request('/health'),
  login: (password) => request('/login', { method: 'POST', body: { password } }),

  getSettings: () => request('/settings'),
  updateSettings: (patch) => request('/settings', { method: 'PATCH', body: patch }),

  getSources: () => request('/sources'),
  rescanSources: () => request('/sources/rescan', { method: 'POST' }),

  getOpportunities: () => request('/opportunities'),
  getOpportunity: (id) => request(`/opportunities/${id}`),
  createDigitalProduct: (topic, audience) => request('/opportunities/digital-product', { method: 'POST', body: { topic, audience } }),
  updateOpportunity: (id, patch) => request(`/opportunities/${id}`, { method: 'PATCH', body: patch }),
  publishOpportunity: (id) => request(`/opportunities/${id}/publish`, { method: 'POST' }),

  getApprovals: () => request('/approvals'),
  approve: (opportunityId, actionType) => request('/approvals', { method: 'POST', body: { opportunityId, actionType } }),
  reject: (id) => request(`/approvals/${id}/reject`, { method: 'POST' }),

  getLedgerSummary: () => request('/ledger/summary'),
  getLedgerEntries: () => request('/ledger/entries'),

  getActions: () => request('/actions'),

  getFinancialWatchlist: () => request('/financial/watchlist'),
  addToWatchlist: (symbol) => request('/financial/watchlist', { method: 'POST', body: { symbol } }),
  paperTrade: (trade) => request('/financial/paper-trade', { method: 'POST', body: trade }),
  getPaperTrades: () => request('/financial/paper-trades'),

  getDigests: () => request('/digests'),
  generateDigest: () => request('/digests/generate', { method: 'POST' }),

  getProduct: (slug) => request(`/products/${slug}`),
};

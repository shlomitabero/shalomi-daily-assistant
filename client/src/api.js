const TOKEN_KEY = 'profitai_token';

// Some restricted browser contexts (Safari private browsing with storage
// fully disabled is the documented example elsewhere in this app - see
// ErrorBoundary.jsx's own getToken() guard) throw on any localStorage
// access at all. Unguarded here was far worse than anywhere else: every
// single request() call below - authenticated or not, including the
// public getProduct/getProductGuide calls a real paying customer's own
// browser makes on the product page - reads getToken() first, before the
// actual fetch. A throw here failed the request before it even started,
// with no network error to show, just a raw exception surfacing as
// "המוצר לא נמצא" on the one page a real customer trying to buy something
// actually lands on.
export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Best-effort only, same reasoning as the getter above - losing
    // "stay logged in" on this one restricted browser is an acceptable
    // tradeoff; crashing every request this app makes is not.
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // fetch() itself throws on a real network failure (offline, DNS, the
    // server unreachable) — never on an HTTP error status, which lands
    // below instead. Uncaught, that raw browser error (e.g. "Failed to
    // fetch") has an English message and no `.data`, so every page's
    // `err.data?.error || err.message` fallback would show English text
    // dropped into this otherwise all-Hebrew app.
    const networkErr = new Error('בעיית תקשורת — בדוק את החיבור לאינטרנט ונסה שוב');
    networkErr.data = { error: networkErr.message };
    throw networkErr;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A 401 from /login itself just means "wrong password" — it says
    // nothing about any previous session, and dispatching auth:expired here
    // made AuthContext show "ההתחברות הקודמת פגה" (the previous login
    // expired) on a fresh, failed login attempt where no session ever
    // existed. Every other endpoint requires an existing token, so a 401
    // there really does mean that token is now invalid/expired.
    if (res.status === 401 && path !== '/login') {
      // Without this, an expired/invalid token leaves every page stuck
      // showing a raw "not authenticated" error forever — authed state in
      // AuthContext only ever changes on an explicit login()/logout() call,
      // never on a failed request, so the owner would have no way back to
      // the login screen short of manually clearing localStorage.
      setToken(null);
      window.dispatchEvent(new Event('auth:expired'));
    }
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
  rejectOpportunity: (id) => request(`/opportunities/${id}/reject`, { method: 'POST' }),
  runAutonomousScan: () => request('/opportunities/autonomous-scan', { method: 'POST' }),

  getApprovals: () => request('/approvals'),
  approve: (opportunityId, actionType) => request('/approvals', { method: 'POST', body: { opportunityId, actionType } }),
  reject: (id) => request(`/approvals/${id}/reject`, { method: 'POST' }),

  getLedgerSummary: () => request('/ledger/summary'),
  getLedgerEntries: () => request('/ledger/entries'),

  getActions: () => request('/actions'),
  reportClientError: (message, path) => request('/actions/client-error', { method: 'POST', body: { message, path } }),

  getFinancialWatchlist: () => request('/financial/watchlist'),
  addToWatchlist: (symbol) => request('/financial/watchlist', { method: 'POST', body: { symbol } }),
  refreshWatchlistEntry: (id) => request(`/financial/watchlist/${id}/refresh`, { method: 'POST' }),
  removeFromWatchlist: (id) => request(`/financial/watchlist/${id}`, { method: 'DELETE' }),
  paperTrade: (trade) => request('/financial/paper-trade', { method: 'POST', body: trade }),
  getPaperTrades: () => request('/financial/paper-trades'),

  getDigests: () => request('/digests'),
  generateDigest: () => request('/digests/generate', { method: 'POST' }),

  getProduct: (slug) => request(`/products/${slug}`),
  getProductGuide: (slug, transactionId) => request(`/products/${slug}/guide?transactionId=${encodeURIComponent(transactionId)}`),
};

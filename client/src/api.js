const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed: ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  createPlayer: (payload) => request('/players', { method: 'POST', body: JSON.stringify(payload) }),
  getPlayer: (id) => request(`/players/${id}`),
  getPublicProfile: (id) => request(`/players/${id}/public`),
  getLegacy: (id) => request(`/players/${id}/legacy`),

  getOpportunities: (id) => request(id ? `/players/${id}/opportunities` : '/opportunities'),
  buyBusiness: (id, opportunityId) => request(`/players/${id}/businesses`, { method: 'POST', body: JSON.stringify({ opportunityId }) }),
  getBusiness: (id, bizId) => request(`/players/${id}/businesses/${bizId}`),
  hire: (id, bizId, payload) => request(`/players/${id}/businesses/${bizId}/hire`, { method: 'POST', body: JSON.stringify(payload) }),
  fire: (id, bizId, employeeId) => request(`/players/${id}/businesses/${bizId}/fire`, { method: 'POST', body: JSON.stringify({ employeeId }) }),
  upgradeMarketing: (id, bizId) => request(`/players/${id}/businesses/${bizId}/marketing`, { method: 'POST' }),
  sellBusiness: (id, bizId) => request(`/players/${id}/businesses/${bizId}/sell`, { method: 'POST' }),
  franchiseBusiness: (id, bizId) => request(`/players/${id}/businesses/${bizId}/franchise`, { method: 'POST' }),
  advanceDay: (id) => request(`/players/${id}/advance-day`, { method: 'POST' }),
  dismissEvent: (id, eventId) => request(`/players/${id}/events/${eventId}/dismiss`, { method: 'POST' }),
  decideEvent: (id, eventId, payload) => request(`/players/${id}/events/${eventId}/decide`, { method: 'POST', body: JSON.stringify(payload) }),

  getLoans: (id) => request(`/players/${id}/loans`),
  takeLoan: (id, kind, amount) => request(`/players/${id}/loans`, { method: 'POST', body: JSON.stringify({ kind, amount }) }),
  repayLoan: (id, loanId, amount) => request(`/players/${id}/loans/${loanId}/repay`, { method: 'POST', body: JSON.stringify({ amount }) }),

  getProperties: () => request('/properties'),
  buyProperty: (id, propId) => request(`/players/${id}/properties/${propId}/buy`, { method: 'POST' }),
  sellProperty: (id, propId) => request(`/players/${id}/properties/${propId}/sell`, { method: 'POST' }),
  renovateProperty: (id, propId) => request(`/players/${id}/properties/${propId}/renovate`, { method: 'POST' }),

  getNegotiationTargets: () => request('/negotiation/targets'),
  startNegotiation: (id, targetId) => request(`/players/${id}/negotiations/start`, { method: 'POST', body: JSON.stringify({ targetId }) }),
  getNegotiation: (id, offerId) => request(`/players/${id}/negotiations/${offerId}`),
  sendNegotiationMessage: (id, offerId, text) => request(`/players/${id}/negotiations/${offerId}/message`, { method: 'POST', body: JSON.stringify({ text }) }),

  getInvestTargets: (id) => request(`/players/${id}/invest/targets`),
  invest: (id, businessId, stakePct) => request(`/players/${id}/invest/${businessId}`, { method: 'POST', body: JSON.stringify({ stakePct }) }),

  getRanks: () => request('/ranks'),
  getFeed: () => request('/feed'),
  getLeaderboard: (category) => request(`/leaderboard?category=${category}`),
  getDailyOpportunity: (id) => request(`/players/${id}/daily-opportunity`),
  getRival: (id) => request(`/players/${id}/rival`),
};

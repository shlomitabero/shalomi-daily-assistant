import { db } from '../db/store.js';

const SETTINGS_ID = 'main';

const DEFAULTS = {
  id: SETTINGS_ID,
  budgetConfigured: false,
  budget: 0,
  maxLoss: null,
  country: null,
  currency: 'ILS',
  preferredCategories: [],
  mode: 'research', // 'research' | 'approve' | 'auto_limited'
  emergencyStop: false,
  createdAt: new Date().toISOString(),
};

export function getSettings() {
  return db.settings.get(SETTINGS_ID) ?? db.settings.insert({ ...DEFAULTS });
}

export function updateSettings(patch) {
  getSettings(); // ensure the row exists
  return db.settings.update(SETTINGS_ID, patch);
}

import { Router } from 'express';
import { requireOwner } from '../middleware/auth.js';
import { getSettings, updateSettings } from '../services/settings.js';

export const settingsRouter = Router();

export function readSettings(req, res) {
  res.json({ settings: getSettings() });
}

const ALLOWED_FIELDS = ['budget', 'maxLoss', 'country', 'currency', 'preferredCategories', 'mode', 'emergencyStop'];
const VALID_MODES = ['research', 'approve', 'auto_limited'];

export function patchSettings(req, res) {
  const patch = {};
  for (const field of ALLOWED_FIELDS) {
    if (field in (req.body ?? {})) patch[field] = req.body[field];
  }
  if ('mode' in patch && !VALID_MODES.includes(patch.mode)) {
    return res.status(400).json({ error: `mode must be one of ${VALID_MODES.join(', ')}` });
  }
  if ('budget' in patch) {
    if (typeof patch.budget !== 'number' || !Number.isFinite(patch.budget) || patch.budget < 0) {
      return res.status(400).json({ error: 'budget must be a non-negative number' });
    }
    patch.budgetConfigured = true;
  }
  if ('maxLoss' in patch && patch.maxLoss !== null) {
    if (typeof patch.maxLoss !== 'number' || !Number.isFinite(patch.maxLoss) || patch.maxLoss < 0) {
      return res.status(400).json({ error: 'maxLoss must be null (no limit) or a non-negative number' });
    }
  }
  res.json({ settings: updateSettings(patch) });
}

settingsRouter.get('/settings', requireOwner, readSettings);
settingsRouter.patch('/settings', requireOwner, patchSettings);

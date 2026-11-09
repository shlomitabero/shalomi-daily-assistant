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
    return res.status(400).json({ error: `מצב הפעולה חייב להיות אחד מ: ${VALID_MODES.join(', ')}` });
  }
  if ('budget' in patch) {
    if (typeof patch.budget !== 'number' || !Number.isFinite(patch.budget) || patch.budget < 0) {
      return res.status(400).json({ error: 'תקציב חייב להיות מספר לא שלילי' });
    }
    // Settings.jsx's form always resubmits every field together on save
    // (a controlled form, not a per-field PATCH), so `budget` is present
    // in the request body on every save, including one made only to
    // change country or mode. Marking budgetConfigured true just because
    // the key was present - even at its untouched default of 0 - would
    // fabricate a "the owner decided on a budget" status the owner never
    // actually gave, and silently dismiss the dashboard's "set a budget"
    // nudge the first time they save anything at all. Only a genuinely
    // positive budget counts as a real decision.
    if (patch.budget > 0) patch.budgetConfigured = true;
  }
  if ('maxLoss' in patch && patch.maxLoss !== null) {
    if (typeof patch.maxLoss !== 'number' || !Number.isFinite(patch.maxLoss) || patch.maxLoss < 0) {
      return res.status(400).json({ error: 'הפסד מרבי חייב להיות ריק (ללא הגבלה) או מספר לא שלילי' });
    }
  }
  // mode/budget/maxLoss above all reject a malformed value instead of
  // storing it as-is - emergencyStop, the one field meant for "use the
  // moment something looks wrong", was the sole exception. A non-boolean
  // (e.g. the string "false", truthy in JS) would otherwise get stored
  // verbatim and read back as an emergency stop the owner never actually
  // set - or, cleared the same way, silently fail to turn it back off.
  if ('emergencyStop' in patch && typeof patch.emergencyStop !== 'boolean') {
    return res.status(400).json({ error: 'עצירת חירום חייבת להיות ערך בוליאני (true/false)' });
  }
  res.json({ settings: updateSettings(patch) });
}

settingsRouter.get('/settings', requireOwner, readSettings);
settingsRouter.patch('/settings', requireOwner, patchSettings);

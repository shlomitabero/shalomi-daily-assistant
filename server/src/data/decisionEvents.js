// Decision Engine (section 11). Unlike the flavor events in events.js, these
// never auto-apply an effect — they stop the player with real options
// (or a free-text response) and the consequence depends on what they pick.

export const DECISION_EVENTS = [
  {
    id: 'decision_manager_raise',
    headline: (business, employee) => `${employee.name} (${employee.role}) at ${business.name} is asking for a 30% raise.`,
    options: [
      { key: 'pay', label: 'PAY' },
      { key: 'negotiate', label: 'NEGOTIATE' },
      { key: 'equity', label: 'OFFER EQUITY' },
      { key: 'refuse', label: 'REFUSE' },
      { key: 'fire', label: 'FIRE' },
    ],
  },
];

export function pickDecisionEvent() {
  return DECISION_EVENTS[Math.floor(Math.random() * DECISION_EVENTS.length)];
}

/**
 * The browser tab/title bar always just said "Forge AI", no matter which
 * project was open -- with two or more projects open in separate tabs
 * there was no way to tell them apart from the tab bar, alt-tab switcher,
 * or browser history without clicking into each one.
 *
 * `unreadWhatsAppCount` and `failingAutomationsCount` both prefix into the
 * same single "(N) " count, the same Gmail/Slack convention this app's own
 * WhatsApp/Automations badges already use in-page -- an in-page badge only
 * ever catches someone's eye while this tab is already focused and
 * visible; the whole point of a badge like this is to be seen from the tab
 * bar/alt-tab switcher too, while working in a different tab. A failing
 * automation (round 710) deserves that same out-of-tab visibility as an
 * unread WhatsApp message -- both are "needs attention" signals from an
 * always-running background poll, so they're combined into one count
 * rather than each getting its own separate prefix.
 */
export function formatDocumentTitle(
  projectName: string | null,
  unreadWhatsAppCount = 0,
  failingAutomationsCount = 0,
): string {
  const base = projectName ? `${projectName} · Forge AI` : "Forge AI";
  const count = unreadWhatsAppCount + failingAutomationsCount;
  return count > 0 ? `(${count}) ${base}` : base;
}

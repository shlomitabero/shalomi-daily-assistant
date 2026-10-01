/**
 * The browser tab/title bar always just said "Forge AI", no matter which
 * project was open -- with two or more projects open in separate tabs
 * there was no way to tell them apart from the tab bar, alt-tab switcher,
 * or browser history without clicking into each one.
 *
 * `unreadWhatsAppCount` prefixes a "(N) " count, the same Gmail/Slack
 * convention this app's own WhatsApp badge already uses in-page -- the
 * in-page `whatsapp-unread-badge` only ever caught someone's eye while the
 * tab itself was already focused and visible; the whole point of a badge
 * like this is to be seen from the tab bar/alt-tab switcher too, while
 * working in a different tab.
 */
export function formatDocumentTitle(projectName: string | null, unreadWhatsAppCount = 0): string {
  const base = projectName ? `${projectName} · Forge AI` : "Forge AI";
  return unreadWhatsAppCount > 0 ? `(${unreadWhatsAppCount}) ${base}` : base;
}

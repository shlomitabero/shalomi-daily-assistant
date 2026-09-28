/**
 * The browser tab/title bar always just said "Forge AI", no matter which
 * project was open -- with two or more projects open in separate tabs
 * there was no way to tell them apart from the tab bar, alt-tab switcher,
 * or browser history without clicking into each one.
 */
export function formatDocumentTitle(projectName: string | null): string {
  return projectName ? `${projectName} · Forge AI` : "Forge AI";
}

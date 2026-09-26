const STORAGE_KEY = "forge.ideaDraft";

/**
 * The home screen's own idea textarea was the one piece of "what you're
 * currently working on" state in this app that DIDN'T survive a reload --
 * pinned projects, column visibility, language, and the auth token all do
 * (see pinnedProjects.ts/columnVisibility.ts/api.ts's own localStorage
 * usage). A half-typed, thoughtfully-written business description is
 * exactly the kind of thing a person hates losing to an accidental reload
 * or a closed tab.
 */
export function getIdeaDraft(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveIdeaDraft(text: string): void {
  try {
    if (text.trim() === "") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, text);
  } catch {
    // localStorage can be unavailable (private mode) -- the draft just won't survive a reload.
  }
}

export function clearIdeaDraft(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage can be unavailable (private mode) -- nothing to clear.
  }
}

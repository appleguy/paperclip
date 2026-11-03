import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "paperclip:composer:enter-to-send";
const CHANGED_EVENT = "paperclip:composer-enter-to-send-changed";

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Per-browser preference: plain Enter sends the composer message and
 * Shift+Enter inserts a newline. Off by default so existing users keep
 * Cmd/Ctrl+Enter to send and Enter for a newline.
 */
export function useComposerEnterToSend(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, read, () => false);
  const setEnabled = useCallback((next: boolean) => {
    try {
      if (next) localStorage.setItem(STORAGE_KEY, "1");
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage unavailable (private mode): the preference simply does not persist.
    }
    window.dispatchEvent(new Event(CHANGED_EVENT));
  }, []);
  return [enabled, setEnabled];
}

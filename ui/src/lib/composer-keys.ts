/**
 * Cmd/Ctrl+. detection that survives non-QWERTY layouts.
 *
 * `event.code` names the physical key position, so on Dvorak the "V" key
 * reports `code: "Period"` and Cmd/Ctrl+V would be mistaken for the mode
 * shortcut. Trust `key` whenever it names a printable character; fall back to
 * `code` only when `key` carries no character (some iOS hardware keyboards
 * report `Unidentified` or an empty key for Cmd+Period).
 */
export function isPeriodShortcutKey(event: { key: string; code?: string }): boolean {
  if (event.key === ".") return true;
  return event.code === "Period" && [...event.key].length !== 1;
}

/**
 * Enter that should send when a composer opted into Enter-to-send: no
 * modifier (Shift+Enter stays a newline, Cmd/Ctrl+Enter is handled
 * separately) and not the Enter that confirms an IME composition.
 */
export function isPlainEnterSend(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  if (event.key !== "Enter") return false;
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
  if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return false;
  return true;
}

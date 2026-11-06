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

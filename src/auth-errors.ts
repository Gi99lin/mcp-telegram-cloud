/**
 * The one list of Telegram errors that mean "this session is dead, not just unlucky".
 *
 * WHY IT IS SHARED (issue #19 review finding): `tool-registry.ts` used this list to decide
 * whether to revoke OAuth, while `session-manager.ts` decided whether to DELETE the stored
 * `session_string` from a plain boolean — `TelegramService.connect()` returns `false` for
 * network failures just as it does for a revoked auth key. A transient stall therefore
 * looked exactly like a revoked session and logged the user out permanently, which is a
 * worse outcome than the wedge this change set is fixing.
 *
 * The rule: destroy persisted credentials ONLY on positive evidence from Telegram that they
 * are invalid. Silence, timeouts and network errors are not evidence.
 *
 * Deliberately NOT here: `AUTH_KEY_DUPLICATED`. It means "this key is in use by another
 * connection", i.e. a live, valid session — deleting it would turn a recoverable collision
 * into a forced re-login.
 */
export const AUTH_ERROR_PATTERNS = [
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_INVALID",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
] as const;

/** True when `message` carries positive evidence that the session is no longer usable. */
export function isAuthErrorMessage(message: string | undefined | null): boolean {
  if (!message) return false;
  return AUTH_ERROR_PATTERNS.some((p) => message.includes(p));
}

/** Same test for a thrown value. */
export function isAuthError(error: unknown): boolean {
  return isAuthErrorMessage(error instanceof Error ? error.message : String(error));
}

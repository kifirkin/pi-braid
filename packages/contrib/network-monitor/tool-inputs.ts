/**
 * Input resolution for the tunnel tools' `client` parameter.
 *
 * Why this module exists: `params?.client ?? settingsNow().client` falls
 * through only on null or undefined, so a blank parameter survived the
 * coalesce, failed the client-id check, and was refused as `Unknown client ""`.
 * That message named the empty argument as the cause while the configured
 * client sat unread: the caller had asked for the default and got a refusal
 * about a client id nobody typed.
 *
 * The rule: a blank (or whitespace-only) parameter means "the configured
 * client", so it resolves to absent and the settings value applies. A
 * non-blank value is returned exactly as given, spelling included: trimming a
 * padded id would change the behaviour of a value this fix does not touch.
 */
export function resolveClientParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() === "" ? undefined : value;
}

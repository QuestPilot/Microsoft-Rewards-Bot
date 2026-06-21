/**
 * Proxy URL helpers — IPv6-safe host handling.
 *
 * A bare IPv6 literal (e.g. `2001:db8::1`) cannot be concatenated with `:port` in a
 * URL: `2001:db8::1:8080` is ambiguous. IPv6 hosts must be bracketed first:
 * `[2001:db8::1]:8080`. IPv4 addresses, hostnames, already-bracketed IPv6, and full
 * URLs (containing `://`) are returned unchanged.
 */

/** A bare IPv6 literal has 2+ colons; `host:port` has exactly one; IPv4/hostnames have none. */
export function isBareIPv6(host: string): boolean {
    if (!host || host.startsWith('[') || host.includes('://')) return false
    return (host.match(/:/g) ?? []).length >= 2
}

/** Bracket a bare IPv6 host so it can be safely combined with a port. No-op otherwise. */
export function bracketIPv6IfNeeded(host: string): string {
    return isBareIPv6(host) ? `[${host}]` : host
}

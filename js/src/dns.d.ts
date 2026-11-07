// Types for "@fitzdoud/valun/dns" (Node only).

/** Looks the host name up with the system resolver; 'public' if any address is globally reachable. No connection is made. */
export function resolveHost(host: string): Promise<'public' | 'private' | 'not_found'>;

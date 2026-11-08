// Types for "@fitzdoud/valun/file-store" (Node only).
import type {ClientState, ValunStore} from './index.js';

/**
 * One private JSON file holding the client's state, the agent's secret key and its agent token, in the same layout as
 * the Python client's FileStore. Written atomically through a fresh 0600 temporary file; the folder is created 0700.
 * update() and reload() use the Python FileStore's lock protocol on the same files ('<path>.lock', O_EXCL), so a
 * Python and a JavaScript client can share one profile without losing each other's records.
 */
export class FileStore implements ValunStore {
  /** How long update() waits for another process's lock before rejecting with profile_busy (5000). */
  static LOCK_WAIT_MS: number;
  /** A lock older than this (30000) was left by a process that died and is replaced. */
  static LOCK_STALE_MS: number;
  constructor(filePath: string);
  readonly path: string;
  state: ClientState;
  secret(): string | null;
  token(): string | null;
  save(): void;
  saveCredentials(secretHex: string, token: string): void;
  /**
   * Under the profile lock: reload the file, apply fn (synchronous) to the non-secret state as stored now, save it
   * atomically and update `state` in place. If fn throws, nothing is saved or changed. Rejects with profile_busy or
   * records_unreadable (the file is then never overwritten).
   */
  update<T>(fn: (state: ClientState) => T): Promise<T>;
  /** Replace `state` (in place) with the file's contents, if the file exists (records_unreadable when it cannot be read). */
  reload(): void;
}

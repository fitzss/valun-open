// Types for "valun/file-store" (Node only).
import type {ClientState, ValunStore} from './index.js';

/**
 * One private JSON file holding the client's state, the agent's secret key and its agent token, in the same layout as
 * the Python client's FileStore. Written atomically through a fresh 0600 temporary file; the folder is created 0700.
 */
export class FileStore implements ValunStore {
  constructor(filePath: string);
  readonly path: string;
  state: ClientState;
  secret(): string | null;
  token(): string | null;
  save(): void;
  saveCredentials(secretHex: string, token: string): void;
}

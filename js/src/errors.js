/** Every refusal of the client, and every HTTP error of the server, is a ValunError with a stable `code`. */
export class ValunError extends Error {
  constructor(code, message, status = undefined, extra = {}) {
    super(message);
    this.name = 'ValunError';
    this.code = code;
    this.status = status;
    this.extra = extra || {};
  }
}

/** Raised by the Basis signer for malformed keys, points or note fields (the Python client's SignatureError). */
export class SignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SignatureError';
  }
}

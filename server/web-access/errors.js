export class WebAccessError extends Error {
  constructor(code) { super(code); this.name = 'WebAccessError'; this.code = code; }
}
export const fail = code => { throw new WebAccessError(code); };
export function safeCode(error) {
  if (error instanceof WebAccessError) return error.code;
  if (error?.name === 'TimeoutError') return 'WEB_TIMEOUT';
  if (error?.name === 'AbortError') return 'WEB_CANCELLED';
  return 'WEB_UNAVAILABLE';
}

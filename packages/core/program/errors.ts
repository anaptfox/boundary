/**
 * One error base for the Boundary production libraries. Every stable diagnostic
 * class is a thin subclass: it owns its own diagnostic code union and any
 * extra fields, but shares this message template and cause plumbing.
 */
export class BoundaryErrorBase extends Error {
  readonly code: string;
  readonly path: string;
  override readonly cause?: unknown;

  constructor(
    code: string,
    path: string,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(`${code} at ${path}: ${message}`);
    this.code = code;
    this.path = path;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

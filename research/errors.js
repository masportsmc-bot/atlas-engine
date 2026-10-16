// Typed research failure carrying raw evidence and stage diagnostics for the failure record.
export class ResearchError extends Error {
  constructor(code, detail, raw) { super(`${code}${detail ? `: ${detail}` : ''}`); this.code = code; this.raw = raw; }
}

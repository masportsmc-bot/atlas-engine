// The exact epistemic violations of the real Andino (anonymised "Despacho Ejemplo") Blueprint outputs 7f88ecf4 / cfbb04c1
// under the evidence levels. Older replay tests (numeric provenance, enumeration, normalization) exclude ONLY these,
// matched by code AND path, so every pre-existing control is still asserted at zero on the real outputs.
export const ANDINO_EPISTEMIC_VIOLATIONS = Object.freeze([
  { code: 'ESTABLISHED_ON_OBSERVATION', path: '$.refined_diagnosis[0]' },              // RD1 rests on F1 (Manuel's CONTEXT) + F2 (Manuel's signal)
  { code: 'ESTABLISHED_ON_OBSERVATION', path: '$.refined_diagnosis[2]' },              // RD3 rests on F1 + BI3
  { code: 'UNSUPPORTED_VERIFICATION_CLAIM', path: '$.refined_diagnosis[0].statement' }, // "carencias cualitativas verificadas"
]);
export const withoutAndinoEpistemic = (v) => !ANDINO_EPISTEMIC_VIOLATIONS.some((a) => a.code === v.code && a.path === v.path);

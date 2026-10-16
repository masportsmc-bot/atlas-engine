// Human-readable rendering of a research run. Presentation only: it reorders and formats the raw result and the
// deterministic coverage; it never adds, removes or rewrites content.
export function renderReport(r, spec) {
  const claims = new Map(r.result.claims.map((c) => [c.key, c])); const ev = new Map(r.evidence.map((e) => [e.id, e]));
  const srcs = (keys) => [...new Set(keys.flatMap((k) => claims.get(k)?.evidence_ids || []))].map((e) => ev.get(e)).filter(Boolean);
  const cov = new Map(r.coverage.map((c) => [`${c.category_key}/${c.entity_key}`, c]));
  const L = [`# ATLAS research result — ${spec.title}`, '', `Statuses are CANDIDATE or SHORTLIST only. Nothing is approved; approval requires human validation by M.`, ''];
  for (const cat of r.result.categories) {
    const sc = spec.categories.find((c) => c.key === cat.category_key);
    L.push(`## ${sc?.label ?? cat.category_key}`, '');
    for (const n of cat.category_notes) L.push(`> ${n}`);
    for (const en of cat.entities) {
      const c = cov.get(`${cat.category_key}/${en.entity_key}`);
      L.push(`### ${en.name} — ${en.status} — evidence coverage ${c?.grade} — next action ${en.next_action}`, '');
      L.push(`- Location / area: ${en.location_area.value ?? 'UNVERIFIED'}`);
      for (const f of en.fields) L.push(`- ${sc?.fields.find((x) => x.key === f.field_key)?.label ?? f.field_key}: ${f.status === 'SUPPORTED' ? f.value : 'UNVERIFIED'}`);
      for (const x of en.contact) L.push(`- Contact (${x.type}): ${x.value}`);
      L.push(`- Positive signals: ${en.positive_signals.map((s) => s.text).join(' · ') || '—'}`, `- Risks / gaps: ${en.risks_gaps.map((s) => s.text).join(' · ') || '—'}`,
        `- Missing information: ${en.missing_information.join(' · ') || '—'}`, `- Reason Why: ${en.reason_why.text}`, `- Next action: ${en.next_action} — ${en.next_action_rationale}`);
      const s = srcs([en.location_area.claim_keys, ...en.fields.map((f) => f.claim_keys), en.reason_why.claim_keys, ...en.positive_signals.map((p) => p.claim_keys)].flat());
      L.push(`- Sources: ${s.map((e) => `${e.id}${e.verified ? '' : ' (unconfirmed)'} ${e.url}`).join(' ; ') || '—'}`, '');
    }
  }
  const t = r.provenance_tiers;
  if (t) {
    L.push('## Provenance tiers (per claim)', '', 'Strongest verification among each claim\'s cited evidence: ENGINE_FETCHED_PAGE > MODEL_FETCHED_PAGE > SEARCH_CITATION > UNCONFIRMED.', '');
    for (const [label, rows] of [['ENGINE_FETCH-supported (independently re-fetched by the engine)', t.ENGINE_FETCH_SUPPORTED],
      ['MODEL_FETCHED_PAGE only (page retrieved by the model\'s fetch tool, not independently re-fetched)', t.MODEL_FETCHED_PAGE_ONLY],
      ['SEARCH_CITATION only (search-result citation, no full page)', t.SEARCH_CITATION_ONLY], ['UNVERIFIED (no verified evidence)', t.UNVERIFIED]]) {
      L.push(`### ${label}: ${rows.length}`, '');
      for (const x of rows) L.push(`- ${x.key} [${x.classification}] ${x.statement} — ${x.evidence.join(', ') || 'no evidence'}`);
      L.push('');
    }
  }
  L.push('## Overall', '', `- Unknowns: ${r.result.overall.unknowns.join(' · ') || '—'}`, `- Risks: ${r.result.overall.risks.join(' · ') || '—'}`, `- Coverage note: ${r.result.overall.coverage_note}`);
  return L.join('\n');
}

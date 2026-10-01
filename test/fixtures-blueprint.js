// Synthetic, anonymised Blueprint fixtures shaped like the first governed production case (public repo: no prospect data).
const RADAR_ITEM = '11111111-1111-4111-8111-111111111111';
const RADAR_DECISION = '22222222-2222-4222-8222-222222222222';
const MOD_EVENT = '33333333-3333-4333-8333-333333333333';
const PREV_BP_ITEM = '44444444-4444-4444-8444-444444444444';

export const radarSnapshot = {
  contract_version: 'radar_core/0.1',
  signal_understanding: { observed: 'o', subject: { kind: 'COMPANY', name: 'Despacho Ejemplo', organization_id: null }, trigger: 't' },
  evidence: [
    { id: 'E1', content: 'Web de Despacho Ejemplo abandonada y con oportunidad clara de rediseño', source_type: 'MANUEL_OBSERVATION', source_ref: null, provided_by: 'SIGNAL', observed_at: null },
    { id: 'E2', content: 'La web actual es muy básica, con textos genéricos y contacto poco trabajado; el despacho tiene 3 sedes.', source_type: 'CONTEXT', source_ref: null, provided_by: 'CONTEXT', observed_at: null },
  ],
  facts: [
    { id: 'F1', statement: 'La web tiene textos genéricos y contacto poco trabajado.', evidence_ids: ['E2'] },
    { id: 'F2', statement: 'Manuel considera la web abandonada.', evidence_ids: ['E1'] },
  ],
  inferences: [{ id: 'I1', statement: 'La web no está optimizada para convertir visitas.', basis_ids: ['F1'], reasoning: 'r' }],
  hypotheses: [{ id: 'H1', statement: 'La debilidad de la web limita la captación.', basis_ids: ['F1'], would_confirm: 'c', would_refute: 'r' }],
  unknowns: [
    { id: 'U1', question: '¿Interés del despacho?', materiality: 'DECISION_CRITICAL', why_it_matters: 'w', resolvable_by: 'PROSPECT' },
    { id: 'U2', question: '¿Métricas actuales?', materiality: 'DECISION_CRITICAL', why_it_matters: 'w', resolvable_by: 'PROSPECT' },
    { id: 'U3', question: '¿Presupuesto?', materiality: 'USEFUL', why_it_matters: 'w', resolvable_by: 'PROSPECT' },
  ],
  diagnoses: [
    { id: 'D1', statement: 'Carencias de contenido y estructura.', supporting_ids: ['F1'], assumption_ids: [], alternative_explanation: 'a', strength: 'TENTATIVE' },
    { id: 'D2', statement: 'Elementos de conversión débiles reducen captación.', supporting_ids: ['F1', 'I1'], assumption_ids: ['H1'], alternative_explanation: 'a', strength: 'TENTATIVE' },
  ],
  candidates: [{ id: 'C1', title: 'Rediseño web', diagnosis_ids: ['D1', 'D2'], intervention: 'i',
    reason_why: { signal: 's', business_consequence: 'b', intervention: 'i', potential_value: 'v', value_basis_ids: [], value_is_quantified: false },
    routing: [{ engine: 'FACTORY', rationale: 'r' }, { engine: 'GROWTH', rationale: 'r' }],
    evidence_sufficiency: { level: 'PARTIAL', rationale: 'r' }, critical_unknown_ids: ['U1', 'U2'], risks: [], dependencies: [],
    recommended_disposition: 'NEEDS_MORE_INFO', disposition_rationale: 'r' }],
  overall_recommendation: { disposition: 'NEEDS_MORE_INFO', proceed_candidate_ids: [], rationale: 'r' },
  info_request: { questions: [{ unknown_id: 'U1', question: 'q', why: 'w', unblocks_ids: ['C1'], resolvable_by: 'PROSPECT', expected_effect: 'e' }] },
};

export const bpBundle = {
  bundle_version: 'blueprint_input/0.1',
  case: { case_id: '55555555-5555-4555-8555-555555555555', case_name: 'Despacho Ejemplo · 2026-09-30 12:38 UTC' },
  signal: { text: 'Web de Despacho Ejemplo abandonada y con oportunidad clara de rediseño', source_type: 'MANUEL_OBSERVATION', received_at: '2026-09-30T12:38:17Z', signal_sha256: 'h' },
  organization: null,
  prospect: { name: 'Despacho Ejemplo', website: 'despacho-ejemplo.example' },
  context: [{ event_id: '66666666-6666-4666-8666-666666666666', added_at: '2026-09-30T12:38:17Z', origin: 'SUBMISSION', content: 'La web actual es muy básica; el despacho tiene 3 sedes.', answers: null }],
  radar: { review_item_id: RADAR_ITEM, agent_run_id: '77777777-7777-4777-8777-777777777777', snapshot: radarSnapshot },
  radar_decision: {
    event_id: RADAR_DECISION, decision: 'MODIFY', selected_candidate_id: 'C1', approved_routes: ['FACTORY', 'GROWTH'], applied_disposition: 'PROCEED', decided_at: '2026-10-01T09:50:04Z',
    rationale: 'La oportunidad debe avanzar. Interés, presupuesto y métricas siguen siendo unknowns pero no bloquean una primera propuesta. No asumir como hecho que las deficiencias reduzcan la captación. FACTORY es la eventual implementación. No convertir en PRODUCT.',
  },
  commercial_modification: null,
  related_cases: [],
  authorization: { kind: 'START', event_id: '88888888-8888-4888-8888-888888888888' },
};

export const bpBundleModified = () => ({
  ...structuredClone(bpBundle),
  commercial_modification: { event_id: MOD_EVENT, modification: 'Centrar el pitch en señales de confianza.', rationale: 'r',
    previous_blueprint_review_item_id: PREV_BP_ITEM, previous_blueprint: { contract_version: 'growth_blueprint/0.1' } },
  authorization: { kind: 'COMMERCIAL_MODIFY', event_id: MOD_EVENT },
});

export const bpOutput = () => ({
  contract_version: 'growth_blueprint/0.1',
  basis: {
    radar_review_item_id: RADAR_ITEM, radar_decision_event_id: RADAR_DECISION, selected_candidate_id: 'C1', approved_routes: ['GROWTH', 'FACTORY'],
    radar_refs: { evidence_ids: ['E1', 'E2'], fact_ids: ['F1', 'F2'], inference_ids: ['I1'], hypothesis_ids: ['H1'], unknown_ids: ['U1', 'U2', 'U3'], diagnosis_ids: ['D1', 'D2'] },
    human_guidance: [{ id: 'G1', source: 'RADAR_DECISION', guidance: 'Unknowns no bloquean; impacto en captación no es un hecho; FACTORY eventual; sin PRODUCT.', how_applied: 'Unknowns como preguntas no bloqueantes; consecuencia clasificada como hipótesis; FACTORY solo como alcance.' }],
    commercial_modification_event_id: null,
  },
  additional_evidence: [],
  additional_facts: [],
  inferences: [{ id: 'BI1', statement: 'Una web renovada comunicaría mejor la especialización del despacho.', basis_ids: ['F1', 'I1'], reasoning: 'Los textos genéricos y el contacto débil impiden diferenciarse.' }],
  refined_diagnosis: [
    { id: 'RD1', statement: 'La presencia web no comunica la especialización ni facilita el contacto.', refines_ids: ['D1'], supporting_ids: ['F1', 'BI1'], assumption_ids: [], strength: 'ESTABLISHED', alternative_explanation: 'Estilo minimalista deliberado.' },
    { id: 'RD2', statement: 'Esa debilidad podría estar limitando la captación digital.', refines_ids: ['D2'], supporting_ids: ['I1'], assumption_ids: ['H1'], strength: 'TENTATIVE', alternative_explanation: 'La captación depende de referidos.' },
  ],
  reason_why: {
    signal: 'Web abandonada con textos genéricos y contacto poco trabajado.', business_consequence: 'Posible pérdida de clientes potenciales por el canal digital.',
    consequence_epistemic_class: 'HYPOTHESIS', consequence_basis_ids: ['RD2', 'H1'], intervention: 'Rediseño orientado a confianza y contacto.',
    value: 'Mejor comunicación de la especialización y un contacto más sencillo (cualitativo).', value_basis_ids: ['RD1'], value_is_quantified: false,
  },
  solution_blueprint: {
    objective: 'Proponer un rediseño que comunique especialización y facilite el contacto.',
    components: [
      { id: 'K1', name: 'Auditoría y propuesta', description: 'Diagnóstico compartido y propuesta comercial.', engine: 'GROWTH', addresses_ids: ['RD1', 'U1'] },
      { id: 'K2', name: 'Nueva web a medida', description: 'Contenidos, estructura y contacto para este despacho.', engine: 'FACTORY', addresses_ids: ['RD1', 'RD2'] },
    ],
    phases: [
      { id: 'P1', name: 'Demostración y validación', description: 'Presentar el concepto y resolver interés y prioridades.', engine: 'GROWTH', component_ids: ['K1'] },
      { id: 'P2', name: 'Implementación eventual', description: 'Solo si la oportunidad comercial progresa.', engine: 'FACTORY', component_ids: ['K2'] },
    ],
    factory_scope: { summary: 'Diseño y construcción de la nueva web para este despacho, si se acepta.', component_ids: ['K2'], executes_now: false },
    exclusions: ['No se construye nada en esta fase.', 'Sin oferta productizada.'],
  },
  demo_pitch: {
    narrative: 'Su web no refleja la calidad de su despacho; proponemos una presencia que transmita confianza y facilite el contacto.',
    demonstration_concept: 'Descripción de una página de inicio con especialidades, equipo y contacto directo.', demo_format: 'WIREFRAME_DESCRIPTION',
    key_messages: ['Especialización visible', 'Contacto sencillo'], claim_basis_ids: ['F1', 'RD1'],
  },
  commercial_questions: [
    { id: 'Q1', question: '¿Le interesa al despacho renovar su web?', unknown_ids: ['U1'], blocks_next_decision: false, rationale: 'Se resuelve en la conversación comercial.' },
    { id: 'Q2', question: '¿Qué métricas tienen hoy y qué presupuesto contemplan?', unknown_ids: ['U2', 'U3'], blocks_next_decision: false, rationale: 'Útil para dimensionar, no bloquea la propuesta inicial.' },
  ],
  risks: [{ id: 'R1', risk: 'El despacho puede no tener interés ni presupuesto.', mitigation: 'Validar interés antes de cualquier alcance FACTORY.' }],
  commercial_recommendation: { recommendation: 'APPROVE', rationale: 'Propuesta inicial lista para uso comercial de Manuel.', next_step: 'Manuel decide si y cómo presentarla.' },
});

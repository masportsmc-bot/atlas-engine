// Offline fixtures (synthetic, no real prospect data).
export const bundleA = {
  bundle_version: 'radar_input/0.1',
  signal: {
    case_id: '00000000-0000-4000-8000-00000000000a',
    text: 'Clínica Dental Sonrisa (14 locations in Gran Canaria) is running Instagram ads promising "first visit free". The ad lands on a contact form with 11 form fields and no online booking. Their marketing lead told me they spend about €3,000/month on ads.',
    source_type: 'ADVERTISEMENT',
    entered_by: 'user:8b933271-429e-429a-a407-8b03a01e6111',
    received_at: '2026-10-01T09:00:00Z',
    signal_sha256: 'x',
  },
  organization: null,
  prospect: { name: 'Clínica Dental Sonrisa', website: 'https://sonrisa.example' },
  context: [{ event_id: 'ctx-1', added_at: '2026-10-01T09:00:00Z', origin: 'SUBMISSION', content: 'I tested the form on mobile: it took 4 minutes.', answers: null, info_request_event_id: null }],
  related_cases: [{ case_id: 'rel-case-1', case_name: 'Sonrisa 2025', signal: 'Earlier contact about SEO', status: 'LEGACY', created_at: '2025-05-01', decisions: [] }],
  previous_assessment: null,
  latest_info_request: null,
};

export const outputA = () => ({
  contract_version: 'radar_core/0.1',
  signal_understanding: {
    observed: 'A dental chain advertises a free first visit but sends clicks to a long contact form without booking.',
    subject: { kind: 'COMPANY', name: 'Clínica Dental Sonrisa', organization_id: null },
    trigger: 'Paid acquisition feeding a high-friction conversion step.',
  },
  evidence: [
    { id: 'E1', content: 'Clínica Dental Sonrisa has 14 locations in Gran Canaria.', source_type: 'ADVERTISEMENT', source_ref: null, provided_by: 'SIGNAL', observed_at: null },
    { id: 'E2', content: 'The ad lands on a contact form with 11 form fields and no online booking.', source_type: 'ADVERTISEMENT', source_ref: null, provided_by: 'SIGNAL', observed_at: null },
    { id: 'E3', content: 'Ad spend is about €3,000/month according to their marketing lead.', source_type: 'RELATIONSHIP', source_ref: null, provided_by: 'SIGNAL', observed_at: null },
    { id: 'E4', content: 'Manuel tested the form on mobile: it took 4 minutes.', source_type: 'MANUEL_OBSERVATION', source_ref: null, provided_by: 'CONTEXT', observed_at: null },
    { id: 'E5', content: 'Prior Agency OS record: earlier contact about SEO.', source_type: 'AGENCY_OS_RECORD', source_ref: 'rel-case-1', provided_by: 'AGENCY_OS_RECORD', observed_at: null },
  ],
  facts: [
    { id: 'F1', statement: 'The company operates 14 locations.', evidence_ids: ['E1'] },
    { id: 'F2', statement: 'Paid traffic lands on an 11-field form with no booking option.', evidence_ids: ['E2'] },
    { id: 'F3', statement: 'Monthly ad spend is roughly €3,000.', evidence_ids: ['E3'] },
    { id: 'F4', statement: 'Completing the form on mobile took 4 minutes.', evidence_ids: ['E4'] },
  ],
  inferences: [
    { id: 'I1', statement: 'Annual ad spend is roughly €36,000.', basis_ids: ['F3'], reasoning: '€3,000 per month × 12 months = €36,000 per year.' },
    { id: 'I2', statement: 'A meaningful share of paid clicks is likely lost at the form step.', basis_ids: ['F2', 'F4'], reasoning: 'Long forms without booking create friction on mobile.' },
  ],
  hypotheses: [
    { id: 'H1', statement: 'Most ad traffic is mobile.', basis_ids: ['I2'], would_confirm: 'Analytics device split', would_refute: 'Desktop-majority traffic' },
  ],
  unknowns: [
    { id: 'U1', question: 'What is the current form conversion rate?', materiality: 'USEFUL', why_it_matters: 'Sizes the opportunity', resolvable_by: 'PROSPECT' },
  ],
  diagnoses: [
    { id: 'D1', statement: 'Paid acquisition spend is undermined by a high-friction conversion step.', supporting_ids: ['F2', 'F4', 'I2'], assumption_ids: [], alternative_explanation: 'Leads may be converted by phone instead of the form.', strength: 'ESTABLISHED' },
  ],
  candidates: [
    {
      id: 'C1', title: 'Booking-first landing journey', diagnosis_ids: ['D1'],
      intervention: 'Replace the 11-field form with a short booking flow per location.',
      reason_why: {
        signal: 'Ads send traffic to a slow form.', business_consequence: 'Paid clicks are wasted.',
        intervention: 'Booking-first journey.', potential_value: 'Protects roughly €36,000 per year of ad spend.',
        value_basis_ids: ['I1'], value_is_quantified: true,
      },
      routing: [{ engine: 'GROWTH', rationale: 'Commercial conversion work for an external client.' }, { engine: 'FACTORY', rationale: 'Build the booking flow.' }],
      evidence_sufficiency: { level: 'SUFFICIENT', rationale: 'Direct observation of the journey.' },
      critical_unknown_ids: [], risks: ['Clinic scheduling system may not expose availability.'], dependencies: ['Access to scheduling system'],
      recommended_disposition: 'PROCEED', disposition_rationale: 'Clear, evidenced friction with direct spend exposure.',
    },
    {
      id: 'C2', title: 'Reusable dental booking widget', diagnosis_ids: ['D1'],
      intervention: 'Generalise the booking flow into a product for clinics.',
      reason_why: {
        signal: 'Same friction likely common in clinics.', business_consequence: 'Repeatable demand.',
        intervention: 'Productised widget.', potential_value: 'Possible recurring product revenue.',
        value_basis_ids: [], value_is_quantified: false,
      },
      routing: [{ engine: 'PRODUCT', rationale: 'Reusable asset.' }],
      evidence_sufficiency: { level: 'PARTIAL', rationale: 'One observed case only.' },
      critical_unknown_ids: [], risks: [], dependencies: [],
      recommended_disposition: 'LEARN_ONLY', disposition_rationale: 'Record the pattern; one case is not enough.',
    },
  ],
  overall_recommendation: { disposition: 'PROCEED', proceed_candidate_ids: ['C1'], rationale: 'Proceed with C1; keep C2 as learning.' },
  info_request: null,
});

export const outputB = () => {
  const o = outputA();
  o.unknowns.push({ id: 'U2', question: 'Who decides on marketing budget?', materiality: 'DECISION_CRITICAL', why_it_matters: 'No buyer, no engagement', resolvable_by: 'MANUEL' });
  o.candidates[0].critical_unknown_ids = ['U2'];
  o.candidates[0].recommended_disposition = 'NEEDS_MORE_INFO';
  o.overall_recommendation = { disposition: 'NEEDS_MORE_INFO', proceed_candidate_ids: [], rationale: 'Decision maker unknown.' };
  o.info_request = { questions: [{ unknown_id: 'U2', question: 'Who owns the ad budget?', why: 'Determines whether to approach', unblocks_ids: ['C1'], resolvable_by: 'MANUEL', expected_effect: 'Could move C1 to PROCEED' }] };
  return o;
};

export const bundleC = {
  bundle_version: 'radar_input/0.1',
  signal: { case_id: '00000000-0000-4000-8000-00000000000c', text: 'Idea: automate our own weekly proposal drafting.', source_type: 'INTERNAL_IDEA', entered_by: 'user:m', received_at: '2026-10-01T09:00:00Z', signal_sha256: 'y' },
  organization: null, prospect: null, context: [], related_cases: [], previous_assessment: null, latest_info_request: null,
};
export const outputC = () => ({
  contract_version: 'radar_core/0.1',
  signal_understanding: { observed: 'Internal idea to automate proposal drafting.', subject: { kind: 'INTERNAL', name: null, organization_id: null }, trigger: 'Internal efficiency' },
  evidence: [{ id: 'E1', content: 'Idea to automate weekly proposal drafting.', source_type: 'INTERNAL_IDEA', source_ref: null, provided_by: 'SIGNAL', observed_at: null }],
  facts: [{ id: 'F1', statement: 'Proposal drafting is done weekly.', evidence_ids: ['E1'] }],
  inferences: [], hypotheses: [], unknowns: [],
  diagnoses: [{ id: 'D1', statement: 'Recurring manual drafting effort.', supporting_ids: ['F1'], assumption_ids: [], alternative_explanation: null, strength: 'ESTABLISHED' }],
  candidates: [{
    id: 'C1', title: 'Internal drafting tool', diagnosis_ids: ['D1'], intervention: 'Build an internal drafting helper.',
    reason_why: { signal: 's', business_consequence: 'Time spent', intervention: 'Tool', potential_value: 'Time saved each week.', value_basis_ids: [], value_is_quantified: false },
    routing: [{ engine: 'FACTORY', rationale: 'Internal build.' }],
    evidence_sufficiency: { level: 'SUFFICIENT', rationale: 'Internal knowledge' }, critical_unknown_ids: [], risks: [], dependencies: [],
    recommended_disposition: 'PROCEED', disposition_rationale: 'Low risk internal improvement.',
  }],
  overall_recommendation: { disposition: 'PROCEED', proceed_candidate_ids: ['C1'], rationale: 'Build it internally.' },
  info_request: null,
});

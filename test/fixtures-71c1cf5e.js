// Structural replay of production run 71c1cf5e-a296-4a29-b772-f529e308f94f (case 54aba112, template 0.1.1).
// IDs, references, dispositions, routing and the undeclared `content_note: null` at $.evidence[0] are verbatim;
// the prospect name is anonymised (public repo) and long narrative fields are abbreviated. Input bundle = the bundle
// that run received (incl. the two related cases supplied before the governed-memory migration).
export const bundle71 = {
 "bundle_version": "radar_input/0.1",
 "signal": {
  "case_id": "54aba112-9a28-4250-ab67-984a396c8534",
  "text": "Web de Despacho Ejemplo abandonada y con oportunidad clara de rediseño",
  "source_type": "MANUEL_OBSERVATION",
  "entered_by": "user:8b933271-429e-429a-a407-8b03a01e6111",
  "received_at": "2026-09-30T12:38:17.973436+00:00",
  "signal_sha256": "x"
 },
 "organization": null,
 "prospect": {
  "name": "Despacho Ejemplo",
  "website": "despacho-ejemplo.example"
 },
 "context": [
  {
   "event_id": "8c33d804-b731-4a1b-a7c7-b05498d32098",
   "added_at": "2026-09-30T12:38:17.973436+00:00",
   "origin": "SUBMISSION",
   "content": "La web actual es muy básica, con textos genéricos, poca información sobre el despacho y sus profesionales, contacto poco trabajado y ausencia de elementos actuales de confianza, conversión y diferenciación. Puede existir una oportunidad de modernización completa de la web y mejora de captación de clientes.",
   "answers": null,
   "info_request_event_id": null
  }
 ],
 "related_cases": [
  {
   "case_id": "2758b13f-3100-4c12-99ce-692122dc81c1",
   "case_name": "Despacho Ejemplo · 2026-09-30 12:29 UTC",
   "signal": "Web de Despacho Ejemplo abandonada y con oportunidad clara de rediseño",
   "status": "CORE_FAILED",
   "created_at": "2026-09-30T12:29:57.077611",
   "decisions": []
  },
  {
   "case_id": "23d7f9be-9400-4649-be47-440976464a58",
   "case_name": "Despacho Ejemplo · 2026-09-30 12:10 UTC",
   "signal": "Web de Despacho Ejemplo abandonada y con oportunidad clara de rediseño",
   "status": "CORE_FAILED",
   "created_at": "2026-09-30T12:10:22.862764",
   "decisions": []
  }
 ],
 "previous_assessment": null,
 "latest_info_request": null
};
export const output71 = () => JSON.parse(JSON.stringify({
 "facts": [
  {
   "id": "F1",
   "statement": "La web de Despacho Ejemplo tiene textos genéricos, poca información sobre el despacho y sus profesionales, un apartado de contacto poco trabajado y carece de elementos actuales de confianza, conversión y diferenciación.",
   "evidence_ids": [
    "E2"
   ]
  },
  {
   "id": "F2",
   "statement": "Se identifica una posible oportunidad de modernización completa de la web y mejora de la captación de clientes para el despacho.",
   "evidence_ids": [
    "E2"
   ]
  },
  {
   "id": "F3",
   "statement": "Este mismo prospecto y la misma señal ya generaron dos casos previos en Agency OS, ambos con estado CORE_FAILED y sin decisiones registradas.",
   "evidence_ids": [
    "E3",
    "E4"
   ]
  }
 ],
 "evidence": [
  {
   "id": "E1",
   "content": "Web de Despacho Ejemplo abandonada y con oportunidad clara de rediseño",
   "source_ref": null,
   "observed_at": "2026-09-30T12:38:17.973436+00:00",
   "provided_by": "SIGNAL",
   "source_type": "MANUEL_OBSERVATION",
   "content_note": null
  },
  {
   "id": "E2",
   "content": "La web actual es muy básica, con textos genéricos, poca información sobre el despacho y sus profesionales, contacto poco trabajado y ausencia de elementos actuales de confianza, conversión y diferenciación. Puede existir una oportunidad de modernización completa de la web y mejora de captación de clientes.",
   "source_ref": null,
   "observed_at": "2026-09-30T12:38:17.973436+00:00",
   "provided_by": "CONTEXT",
   "source_type": "CONTEXT_NOTE"
  },
  {
   "id": "E3",
   "content": "Caso previo con el mismo prospecto y la misma señal ('Web de Despacho Ejemplo abandonada y con oportunidad clara de rediseño'), sin decisiones registradas, con estado de fallo en la fase de análisis del caso.",
   "source_ref": "2758b13f-3100-4c12-99ce-692122dc81c1",
   "observed_at": "2026-09-30T12:29:57.077611",
   "provided_by": "AGENCY_OS_RECORD",
   "source_type": "AGENCY_OS_RECORD"
  },
  {
   "id": "E4",
   "content": "Otro caso previo con el mismo prospecto y la misma señal ('Web de Despacho Ejemplo abandonada y con oportunidad clara de rediseño'), sin decisiones registradas, con estado de fallo en la fase de análisis del caso.",
   "source_ref": "23d7f9be-9400-4649-be47-440976464a58",
   "observed_at": "2026-09-30T12:10:22.862764",
   "provided_by": "AGENCY_OS_RECORD",
   "source_type": "AGENCY_OS_RECORD"
  }
 ],
 "unknowns": [
  {
   "id": "U1",
   "question": "q",
   "materiality": "DECISION_CRITICAL",
   "resolvable_by": "MANUEL",
   "why_it_matters": "w"
  },
  {
   "id": "U2",
   "question": "q",
   "materiality": "USEFUL",
   "resolvable_by": "PROSPECT",
   "why_it_matters": "w"
  },
  {
   "id": "U3",
   "question": "q",
   "materiality": "USEFUL",
   "resolvable_by": "PROSPECT",
   "why_it_matters": "w"
  }
 ],
 "diagnoses": [
  {
   "id": "D1",
   "strength": "TENTATIVE",
   "statement": "s",
   "assumption_ids": [],
   "supporting_ids": [
    "F1"
   ],
   "alternative_explanation": "a"
  },
  {
   "id": "D2",
   "strength": "TENTATIVE",
   "statement": "s",
   "assumption_ids": [
    "H1"
   ],
   "supporting_ids": [
    "F2",
    "I1"
   ],
   "alternative_explanation": "a"
  }
 ],
 "candidates": [
  {
   "id": "C1",
   "risks": [
    "r"
   ],
   "title": "t",
   "routing": [
    {
     "engine": "GROWTH",
     "rationale": "r"
    },
    {
     "engine": "PRODUCT",
     "rationale": "r"
    }
   ],
   "reason_why": {
    "signal": "s",
    "intervention": "i",
    "potential_value": "Mejora cualitativa de la capacidad de captación de clientes online del despacho, sin cifra concreta disponible en el input.",
    "value_basis_ids": [
     "E1",
     "F1"
    ],
    "value_is_quantified": false,
    "business_consequence": "b"
   },
   "dependencies": [
    "d"
   ],
   "intervention": "i",
   "diagnosis_ids": [
    "D1",
    "D2"
   ],
   "critical_unknown_ids": [
    "U1"
   ],
   "evidence_sufficiency": {
    "level": "PARTIAL",
    "rationale": "r"
   },
   "disposition_rationale": "d",
   "recommended_disposition": "NEEDS_MORE_INFO"
  }
 ],
 "hypotheses": [
  {
   "id": "H1",
   "basis_ids": [
    "F1",
    "F2"
   ],
   "statement": "s",
   "would_refute": "r",
   "would_confirm": "c"
  },
  {
   "id": "H2",
   "basis_ids": [
    "F3"
   ],
   "statement": "s",
   "would_refute": "r",
   "would_confirm": "c"
  }
 ],
 "inferences": [
  {
   "id": "I1",
   "basis_ids": [
    "F1"
   ],
   "reasoning": "r",
   "statement": "s"
  }
 ],
 "info_request": {
  "questions": [
   {
    "why": "w",
    "question": "q",
    "unknown_id": "U1",
    "unblocks_ids": [
     "D2",
     "H2"
    ],
    "resolvable_by": "MANUEL",
    "expected_effect": "e"
   }
  ]
 },
 "contract_version": "radar_core/0.1",
 "signal_understanding": {
  "subject": {
   "kind": "COMPANY",
   "name": "Despacho Ejemplo",
   "organization_id": null
  },
  "trigger": "t",
  "observed": "o"
 },
 "overall_recommendation": {
  "rationale": "r",
  "disposition": "NEEDS_MORE_INFO",
  "proceed_candidate_ids": []
 }
}));

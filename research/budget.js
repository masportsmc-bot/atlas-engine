// Hard research budget meter (Gate 4 cost-containment). Every model call is pre-flighted against the remaining
// input/output/cost budget and recorded afterwards; any breach fails the run closed as BUDGET_EXCEEDED.
import { ResearchError } from './errors.js';
import { MAX_CAPTURES } from './contract.js';

export function budgetConsistencyErrors(b) {
  const e = [];
  if (b.max_fetches * b.max_captures_per_page > MAX_CAPTURES) e.push(`max_fetches x max_captures_per_page exceeds ${MAX_CAPTURES}`);
  if (b.max_estimated_cost_usd != null && !b.pricing) e.push('max_estimated_cost_usd requires pricing');
  return e;
}
export const estimateTokens = (obj) => Math.ceil(JSON.stringify(obj).length / 3); // conservative (3 chars/token)

export class BudgetMeter {
  constructor(budget) { this.b = budget; this.calls = []; this.input = 0; this.output = 0; this.searches = 0; this.fetches = 0; }
  estimatedCost(input = this.input, output = this.output, searches = this.searches) {
    const p = this.b.pricing; if (!p) return null;
    return Math.round(((input / 1e6) * p.input_usd_per_mtok + (output / 1e6) * p.output_usd_per_mtok + searches * p.usd_per_search) * 1e4) / 1e4;
  }
  #check(input, output, searches, label, when) {
    const over = [];
    if (input > this.b.max_input_tokens) over.push(`input ${input} > ${this.b.max_input_tokens}`);
    if (output > this.b.max_output_tokens) over.push(`output ${output} > ${this.b.max_output_tokens}`);
    const c = this.estimatedCost(input, output, searches);
    if (this.b.max_estimated_cost_usd != null && c > this.b.max_estimated_cost_usd) over.push(`estimated cost ${c} > ${this.b.max_estimated_cost_usd}`);
    if (over.length) throw new ResearchError('BUDGET_EXCEEDED', `${when} ${label}: ${over.join('; ')}`, { budget_diagnostics: this.diagnostics() });
  }
  // Pre-flight: projected input for this call (prompt x iterations + search payload allowance) and its full max_tokens.
  preflight(label, { promptTokens, iterations = 1, searchAllowance = 0, maxTokens, searches = 0 }) {
    const projectedIn = promptTokens * iterations + searchAllowance;
    this.#check(this.input + projectedIn, this.output + maxTokens, this.searches + searches, label, 'preflight');
    return projectedIn;
  }
  record(label, kind, res, extra = {}) {
    const u = res?.usage || {}; const inp = u.input_tokens || 0; const out = u.output_tokens || 0; const s = u.server_tool_use?.web_search_requests || 0;
    this.input += inp; this.output += out; this.searches += s;
    this.calls.push({ label, kind, response_id: res?.id ?? null, stop_reason: res?.stop_reason ?? null, input_tokens: inp, output_tokens: out,
      web_search_requests: s, cumulative_input_tokens: this.input, cumulative_output_tokens: this.output,
      estimated_cost_usd_cumulative: this.estimatedCost(), ...extra });
    this.#check(this.input, this.output, this.searches, label, 'after');
  }
  noteFetch() { this.fetches += 1; }
  diagnostics() {
    return { limits: { max_input_tokens: this.b.max_input_tokens, max_output_tokens: this.b.max_output_tokens, max_estimated_cost_usd: this.b.max_estimated_cost_usd ?? null },
      totals: { input_tokens: this.input, output_tokens: this.output, web_search_requests: this.searches, engine_fetches: this.fetches,
        estimated_cost_usd: this.estimatedCost(), actual_cost_usd: null, actual_cost_note: 'The API does not report cost; estimate requires budget.pricing.' },
      calls: this.calls };
  }
}

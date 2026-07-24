/**
 * _schemas.js — JSON Schemas for agent-to-JS structured output contracts.
 *
 * Rationale (from dogfood 1 retro): every bug surfaced during the first
 * dogfood was at a prompt/parser boundary that relied on prose matching.
 * This module centralizes the contracts so that each agent session's
 * output is a schema-validated object instead of regex-parsed markdown.
 *
 * The Agent SDK delivers these as `result.structured_output` when the
 * session is spawned with `jsonSchema`. JS writes a sidecar `.json` file
 * as the source of truth; human-readable rendering is derived from JSON.
 *
 * Deprecation plan: markdown fallback parsers live in each agent file
 * for one release to catch SDK drift. Once dogfood 2 confirms the
 * happy path holds, the fallback branches can be deleted.
 *
 * Exports:
 *   verifierSchema, verifierContextSchema, analyzerSchema, executorSchema, summarizerSchema,
 *   reviewerSchema, assumptionRemediationSchema, reviewRemediationSchema,
 *   regressionRemediationSchema, taskReplanSchema, brainstormSpecSchema,
 *   userSpecSchema, proposeQuestionsSchema, followupQuestionsSchema
 *   extractStructured(sdkResult) → object | null
 */

// ── Verifier ─────────────────────────────────────────────────────────────
//
// Returned by the verifier session for each task. Replaces the prose
// `**Result:** PASSED|FAILED` convention that audit.js and verifier.js
// used to regex-match.
export const verifierSchema = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['PASSED', 'FAILED'] },
    hardChecks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:     { type: 'string' },
          status:   { type: 'string', enum: ['PASS', 'FAIL'] },
          evidence: { type: 'string' },
        },
        required: ['name', 'status', 'evidence'],
      },
    },
    taskScopeChecks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          status:      { type: 'string', enum: ['PASS', 'FAIL'] },
          evidence:    { type: 'string' },
        },
        required: ['description', 'status', 'evidence'],
      },
    },
    standardsChecks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          status:      { type: 'string', enum: ['PASS', 'FAIL'] },
          evidence:    { type: 'string' },
        },
        required: ['description', 'status', 'evidence'],
      },
    },
    notes: { type: 'string' },
    // REQUIRED post-A4: back-reference check records whether the verifier
    // consulted the spec/plan and lists any deviations found. Spec consultation
    // is a first-class audited signal — honest non-consultation is expressed as
    // an explicit `spec_consulted: false`; omitting the field is non-conformant.
    // The no-structured-output stub (extractVerdict) is constructed locally
    // without validation and intentionally omits it.
    back_reference_check: {
      type: 'object',
      properties: {
        spec_consulted: { type: 'boolean' },
        plan_consulted: { type: 'boolean' },
        deviations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind:        { type: 'string', enum: ['spec_mismatch', 'plan_contradiction', 'missing_constraint', 'undefined_composition'] },
              description: { type: 'string' },
              evidence:    { type: 'string' },
            },
            required: ['kind', 'description', 'evidence'],
          },
        },
      },
      required: ['spec_consulted', 'plan_consulted', 'deviations'],
    },
  },
  required: ['result', 'hardChecks', 'taskScopeChecks', 'back_reference_check'],
};

// ── Regression Verifier ──────────────────────────────────────────────────
//
// Used in place of verifierSchema for regression-* gate tasks. Identical to
// verifierSchema plus an optional `findings` array: each failing check the
// verifier can attribute to concrete file(s) becomes a structured
// {file, description} entry the pipeline hands to remediation without
// parsing report prose. `file` is the literal 'unknown' when no file is
// attributable. Mirrors reviewerSchema's findings pattern; optional so the
// shared extractVerdict validation (keyed on verifierSchema.required)
// stays unchanged.
export const regressionVerifierSchema = {
  ...verifierSchema,
  properties: {
    ...verifierSchema.properties,
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file:         { type: 'string' },
          description:  { type: 'string' },
          evidence:     { type: 'string' },
          relatedFiles: { type: 'array', items: { type: 'string' } },
        },
        required: ['file', 'description'],
      },
    },
  },
};

// ── Verifier Context ─────────────────────────────────────────────────────
//
// Passed to the verifier session as input context, describing which spec
// file to consult and the purpose of the verification run.
export const verifierContextSchema = {
  type: 'object',
  properties: {
    specPath: { type: 'string', minLength: 1 },
    purpose:  { type: 'string' },
  },
  required: ['specPath'],
};

// ── Analyzer ─────────────────────────────────────────────────────────────
//
// Returned by the analyzer session on gate failure. Replaces the
// arrow-regex + 中文 section fallback that were literally bug 5's root.
//
// `re_plan` uses underscore form (cleaner in enums). Migrated from the
// previous hyphen form `re-plan`.
export const analyzerSchema = {
  type: 'object',
  properties: {
    recommendation: { type: 'string', enum: ['retry', 're_plan', 'human'] },
    rootCause:      { type: 'string' },
    failureType:    { type: 'string', enum: ['execution', 'verification', 'regression', 'review'] },
    affectedTasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          reason: { type: 'string' },
          action: { type: 'string', enum: ['needs_revalidation', 'safe_to_keep'] },
        },
        required: ['taskId', 'reason', 'action'],
      },
    },
    evidence: { type: 'string' },
    notes:    { type: 'string' },
  },
  required: ['recommendation', 'rootCause', 'failureType', 'affectedTasks'],
};

// ── Executor ─────────────────────────────────────────────────────────────
//
// Returned by the executor session after attempting a task. Replaces the
// `## Status\nCOMPLETED` + `## 修改的文件` markdown regexes that
// readAffectedFiles and executor.js used to parse.
export const executorSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['COMPLETED', 'BLOCKED'] },
    summary: { type: 'string' },
    affectedFiles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path:   { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'reason'],
      },
    },
    testsSummary: { type: 'string' },
    blockReason:  { type: 'string' }, // required iff status === 'BLOCKED', enforced in JS
  },
  required: ['status', 'summary', 'affectedFiles'],
};

// ── Summarizer ───────────────────────────────────────────────────────────
//
// Returned by the summarizer agent at the end of a pipeline run.
// Provides a human-readable headline, a list of bugs encountered, and
// a prose summary of what happened.
export const summarizerSchema = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    bugs: {
      type: 'array',
      items: { type: 'string' },
    },
    summary: { type: 'string' },
    changelog: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type:        { type: 'string', enum: ['feature', 'fix', 'breaking'] },
          description: { type: 'string' },
          source:      { type: 'string', enum: ['mission-desc', 'task-desc', 'spec', 'diff-file', 'manifest-bugs'] },
          file:        { type: 'string' },
          taskIds:     { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
        },
        required: ['type', 'description', 'taskIds'],
      },
    },
  },
  required: ['headline', 'bugs', 'summary', 'changelog'],
};

// ── Reviewer ─────────────────────────────────────────────────────────────
//
// Returned by the milestone-level reviewer for cross-file composition,
// integration, and end-to-end functional review of the implemented changes.
// result is FAILED if any finding has severity critical.
export const reviewerSchema = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['PASSED', 'FAILED'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity:     { type: 'string', enum: ['critical', 'warning', 'info'] },
          category:     {
            type: 'string',
            enum: [
              'call-chain', 'integration', 'functional',
              'plan-coherence', 'position-precision', 'behavioral-race',
              'scope-expansion', 'contract-mismatch',
            ],
          },
          file:         { type: 'string' },
          description:  { type: 'string' },
          relatedFiles: { type: 'array', items: { type: 'string' } },
          tier:         { type: 'string', enum: ['composition', 'behavioral', 'cosmetic'] },
          disposition:  { type: 'string', enum: ['pending', 'accepted-with-followup', 'fixed', 'dismissed'] },
          dispositionReason: { type: 'string' },
        },
        required: ['severity', 'category', 'file', 'description'],
      },
    },
    notes: { type: 'string' },
    scopeCompliance: {
      type: 'object',
      properties: {
        verdict:      { type: 'string', enum: ['within_scope', 'exceeded_scope', 'insufficient_scope'] },
        evidence:     { type: 'string' },
        exceededFiles: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict'],
    },
    // Optional (fail-soft): descriptions of acceptance criteria the reviewer
    // judges NOT covered by the milestone. Absent/empty when all covered or no
    // criteria. NOT in `required` — keeps the no-criteria path + existing
    // fixtures valid.
    uncoveredCriteria: { type: 'array', items: { type: 'string' } },
  },
  required: ['result', 'findings'],
};

// ── Assumption Remediation ────────────────────────────────────────────────
//
// Returned by the assumption-remediation agent when a planner assumption
// is found to be invalid. `revisedAssumptions` is an array of corrected
// assumption objects after incorporating the fix; each carries an explicit
// `phase` ('invariant' for current-code claims, 'post-fix' for requirements
// that hold only after the fix lands). `specEdit` describes the minimal
// change that should be applied to the spec document so the assumption does
// not resurface in future runs.
export const assumptionRemediationSchema = {
  type: 'object',
  properties: {
    revisedAssumptions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          phase: { type: 'string', enum: ['invariant', 'post-fix'] },
          specSection: { type: 'string' },
        },
        required: ['text', 'phase'],
      },
      minItems: 1,
    },
    specEdit: {
      type: 'object',
      properties: {
        section: { type: 'string' },
        old:     { type: 'string' },
        new:     { type: 'string' },
      },
      required: ['section', 'old', 'new'],
    },
  },
  required: ['revisedAssumptions', 'specEdit'],
};

// ── Review Remediation ───────────────────────────────────────────────────
//
// Returned by the review-remediation agent when a milestone reviewer flags
// critical findings that require new tasks to be created. `newTasks` lists
// the remediation tasks (id, description, targetFiles only — no
// tracesScenario, outOfScope, or other planner-only fields).
export const reviewRemediationSchema = {
  type: 'object',
  properties: {
    newTasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:          { type: 'string', pattern: '^\\d{3}(-\\d{3}){3}$' },
          subMissionId: { type: 'string', pattern: '^\\d{3}(-\\d{3}){2}$' },
          description: { type: 'string' },
          targetFiles: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'subMissionId', 'description', 'targetFiles'],
      },
    },
  },
  required: ['newTasks'],
};

// ── Regression Remediation ───────────────────────────────────────────────
//
// Returned by the regression-remediation agent when a regression failure
// requires new tasks to be created. `newTasks` lists the remediation tasks
// (id, subMissionId, description, targetFiles — same shape as
// reviewRemediationSchema).
export const regressionRemediationSchema = {
  type: 'object',
  properties: {
    newTasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:          { type: 'string', pattern: '^\\d{3}(-\\d{3}){3}$' },
          subMissionId: { type: 'string', pattern: '^\\d{3}(-\\d{3}){2}$' },
          description: { type: 'string' },
          targetFiles: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'subMissionId', 'description', 'targetFiles'],
      },
    },
  },
  required: ['newTasks'],
};

// ── Task Replan ──────────────────────────────────────────────────────────
//
// Returned by the re-plan agent when a failed task requires replacement
// tasks to be substituted into the pipeline. Each replacement task carries
// an explicit dependencies array so the scheduler can wire up edges without
// re-running the planner. Each dependency item names the upstream taskId
// and whether it is a hard (blocking) or soft (advisory) dependency.
export const taskReplanSchema = {
  type: 'object',
  properties: {
    replacementTasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          // -rp-N suffix shape backs the replan cap's canonical keying; the prefix invariant is enforced at the replaceTask boundary.
          id:          { type: 'string', pattern: '-rp-\\d+$' },
          description: { type: 'string' },
          targetFiles: { type: 'array', items: { type: 'string' }, minItems: 1 },
          dependencies: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                taskId: { type: 'string' },
                type:   { type: 'string', enum: ['hard', 'soft'] },
              },
              required: ['taskId', 'type'],
            },
          },
        },
        required: ['id', 'description', 'targetFiles', 'dependencies'],
      },
    },
  },
  required: ['replacementTasks'],
};

// ── Brainstorm Spec ──────────────────────────────────────────────────────
//
// Returned by the brainstormer agent. Describes the goal, target files,
// acceptance criteria, and optional constraints / architecture notes for
// a planned sub-mission or task group.
export const brainstormSpecSchema = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    target_files: {
      type: 'array',
      items: { type: 'string' },
    },
    acceptance_criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          // FLAT part of the enforcement split: verification is required, kind
          // is an enum, and the sub-fields are flat optional. Per-kind
          // conditional requiredness (kind=command ⇒ command+targetFile, etc.)
          // and targetFile ∈ target_files are NOT expressible here —
          // validateStructured has no oneOf/anyOf/conditional — so they are
          // hand-coded imperatively in extractBrainstormResult.
          verification: {
            type: 'object',
            properties: {
              kind:        { type: 'string', enum: ['command', 'file-check', 'manual'] },
              command:     { type: 'string' },
              targetFile:  { type: 'string' },
              manualSteps: { type: 'string' },
            },
            required: ['kind'],
          },
        },
        required: ['description', 'verification'],
      },
    },
    constraints: {
      type: 'array',
      items: { type: 'string' },
    },
    architecture_notes: { type: 'string' },
    warning: { type: 'string' },
  },
  required: ['goal', 'target_files', 'acceptance_criteria'],
};

// ── User Spec ────────────────────────────────────────────────────────────
//
// Returned by the user-facing spec-drafting agent. Flat validateStructured-
// compatible shape mirroring brainstormSpecSchema's convention: all
// conditional/cross-field rules (e.g. per-kind requiredness) are kept OUT
// of the schema and hand-coded imperatively in JS, since validateStructured
// has no oneOf/anyOf/conditional support.
export const userSpecSchema = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    scope_in: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          label:    { type: 'string' },
          files:    { type: 'array', items: { type: 'string' } },
          behavior: { type: 'string' },
        },
        required: ['label'],
      },
    },
    scope_out: {
      type: 'array',
      items: { type: 'string' },
    },
    success_criteria: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          evidence:    { type: 'string' },
        },
        required: ['description'],
      },
    },
    constraints: {
      type: 'array',
      items: { type: 'string' },
    },
    assumptions: {
      type: 'array',
      items: { type: 'string' },
    },
    architecture_notes: { type: 'string' },
  },
  required: ['goal', 'scope_in', 'success_criteria'],
};

// ── Propose Questions ─────────────────────────────────────────────────────
//
// Returned by the brainstormer agent on the pre-draft frame-first elicitation
// path. Describes the agent's own-words restatement of intent (paraphrase +
// repo evidence + enumerated unknowns), a ranked list of clarifying questions
// each carrying the premise that motivates it and a category, plus the agent's
// self-assessed complexity. NOT a spec — nothing here is persisted as spec.json
// or fed to the planner; it drives the interactive question phase only.
//
// `importance` orders the questions (sorted DESCENDING in JS before the
// style.maxQuestions truncation). `category` ∈ {ambiguity, boundary, non-goal,
// failure-scenario, inconsistency-challenge}. `assessedComplexity` lets the
// agent signal a trivial request (for which it self-scales to few/zero
// questions); the hard ceiling is applied separately in JS.
export const proposeQuestionsSchema = {
  type: 'object',
  properties: {
    restatement: {
      type: 'object',
      properties: {
        paraphrase: { type: 'string' },
        evidence:   { type: 'array', items: { type: 'string' } },
        unknowns:   { type: 'array', items: { type: 'string' } },
      },
      required: ['paraphrase', 'evidence', 'unknowns'],
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:         { type: 'string' },
          question:   { type: 'string' },
          premise:    { type: 'string' },
          category:   {
            type: 'string',
            enum: ['ambiguity', 'boundary', 'non-goal', 'failure-scenario', 'inconsistency-challenge'],
          },
          importance: { type: 'number' },
        },
        required: ['id', 'question', 'premise', 'category', 'importance'],
      },
    },
    assessedComplexity: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
  },
  required: ['restatement', 'questions', 'assessedComplexity'],
};

// ── Follow-up Questions ────────────────────────────────────────────────────
//
// Returned by the brainstormer agent on the multi-round follow-up elicitation
// path (the round-AFTER-round-1 loop). Given the original input, the round-1
// restatement, and all Q&A collected so far, the agent judges whether the
// prior answers opened NEW decision-critical questions. Strictly additive —
// proposeQuestionsSchema is untouched.
//
// `done` is the agent's explicit termination verdict (the LOOP compares it with
// `done === true`, never a truthy check — validateStructured has no boolean
// branch, so a non-boolean `done` such as the string "false" is NOT type-
// rejected here). `integrationNote` is a one-line render-only restatement of the
// agent's updated understanding given the prior answers (never persisted, never
// fed downstream). `questions` reuses the round-1 question object shape; it is
// ranked DESCENDING by importance and truncated to style.maxQuestions in JS.
export const followupQuestionsSchema = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    integrationNote: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:         { type: 'string' },
          question:   { type: 'string' },
          premise:    { type: 'string' },
          category:   {
            type: 'string',
            enum: ['ambiguity', 'boundary', 'non-goal', 'failure-scenario', 'inconsistency-challenge'],
          },
          importance: { type: 'number' },
        },
        required: ['id', 'question', 'premise', 'category', 'importance'],
      },
    },
  },
  required: ['done', 'integrationNote', 'questions'],
};

/**
 * Extract a structured_output object from an SDK result.
 *
 * Returns the parsed object on success, or `null` when the SDK did not
 * produce structured output. Callers MUST handle null by returning a
 * conservative default (FAILED / BLOCKED / human / empty summary).
 *
 * Precedence / invariant order:
 *   1. sdkResult == null (null or undefined) → return null, no warn.
 *   2. sdkResult.structured_output is defined (not undefined):
 *      a. non-null object (including {}, arrays) → return it, no warn.
 *      b. null → return null + warn('SDK returned null structured_output').
 *      c. any other non-object (number/string/boolean) → return null +
 *         warn('SDK returned malformed structured_output: <typeof>').
 *   3. structured_output is strictly absent (undefined):
 *      if _capturedStructuredOutput is a non-null object → return it +
 *        warn('structured_output absent, using StructuredOutput tool_use fallback path');
 *      else → return null, no warn.
 *
 * opts.warn() is only called when it is a function; callers that omit opts
 * are safe — the default {} means no warn function exists and the guard
 * prevents a crash.
 *
 * @param {object|null|undefined} sdkResult - The raw SDK result object.
 * @param {{ warn?: (msg: string) => void }} [opts] - Optional options.
 * @returns {object|null}
 */
export function extractStructured(sdkResult, opts = {}) {
  // Step 1: null/undefined sdkResult → return null, no warn
  if (sdkResult == null) return null;

  // Step 2: structured_output key is present (not strictly undefined)
  if (sdkResult.structured_output !== undefined) {
    const so = sdkResult.structured_output;
    // (a) non-null object (including {} and arrays) → return verbatim, no warn
    if (so !== null && typeof so === 'object') {
      return so;
    }
    // (b) null → warn + return null
    if (so === null) {
      if (typeof opts.warn === 'function') {
        opts.warn('SDK returned null structured_output');
      }
      return null;
    }
    // (c) any other non-object (number/string/boolean) → warn + return null
    if (typeof opts.warn === 'function') {
      opts.warn(`SDK returned malformed structured_output: ${typeof so}`);
    }
    return null;
  }

  // Step 3: structured_output is strictly undefined — try fallback
  if (sdkResult._capturedStructuredOutput !== null &&
      sdkResult._capturedStructuredOutput !== undefined &&
      typeof sdkResult._capturedStructuredOutput === 'object') {
    if (typeof opts.warn === 'function') {
      opts.warn('structured_output absent, using StructuredOutput tool_use fallback path');
    }
    return sdkResult._capturedStructuredOutput;
  }

  return null;
}

/**
 * Validate a parsed structured_output against a schema.
 *
 * Lightweight validator — checks required keys and enum membership.
 * Not a full JSON Schema validator (that would add a dependency).
 * Returns { ok: true } or { ok: false, errors: [...] }.
 *
 * This exists so the contract tests can assert the schema shape
 * without requiring a running SDK. It is also used at runtime to
 * catch schema drift early (agent returned object but wrong shape).
 */
export function validateStructured(obj, schema) {
  const errors = [];
  if (!obj || typeof obj !== 'object') {
    return { ok: false, errors: ['not an object'] };
  }

  function checkValue(value, schemaNode, path) {
    if (schemaNode.type === 'string') {
      if (typeof value !== 'string') errors.push(`${path}: expected string`);
      else {
        if (schemaNode.enum && !schemaNode.enum.includes(value)) {
          errors.push(`${path}: "${value}" not in enum [${schemaNode.enum.join(', ')}]`);
        }
        if (schemaNode.minLength !== undefined && value.length < schemaNode.minLength) {
          errors.push(`${path}: string length ${value.length} is less than minLength ${schemaNode.minLength}`);
        }
        if (schemaNode.pattern !== undefined && !new RegExp(schemaNode.pattern).test(value)) {
          errors.push(`${path}: "${value}" does not match pattern ${schemaNode.pattern}`);
        }
      }
    } else if (schemaNode.type === 'array') {
      if (!Array.isArray(value)) errors.push(`${path}: expected array`);
      else {
        if (schemaNode.minItems !== undefined && value.length < schemaNode.minItems) {
          errors.push(`${path}: array length ${value.length} is less than minItems ${schemaNode.minItems}`);
        }
        if (schemaNode.items) {
          value.forEach((item, i) => checkValue(item, schemaNode.items, `${path}[${i}]`));
        }
      }
    } else if (schemaNode.type === 'object') {
      if (!value || typeof value !== 'object') errors.push(`${path}: expected object`);
      else {
        for (const req of schemaNode.required || []) {
          if (!(req in value)) errors.push(`${path}.${req}: missing`);
        }
        for (const [key, childSchema] of Object.entries(schemaNode.properties || {})) {
          if (key in value) checkValue(value[key], childSchema, `${path}.${key}`);
        }
      }
    }
  }

  checkValue(obj, schema, '$');
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

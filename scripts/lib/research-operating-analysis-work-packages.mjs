import workPackageRegistry from "../../config/research-operating-analysis-stages.json" with { type: "json" };

export const RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_VERSION = workPackageRegistry.workPackageVersion;
export const RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_ENVELOPE_VERSION = "research-operating-analysis.work-package-envelope.v1";
export const WORK_PACKAGE_TERMINAL_STATUSES = Object.freeze(["complete", "partial", "blocked", "not_applicable", "failed"]);
const terminalStatuses = new Set(WORK_PACKAGE_TERMINAL_STATUSES);
const normalizedEnvelopeMarker = Symbol("normalized-work-package-envelope");

const packageDefinitions = Object.freeze((workPackageRegistry.workPackages || []).map((definition) => Object.freeze({
  key: definition.key,
  label: definition.label,
  execution: definition.execution,
  outputKind: definition.outputKind,
  promptVersion: definition.promptVersion || null,
  stageKeys: Object.freeze([...(definition.stageKeys || [])]),
  reportReadyStageKeys: Object.freeze([...(definition.reportReadyStageKeys || [])]),
  dependsOn: Object.freeze([...(definition.dependsOn || [])]),
  inputPackageKeys: Object.freeze([...(definition.inputPackageKeys || definition.dependsOn || [])]),
  webSearch: definition.webSearch === true,
  finalReport: definition.finalReport === true,
  bypassed: definition.bypassed === true,
  inputProjection: definition.inputProjection,
})));

const packageByKey = new Map(packageDefinitions.map((definition) => [definition.key, definition]));
const packageByStage = new Map(packageDefinitions.flatMap((definition) => definition.stageKeys.map((stageKey) => [stageKey, definition])));
const stageByKey = new Map((workPackageRegistry.stages || []).map((stage) => [stage.key, stage]));

validateWorkPackageRegistry(packageDefinitions);

export const RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES = packageDefinitions;

export function getResearchOperatingAnalysisWorkPackage(key) {
  const definition = packageByKey.get(String(key));
  if (!definition) throw new Error(`unsupported research-analysis work package: ${String(key)}`);
  return definition;
}

export function workPackageForStage(stageKey) {
  return packageByStage.get(String(stageKey)) || null;
}

export function isResearchOperatingAnalysisWorkPackage(key) {
  return packageByKey.has(String(key));
}

export function researchOperatingAnalysisWorkPackageStageKeys(key) {
  return [...getResearchOperatingAnalysisWorkPackage(key).stageKeys];
}

export function researchOperatingAnalysisGenerativeWorkPackages() {
  return RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES.filter((definition) => definition.execution === "model" && !definition.bypassed);
}

export function isFinalReportWorkPackage(key) {
  return getResearchOperatingAnalysisWorkPackage(key).finalReport === true;
}

/** Normalize the single model-visible report contract.  Final-report packages
 * deliberately return human-readable Markdown rather than a stage envelope;
 * stage labels, provenance IDs and machine-readable sections stay in the
 * deterministic persistence layer. */
export function normalizeFinalReportMarkdown(value, packageKey) {
  const definition = getResearchOperatingAnalysisWorkPackage(packageKey);
  if (!definition.finalReport) throw new Error(`${packageKey} is not a final-report work package`);
  const markdown = String(value ?? "").trim();
  if (!markdown) throw new Error(`${packageKey} final report output is empty`);
  return markdown;
}

/** Stable package order. The config dependencies are checked at module load;
 * this topological order is the only order used by package materialization. */
export function researchOperatingAnalysisWorkPackageWaves() {
  const remaining = new Set(packageDefinitions.map((definition) => definition.key));
  const waves = [];
  while (remaining.size) {
    const ready = packageDefinitions.filter((definition) => remaining.has(definition.key) && definition.dependsOn.every((dependency) => !remaining.has(dependency)));
    if (!ready.length) throw new Error("research-analysis work package dependency graph contains a cycle");
    waves.push(ready);
    ready.forEach((definition) => remaining.delete(definition.key));
  }
  return waves;
}

export function normalizeWorkPackageEnvelope(value, packageKey) {
  const definition = getResearchOperatingAnalysisWorkPackage(packageKey);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${packageKey} work-package output must be an object`);
  const envelope = value;
  const unknownEnvelopeFields = Object.keys(envelope).filter((key) => !["schemaVersion", "packageKey", "packageVersion", "status", "stages", "reportReadySection", "packageLineage"].includes(key));
  if (unknownEnvelopeFields.length) throw new Error(`${packageKey} work-package has undeclared fields: ${unknownEnvelopeFields.join(",")}`);
  if (envelope.schemaVersion !== RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_ENVELOPE_VERSION) throw new Error(`${packageKey} work-package schemaVersion is invalid`);
  if (envelope.packageKey !== packageKey) throw new Error(`${packageKey} work-package packageKey is invalid`);
  if (envelope.packageVersion !== RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_VERSION) throw new Error(`${packageKey} work-package packageVersion is invalid`);
  if (!terminalStatuses.has(String(envelope.status))) throw new Error(`${packageKey} work-package status is invalid`);
  const stages = envelope.stages;
  if (!stages || typeof stages !== "object" || Array.isArray(stages)) throw new Error(`${packageKey} work-package stages must be an object`);
  const expected = new Set(definition.stageKeys);
  const actual = Object.keys(stages);
  const missing = definition.stageKeys.filter((key) => !Object.prototype.hasOwnProperty.call(stages, key));
  const unknown = actual.filter((key) => !expected.has(key));
  if (missing.length) throw new Error(`${packageKey} work-package is missing stages: ${missing.join(",")}`);
  if (unknown.length) throw new Error(`${packageKey} work-package has unknown stages: ${unknown.join(",")}`);
  const normalizedStages = {};
  for (const stageKey of definition.stageKeys) normalizedStages[stageKey] = normalizePackageStage(stages[stageKey], stageKey);
  if (envelope.status === "complete" && definition.stageKeys.some((stageKey) => !["complete", "not_applicable"].includes(normalizedStages[stageKey].status))) {
    throw new Error(`${packageKey} work-package complete status requires every stage to be complete or not_applicable`);
  }
  const reportReadySection = envelope.reportReadySection;
  if (definition.reportReadyStageKeys.length) {
    if (!reportReadySection || typeof reportReadySection !== "object" || Array.isArray(reportReadySection)) throw new Error(`${packageKey} work-package reportReadySection is required`);
    const unknownReportFields = Object.keys(reportReadySection).filter((key) => !["markdown", "lineage"].includes(key));
    if (unknownReportFields.length) throw new Error(`${packageKey} work-package reportReadySection has undeclared fields: ${unknownReportFields.join(",")}`);
    if (typeof reportReadySection.markdown !== "string" || !reportReadySection.markdown.trim()) throw new Error(`${packageKey} work-package reportReadySection.markdown is required`);
  } else if (reportReadySection !== undefined) {
    throw new Error(`${packageKey} work-package has an undeclared reportReadySection`);
  }
  return Object.defineProperty({
    schemaVersion: RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_ENVELOPE_VERSION,
    packageKey,
    packageVersion: RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_VERSION,
    status: envelope.status,
    stages: normalizedStages,
    ...(definition.reportReadyStageKeys.length ? { reportReadySection: { markdown: reportReadySection.markdown.trim(), lineage: normalizeLineage(reportReadySection.lineage || {}) } } : {}),
    packageLineage: normalizeLineage(envelope.packageLineage || {}),
  }, normalizedEnvelopeMarker, { value: true });
}

/** Parse a provider JSON response while rejecting duplicate object keys before
 * JSON.parse silently collapses them. Duplicate stage keys are especially
 * dangerous because a response can appear complete after one section has
 * overwritten another. The scanner validates JSON syntax sufficiently to
 * identify duplicate keys, then delegates value semantics to the strict
 * envelope normalizer above.
 */
export function parseWorkPackageEnvelopeJson(value, packageKey) {
  const source = String(value ?? "").trim();
  if (!source) throw new Error(`${packageKey} work-package output is empty`);
  scanJsonForDuplicateKeys(source);
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`${packageKey} work-package output is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeWorkPackageEnvelope(parsed, packageKey);
}

export function projectWorkPackageStages(envelope, packageKey) {
  const normalized = envelope?.[normalizedEnvelopeMarker] ? envelope : normalizeWorkPackageEnvelope(envelope, packageKey);
  const definition = getResearchOperatingAnalysisWorkPackage(packageKey);
  return Object.fromEntries(definition.stageKeys.map((stageKey) => {
    const stage = normalized.stages[stageKey];
    return [stageKey, {
      stageKey,
      status: stage.status,
      output: stage.output,
      lineage: stage.lineage,
      ...(stage.metadata ? { metadata: stage.metadata } : {}),
    }];
  }));
}

function normalizePackageStage(value, stageKey) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${stageKey} package stage must be an object`);
  const status = String(value.status || "");
  if (!terminalStatuses.has(status)) throw new Error(`${stageKey} package stage status is invalid`);
  const hasMarkdown = typeof value.markdown === "string";
  const hasOutput = value.output !== undefined;
  if (hasMarkdown === hasOutput) throw new Error(`${stageKey} package stage must contain exactly one of markdown or output`);
  const stageDefinition = stageByKey.get(stageKey);
  if (!stageDefinition) throw new Error(`${stageKey} package stage is not registered`);
  if (stageDefinition.outputKind === "markdown" && !hasMarkdown) throw new Error(`${stageKey} package stage must provide markdown output`);
  if (stageDefinition.outputKind === "json" && !hasOutput) throw new Error(`${stageKey} package stage must provide object output`);
  if (hasMarkdown && !value.markdown.trim()) throw new Error(`${stageKey} package stage markdown is empty`);
  if (hasOutput && (!value.output || typeof value.output !== "object" || Array.isArray(value.output))) throw new Error(`${stageKey} package stage output must be an object`);
  const unknown = Object.keys(value).filter((key) => !["status", "markdown", "output", "lineage", "metadata"].includes(key));
  if (unknown.length) throw new Error(`${stageKey} package stage has undeclared fields: ${unknown.join(",")}`);
  return {
    status,
    output: hasMarkdown ? value.markdown.trim() : value.output,
    lineage: normalizeLineage(value.lineage || {}),
    ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
  };
}

function normalizeLineage(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const unknown = Object.keys(source).filter((key) => !["upstreamArtifactIds", "sourceIds", "claimIds", "evidenceIds", "unknownIds"].includes(key));
  if (unknown.length) throw new Error(`work-package lineage has undeclared fields: ${unknown.join(",")}`);
  const fields = {};
  for (const key of ["upstreamArtifactIds", "sourceIds", "claimIds", "evidenceIds", "unknownIds"]) {
    const list = source[key] === undefined ? [] : source[key];
    if (!Array.isArray(list) || list.some((id) => typeof id !== "string" || !id.trim() || /\s/.test(id))) throw new Error(`work-package lineage ${key} must contain named IDs`);
    const normalized = list.map((id) => id.trim());
    if (new Set(normalized).size !== normalized.length) throw new Error(`work-package lineage ${key} contains duplicate IDs`);
    fields[key] = normalized.sort();
  }
  return fields;
}

function scanJsonForDuplicateKeys(source) {
  let index = 0;
  const whitespace = () => { while (/\s/.test(source[index] || "")) index += 1; };
  const parseString = () => {
    if (source[index] !== '"') throw new Error(`invalid JSON near offset ${index}`);
    index += 1;
    while (index < source.length) {
      const char = source[index++];
      if (char === "\\") { index += 1; continue; }
      if (char === '"') return;
    }
    throw new Error("unterminated JSON string");
  };
  const parseValue = () => {
    whitespace();
    const char = source[index];
    if (char === "{") return parseObject();
    if (char === "[") return parseArray();
    if (char === '"') return parseString();
    const match = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
    match.lastIndex = index;
    const token = match.exec(source);
    if (!token) throw new Error(`invalid JSON near offset ${index}`);
    index += token[0].length;
  };
  const parseObject = () => {
    index += 1;
    whitespace();
    const keys = new Set();
    if (source[index] === "}") { index += 1; return; }
    while (index < source.length) {
      whitespace();
      const keyStart = index;
      parseString();
      const rawKey = source.slice(keyStart + 1, index - 1);
      let key;
      try { key = JSON.parse(`"${rawKey}"`); } catch { throw new Error(`invalid JSON object key near offset ${keyStart}`); }
      if (keys.has(key)) throw new Error(`duplicate JSON object key: ${key}`);
      keys.add(key);
      whitespace();
      if (source[index] !== ":") throw new Error(`invalid JSON object near offset ${index}`);
      index += 1;
      parseValue();
      whitespace();
      if (source[index] === "}") { index += 1; return; }
      if (source[index] !== ",") throw new Error(`invalid JSON object near offset ${index}`);
      index += 1;
    }
    throw new Error("unterminated JSON object");
  };
  const parseArray = () => {
    index += 1;
    whitespace();
    if (source[index] === "]") { index += 1; return; }
    while (index < source.length) {
      parseValue();
      whitespace();
      if (source[index] === "]") { index += 1; return; }
      if (source[index] !== ",") throw new Error(`invalid JSON array near offset ${index}`);
      index += 1;
    }
    throw new Error("unterminated JSON array");
  };
  parseValue();
  whitespace();
  if (index !== source.length) throw new Error(`trailing JSON content near offset ${index}`);
}

function validateWorkPackageRegistry(definitions) {
  if (!workPackageRegistry.workPackageVersion) throw new Error("research-analysis workPackageVersion is required");
  const stageOwners = new Map();
  for (const definition of definitions) {
    if (!definition.key || !definition.label || !["model", "deterministic"].includes(definition.execution)) throw new Error(`invalid research-analysis work package: ${definition.key}`);
    if (!definition.stageKeys.length) throw new Error(`work package ${definition.key} must own at least one stage`);
    if (definition.finalReport && definition.execution !== "model") throw new Error(`final-report work package ${definition.key} must use model execution`);
    if (definition.bypassed && definition.execution !== "deterministic") throw new Error(`bypassed work package ${definition.key} must be deterministic`);
    if (definition.finalReport && (!definition.stageKeys.includes("report_assembly") || definition.outputKind !== "final_markdown")) throw new Error(`final-report work package ${definition.key} must own report_assembly as final_markdown`);
    for (const stageKey of definition.stageKeys) {
      if (stageOwners.has(stageKey)) throw new Error(`stage ${stageKey} belongs to multiple work packages`);
      stageOwners.set(stageKey, definition.key);
    }
    if (definition.execution === "model" && !definition.promptVersion) throw new Error(`model work package ${definition.key} requires promptVersion`);
    if (definition.execution === "deterministic" && definition.promptVersion) throw new Error(`deterministic work package ${definition.key} cannot declare promptVersion`);
    for (const dependency of definition.dependsOn) if (!definitions.some((candidate) => candidate.key === dependency)) throw new Error(`unknown work package dependency ${dependency}`);
    for (const dependency of definition.inputPackageKeys) if (!definitions.some((candidate) => candidate.key === dependency)) throw new Error(`unknown work package input dependency ${dependency}`);
    for (const reportKey of definition.reportReadyStageKeys) if (!definition.stageKeys.includes(reportKey) && reportKey !== "report_assembly") throw new Error(`work package ${definition.key} has unknown report-ready stage ${reportKey}`);
  }
}

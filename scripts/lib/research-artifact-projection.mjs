import projectionSpec from "../../config/research-artifact-projections.json" with { type: "json" };

const nodeTypes = Object.keys(projectionSpec.manifest.collections);

/**
 * Project one or more terminal artifacts into the small, explicit input that a
 * downstream research stage is allowed to consume.  The helper deliberately
 * has no Markdown fallback: a Markdown artifact contributes lineage/status,
 * while only a structured output object can contribute declared fields.
 */
export function projectResearchArtifacts({ stageKey, artifacts, fields, analysisGaps = [] } = {}) {
  const key = requiredText(stageKey, "stageKey");
  const stage = projectionSpec.stages[key];
  if (!stage) throw new Error(`research artifact projection has no contract for stage: ${key}`);
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error("research artifact projection requires at least one artifact");
  const requestedFields = fields === undefined ? [...stage.allowedFields] : strictFieldList(fields, stage.allowedFields);
  const seenArtifactIds = new Set();
  const fieldValues = {};
  const sourceArtifactIds = [];
  const upstreamArtifactIds = new Set();
  const sourceIds = new Set();
  const claimIds = new Set();
  const evidenceIds = new Set();
  const unknownIds = new Set();
  const inputFingerprints = new Set();
  const stageVersions = new Set();
  const statuses = {};

  for (const [index, artifact] of artifacts.entries()) {
    const value = asRecord(artifact, `artifacts[${index}]`);
    const artifactId = requiredText(value.artifactId, `artifacts[${index}].artifactId`);
    if (seenArtifactIds.has(artifactId)) throw new Error(`research artifact projection contains duplicate artifact ID: ${artifactId}`);
    seenArtifactIds.add(artifactId);
    const artifactStepKey = requiredText(value.stepKey, `artifacts[${index}].stepKey`);
    if (artifactStepKey !== key) throw new Error(`research artifact ${artifactId} belongs to ${artifactStepKey}, not ${key}`);
    sourceArtifactIds.push(artifactId);
    statuses[artifactId] = requiredText(value.status, `artifacts[${index}].status`);
    addIds(upstreamArtifactIds, value.upstreamArtifactIds, `artifacts[${index}].upstreamArtifactIds`);
    addIds(sourceIds, value.sourceIds, `artifacts[${index}].sourceIds`);
    addIds(claimIds, value.claimIds, `artifacts[${index}].claimIds`);
    addIds(evidenceIds, value.evidenceIds, `artifacts[${index}].evidenceIds`);
    addIds(unknownIds, value.unknownIds, `artifacts[${index}].unknownIds`);
    const inputFingerprint = optionalText(value.inputFingerprint);
    if (inputFingerprint) inputFingerprints.add(inputFingerprint);
    const stageVersion = optionalText(value.stageVersion);
    if (stageVersion) stageVersions.add(stageVersion);

    const output = value.output;
    if (output === undefined || output === null || typeof output === "string") continue;
    if (Array.isArray(output) || typeof output !== "object") throw new Error(`research artifact ${artifactId} output must be a structured object for projection`);
    const outputRecord = asRecord(output, `artifacts[${index}].output`);
    assertKnownFields(outputRecord, stage.allowedFields, `artifacts[${index}].output`);
    for (const field of requestedFields) {
      if (!Object.prototype.hasOwnProperty.call(outputRecord, field)) continue;
      if (Object.prototype.hasOwnProperty.call(fieldValues, field)) throw new Error(`research artifact projection has duplicate field owner: ${field}`);
      fieldValues[field] = outputRecord[field];
    }
  }

  const gaps = normalizeAnalysisGaps(analysisGaps);
  return {
    schemaVersion: projectionSpec.schemaVersion,
    projectionVersion: projectionSpec.projectionVersion,
    stageKey: key,
    sourceArtifactIds: sourceArtifactIds.sort(),
    upstreamArtifactIds: [...upstreamArtifactIds].sort(),
    sourceIds: [...sourceIds].sort(),
    claimIds: [...claimIds].sort(),
    evidenceIds: [...evidenceIds].sort(),
    unknownIds: [...unknownIds].sort(),
    inputFingerprints: [...inputFingerprints].sort(),
    stageVersions: [...stageVersions].sort(),
    statuses,
    fields: fieldValues,
    analysisGaps: gaps,
  };
}

export function projectResearchArtifact(input = {}) {
  return projectResearchArtifacts({ ...input, artifacts: [input.artifact] });
}

/**
 * Validate the source/evidence/claim/judgment/assumption-or-risk/calculation/
 * report graph.  References are named IDs only; array position is never an
 * identity.  Set allowPartial when validating an intermediate artifact that
 * intentionally has no report or downstream calculation yet.
 */
export function validateResearchArtifactManifest(manifest, { allowPartial = false } = {}) {
  const input = asRecord(manifest, "manifest");
  if (input.schemaVersion !== projectionSpec.manifest.schemaVersion) throw new Error(`research evidence manifest schema must be ${projectionSpec.manifest.schemaVersion}`);
  const rawCollections = asRecord(input.nodes, "manifest.nodes");
  const knownCollections = new Set(Object.values(projectionSpec.manifest.collections));
  const unknownCollections = Object.keys(rawCollections).filter((name) => !knownCollections.has(name));
  if (unknownCollections.length) throw new Error(`research evidence manifest has undeclared node collections: ${unknownCollections.join(", ")}`);
  const collections = {};
  const idsByType = {};
  const allIds = new Set();
  for (const type of nodeTypes) {
    const collectionName = projectionSpec.manifest.collections[type];
    const rows = rawCollections[collectionName];
    if (!Array.isArray(rows)) throw new Error(`research evidence manifest requires nodes.${collectionName}`);
    const normalized = [];
    const ids = new Set();
    for (const [index, row] of rows.entries()) {
      const node = asRecord(row, `manifest.nodes.${collectionName}[${index}]`);
      const id = strictId(node.id, `manifest.nodes.${collectionName}[${index}].id`);
      if (ids.has(id) || allIds.has(id)) throw new Error(`research evidence manifest has duplicate node ID: ${id}`);
      ids.add(id); allIds.add(id);
      normalized.push({ ...node, id });
    }
    normalized.sort((left, right) => left.id.localeCompare(right.id));
    collections[collectionName] = normalized;
    idsByType[type] = ids;
  }

  for (const type of nodeTypes) {
    const collectionName = projectionSpec.manifest.collections[type];
    const references = projectionSpec.manifest.references[type] || [];
    for (const [index, node] of collections[collectionName].entries()) {
      const path = `manifest.nodes.${collectionName}[${index}]`;
      for (const reference of references) {
        const values = strictIdArray(node[reference.field], `${path}.${reference.field}`);
        if (reference.required && values.length === 0) throw new Error(`${path}.${reference.field} must contain at least one named ID`);
        for (const id of values) if (!idsByType[reference.target].has(id)) throw new Error(`${path}.${reference.field} references unknown ${reference.target} ID: ${id}`);
        node[reference.field] = values.sort();
      }
      const requiredAny = projectionSpec.manifest.requiredAny?.[type] || [];
      for (const fields of requiredAny) {
        if (!fields.some((field) => strictIdArray(node[field], `${path}.${field}`).length > 0)) throw new Error(`${path} must reference one of: ${fields.join(", ")}`);
      }
    }
  }

  const reportRows = collections[projectionSpec.manifest.collections.report];
  if (!allowPartial && reportRows.length === 0) throw new Error("research evidence manifest requires at least one report node");
  if (!allowPartial) {
    for (const report of reportRows) {
      for (const calculationId of report.calculationIds) {
        const calculation = collections.calculations.find((row) => row.id === calculationId);
        if (!calculation || !calculationHasSourcePath(calculation, collections)) throw new Error(`report ${report.id} calculation ${calculationId} has no source-backed assumption/risk path`);
      }
    }
  }

  return {
    schemaVersion: projectionSpec.manifest.schemaVersion,
    nodes: collections,
  };
}

export const validateResearchEvidenceManifest = validateResearchArtifactManifest;

export function researchArtifactProjectionSpec() {
  return projectionSpec;
}

function calculationHasSourcePath(calculation, collections) {
  const branches = [
    ...(calculation.assumptionIds || []).map((id) => collections.assumptions.find((row) => row.id === id)),
    ...(calculation.riskIds || []).map((id) => collections.risks.find((row) => row.id === id)),
  ].filter(Boolean);
  return branches.some((branch) => (branch.judgmentIds || []).some((judgmentId) => {
    const judgment = collections.judgments.find((row) => row.id === judgmentId);
    return Boolean(judgment && (judgment.claimIds || []).some((claimId) => {
      const claim = collections.claims.find((row) => row.id === claimId);
      return Boolean(claim && (claim.evidenceIds || []).some((evidenceId) => {
        const evidence = collections.evidence.find((row) => row.id === evidenceId);
        return Boolean(evidence && (evidence.sourceIds || []).some((sourceId) => collections.sources.some((row) => row.id === sourceId)));
      }));
    }));
  }));
}

function addIds(target, value, path) {
  for (const id of strictIdArray(value, path)) target.add(id);
}

function strictFieldList(value, allowedFields) {
  if (!Array.isArray(value)) throw new Error("research artifact projection fields must be an array");
  const seen = new Set();
  for (const field of value) {
    if (typeof field !== "string" || !field.trim() || !allowedFields.includes(field.trim())) throw new Error(`research artifact projection field is not declared: ${String(field)}`);
    if (seen.has(field.trim())) throw new Error(`research artifact projection field is duplicated: ${field.trim()}`);
    seen.add(field.trim());
  }
  return [...seen];
}

function assertKnownFields(value, allowedFields, path) {
  const unknown = Object.keys(value).filter((field) => !allowedFields.includes(field));
  if (unknown.length) throw new Error(`${path} contains undeclared fields: ${unknown.join(", ")}`);
}

function normalizeAnalysisGaps(value) {
  if (!Array.isArray(value)) throw new Error("research artifact projection analysisGaps must be an array");
  const seen = new Set();
  return value.map((gap, index) => {
    const row = asRecord(gap, `analysisGaps[${index}]`);
    const gapId = strictId(row.gapId, `analysisGaps[${index}].gapId`);
    if (seen.has(gapId)) throw new Error(`research artifact projection contains duplicate gap ID: ${gapId}`);
    seen.add(gapId);
    return { ...row, gapId };
  }).sort((left, right) => left.gapId.localeCompare(right.gapId));
}

function strictIdArray(value, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array of named IDs`);
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const id = strictId(item, path);
    if (seen.has(id)) throw new Error(`${path} contains duplicate ID: ${id}`);
    seen.add(id); result.push(id);
  }
  return result;
}

function strictId(value, path) {
  if (typeof value !== "string") throw new Error(`${path} must be a string ID`);
  const id = value.trim();
  if (!id || /^\d+$/.test(id) || /\s/.test(id)) throw new Error(`${path} contains an invalid or positional ID`);
  return id;
}

function asRecord(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value;
}

function requiredText(value, path) {
  const result = optionalText(value);
  if (!result) throw new Error(`${path} is required`);
  return result;
}

function optionalText(value) {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

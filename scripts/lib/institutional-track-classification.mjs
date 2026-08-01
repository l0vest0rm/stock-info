export function buildInstitutionalTrackTaxonomyIndex(taxonomy) {
  if (!taxonomy || typeof taxonomy !== "object" || Array.isArray(taxonomy)) {
    throw new Error("institutional track taxonomy must be an object");
  }
  if (!Number.isInteger(taxonomy.version) || taxonomy.version < 1) {
    throw new Error("institutional track taxonomy version must be a positive integer");
  }

  const allowedPairs = new Set();
  const secondaryOwners = new Map();
  for (const primary of taxonomy.primaryTracks ?? []) {
    const primaryTrack = String(primary?.name || "").trim();
    if (!primaryTrack) throw new Error("institutional track taxonomy contains an empty primary track");
    for (const value of primary.secondaryTracks ?? []) {
      const secondaryTrack = String(value || "").trim();
      if (!secondaryTrack) throw new Error(`${primaryTrack}: contains an empty secondary track`);
      const previousOwner = secondaryOwners.get(secondaryTrack);
      if (previousOwner && previousOwner !== primaryTrack) {
        throw new Error(`${secondaryTrack}: secondary track belongs to both ${previousOwner} and ${primaryTrack}`);
      }
      secondaryOwners.set(secondaryTrack, primaryTrack);
      allowedPairs.add(pairKey(primaryTrack, secondaryTrack));
    }
  }
  if (allowedPairs.size === 0) throw new Error("institutional track taxonomy contains no track pairs");

  const industryAssignments = new Map();
  for (const rule of taxonomy.industryAssignments ?? []) {
    validateAssignment(rule, allowedPairs, "industry assignment");
    for (const rawIndustry of rule.industries ?? []) {
      const industry = String(rawIndustry || "").trim();
      if (!industry) throw new Error("institutional track taxonomy contains an empty industry");
      if (industryAssignments.has(industry)) throw new Error(`${industry}: duplicate exact industry assignment`);
      industryAssignments.set(industry, {
        primaryTrack: rule.primaryTrack,
        secondaryTrack: rule.secondaryTrack,
      });
    }
  }

  const companyAssignments = new Map();
  for (const group of taxonomy.companyAssignmentGroups ?? []) {
    validateAssignment(group, allowedPairs, "company assignment group");
    const reason = String(group.reason || "").trim();
    if (!reason) throw new Error("company assignment group requires a reason");
    for (const rawCode of group.codes ?? []) {
      addCompanyAssignment(companyAssignments, rawCode, group, reason);
    }
  }
  for (const [rawCode, assignment] of Object.entries(taxonomy.companyAssignments ?? {})) {
    validateAssignment(assignment, allowedPairs, `${rawCode} company assignment`);
    const reason = String(assignment.reason || "").trim();
    if (!reason) throw new Error(`${rawCode}: company assignment requires a reason`);
    addCompanyAssignment(companyAssignments, rawCode, assignment, reason);
  }

  return { allowedPairs, companyAssignments, industryAssignments, version: taxonomy.version };
}

export function classifyInstitutionalTrackRow(row, taxonomyOrIndex) {
  const index = taxonomyOrIndex?.allowedPairs
    ? taxonomyOrIndex
    : buildInstitutionalTrackTaxonomyIndex(taxonomyOrIndex);
  const code = String(row?.code || row?.SECUCODE || "").trim();
  const name = String(row?.name || row?.SECURITY_NAME_ABBR || "").trim();
  const industry = String(row?.industry || row?.INDUSTRY || row?.BOARD_NAME || "").trim();
  if (!code || !name || !industry) throw new Error("institutional track row requires code, name, and industry");

  const companyAssignment = index.companyAssignments.get(code);
  if (companyAssignment) {
    return {
      primaryTrack: companyAssignment.primaryTrack,
      secondaryTrack: companyAssignment.secondaryTrack,
      classificationBasis: "company",
      classificationLabel: companyAssignment.reason,
      classificationNote: `公司级主营校正：${companyAssignment.reason}。东财主题概念不参与主营赛道判定。`,
    };
  }

  const industryAssignment = index.industryAssignments.get(industry);
  if (!industryAssignment) {
    throw new Error(`${code} ${name}: unmapped exact Eastmoney industry "${industry}"`);
  }
  return {
    primaryTrack: industryAssignment.primaryTrack,
    secondaryTrack: industryAssignment.secondaryTrack,
    classificationBasis: "industry",
    classificationLabel: `东财行业：${industry}`,
    classificationNote: `按东财行业“${industry}”映射主营赛道；东财主题概念不参与主营赛道判定。`,
  };
}

export function classifyInstitutionalTrackSnapshot(snapshot, taxonomy) {
  if (!Array.isArray(snapshot?.rows)) throw new Error("institutional track snapshot rows must be an array");
  const index = buildInstitutionalTrackTaxonomyIndex(taxonomy);
  return {
    ...snapshot,
    classificationVersion: index.version,
    rows: snapshot.rows.map((row) => ({
      ...row,
      ...classifyInstitutionalTrackRow(row, index),
    })),
  };
}

function validateAssignment(assignment, allowedPairs, label) {
  const primaryTrack = String(assignment?.primaryTrack || "").trim();
  const secondaryTrack = String(assignment?.secondaryTrack || "").trim();
  if (!allowedPairs.has(pairKey(primaryTrack, secondaryTrack))) {
    throw new Error(`${label}: invalid track pair ${primaryTrack}/${secondaryTrack}`);
  }
}

function addCompanyAssignment(companyAssignments, rawCode, assignment, reason) {
  const code = String(rawCode || "").trim();
  if (!code) throw new Error("institutional track taxonomy contains an empty company code");
  if (companyAssignments.has(code)) throw new Error(`${code}: duplicate company assignment`);
  companyAssignments.set(code, {
    primaryTrack: assignment.primaryTrack,
    secondaryTrack: assignment.secondaryTrack,
    reason,
  });
}

function pairKey(primaryTrack, secondaryTrack) {
  return `${primaryTrack}\u0000${secondaryTrack}`;
}

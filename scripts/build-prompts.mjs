#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ontologyText = readFileSync(resolve(PROJECT_ROOT, 'config/knowledge/knowledge-ontology.json'), 'utf8');
// Preserve the existing label-independent byte contract exactly.
const feedCategoryCatalogHash = () => createHash('sha256').update(
  ontologyText.replace(/, "label": "(?:[^"\\]|\\.)*"/g, '')).digest('hex');

// Generate language-neutral contract metadata; prompt bodies stay in Markdown.
const feedConfig = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'config/knowledge/information-feed.json'), 'utf8'));
const hash = (text) => createHash('sha256').update(text).digest('hex');
const feedPrompt = (file) => readFileSync(resolve(PROJECT_ROOT, `prompts/information-feed/${file}`), 'utf8').trim();
const contract = {
  contractVersion: feedConfig.tagContract,
  promptHash: hash(feedPrompt('document-analysis-system.md') + feedPrompt('document-analysis-user.md')),
  categoryCatalogHash: feedCategoryCatalogHash(),
  candidatePolicyHash: hash(JSON.stringify(feedConfig.companyCandidates || {})),
  model: JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'config/app/llm.json'), 'utf8')).model,
};
const legacyContracts = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'config/knowledge/information-feed-legacy-contracts.json'), 'utf8'));
if (!Array.isArray(legacyContracts) || new Set([contract, ...legacyContracts].map((entry) => entry.contractVersion)).size !== legacyContracts.length + 1) {
  throw new Error('feed extraction contract versions must be distinct');
}
// The offline storage migration specifically verifies v5 provenance, not the
// most recent previous prompt. Readers accept every explicitly frozen contract.
const legacyContract = legacyContracts.find((entry) => entry.contractVersion === 'feed-tag-v5');
if (!legacyContract) throw new Error('v5 feed extraction contract is required for the storage backfill');
// Keep the checked-in manifest's exact previous model contracts when routing
// changes. A config-only model switch must not make historical records disappear.
// Never widen acceptance by omitting the model or any provenance fingerprint.
const manifestPath = resolve(PROJECT_ROOT, 'config/generated/information-records-contract.json');
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
const fields = ['contractVersion', 'promptHash', 'categoryCatalogHash', 'candidatePolicyHash', 'model'];
const identity = (entry) => {
  if (!entry || Object.keys(entry).length !== fields.length || fields.some((key) => typeof entry[key] !== 'string' || !entry[key])) {
    throw new Error('invalid frozen feed extraction contract');
  }
  return JSON.stringify(fields.map((key) => entry[key]));
};
const history = new Map();
for (const entry of [...legacyContracts, ...(previous?.legacy || []), ...(previous?.current ? [previous.current] : [])]) {
  if (identity(entry) !== identity(contract)) history.set(identity(entry), entry);
}
mkdirSync(resolve(PROJECT_ROOT, 'config/generated'), { recursive: true });
writeFileSync(manifestPath, JSON.stringify({ current: contract, legacy: [...history.values()] }, null, 2) + '\n');

// The ontology owns category names; UI labels must not become a second catalog.
const ontology = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'config/knowledge/knowledge-ontology.json'), 'utf8'));
const categories = ontology.informationExtraction.categories;
for (const [id, rule] of Object.entries(categories)) {
  if (!rule.label || !['required', 'optional', 'forbidden'].includes(rule.periodPolicy)
    || !rule.informationTypes.length || rule.informationTypes.some((type) => !ontology.informationExtraction.informationTypes.includes(type))) {
    throw new Error(`invalid information category: ${id}`);
  }
}
writeFileSync(resolve(PROJECT_ROOT, 'web/src/config/information-feed-labels.json'),
  JSON.stringify({ categories: Object.fromEntries(Object.entries(categories).map(([id, rule]) => [id, rule.label])) }, null, 2) + '\n');

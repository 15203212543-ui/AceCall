#!/usr/bin/env node
// Turn a local candidate JSON export into document records.
// Does not connect to CloudBase and does not print the resume body.
// Usage: node scripts/backfill-candidate-documents.js < candidates.json

const fs = require('node:fs');
const { prepareDocumentVersions } = require('../cloudfunctions/acecall-api/document-text');
const { buildLegacyDocument } = require('../cloudfunctions/acecall-api/candidate-documents');
const { normalizeResumeText } = require('../server');

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error('请提供输出文件路径。脚本不会把简历正文打印到终端。');
  const input = JSON.parse(await readStdin() || '[]');
  const candidates = Array.isArray(input) ? input : (input.candidates || input.cases || []);
  const documents = [];
  const patches = [];
  for (const candidate of candidates) {
    if (!candidate?.resume) continue;
    const built = buildLegacyDocument(candidate, raw => prepareDocumentVersions(raw, normalizeResumeText));
    documents.push(built.document);
    patches.push({ id: candidate.id, documentId: built.candidatePatch.documentId, resumeSummary: built.candidatePatch.resumeSummary });
  }
  fs.writeFileSync(output, JSON.stringify({ documents, patches }, null, 2));
  process.stdout.write(`wrote ${documents.length} document records to ${output}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

const PARSE_VERSION = 'resume-clean-v1';

function prepareDocumentVersions(rawInput, clean) {
  const rawText = String(rawInput ?? '');
  const cleanedText = clean(rawText);
  return {
    rawText,
    cleanedText,
    parseVersion: PARSE_VERSION,
    lineMap: mapCleanedLines(rawText, cleanedText)
  };
}

function mapCleanedLines(rawText, cleanedText) {
  const rawLines = String(rawText).replace(/\r/g, '').split('\n');
  return String(cleanedText).split('\n').filter(line => line.trim()).map((line, cleanedIndex) => {
    const needle = line.normalize('NFKC').replace(/\s+/g, '');
    const rawLine = rawLines.findIndex(item => item.normalize('NFKC').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, '').includes(needle));
    return { cleanedIndex, rawLine, quote: line };
  });
}

function locateQuote(quote, versions = {}) {
  const needle = String(quote || '').replace(/\s+/g, ' ').trim();
  if (!needle) return { verified: 'failed', source: '' };
  const raw = String(versions.rawText || '').replace(/\s+/g, ' ');
  const cleaned = String(versions.cleanedText || '').replace(/\s+/g, ' ');
  if (raw.includes(needle)) return { verified: 'exact', source: 'rawText' };
  if (cleaned.includes(needle)) return { verified: 'exact', source: 'cleanedText' };
  const compact = needle.replace(/[\s,，。；;]/g, '');
  if (compact.length >= 4 && raw.replace(/[\s,，。；;]/g, '').includes(compact)) return { verified: 'fuzzy', source: 'rawText' };
  if (compact.length >= 4 && cleaned.replace(/[\s,，。；;]/g, '').includes(compact)) return { verified: 'fuzzy', source: 'cleanedText' };
  return { verified: 'failed', source: '' };
}

module.exports = { PARSE_VERSION, prepareDocumentVersions, locateQuote };

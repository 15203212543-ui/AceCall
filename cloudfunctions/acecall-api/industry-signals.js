function internalCluesFromFacts(facts = []) {
  return facts.filter(fact => fact.status === 'confirmed' && ['company', 'experience'].includes(fact.factType) && (fact.evidences || []).some(item => item.quote && item.verified !== 'failed')).map(fact => {
    const evidence = fact.evidences.find(item => item.quote && item.verified !== 'failed');
    return { clue: typeof fact.value === 'string' ? fact.value : (fact.value?.company || ''), quote: evidence.quote, audience: 'internal' };
  }).filter(item => item.clue && item.quote);
}

function externalReport(report = {}) {
  const copy = { ...report };
  delete copy.internalClues;
  delete copy.industrySignals;
  return copy;
}

function rubricFromCorrections(corrections = []) {
  return {
    required: [...new Set(corrections.filter(item => item.promoteToRequired && item.item).map(item => item.item))],
    misjudgments: corrections.filter(item => item.corrected).map(item => ({ item: item.item || '', from: item.from || '', to: item.to || '' })),
    followUpTemplates: corrections.map(item => item.followUp).filter(Boolean),
    version: 1
  };
}

module.exports = { internalCluesFromFacts, externalReport, rubricFromCorrections };

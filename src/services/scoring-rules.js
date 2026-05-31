const { commonCriteria } = require('../constants');

function parsePresence(presence) {
    const normalized = String(presence || '').replace('%', '').replace(',', '.');
    const parsed = Number.parseFloat(normalized);
    return Number.isNaN(parsed) ? 0 : parsed;
}

function isPresenceEligible(presenceValue) {
    return presenceValue >= 80;
}

function numericValue(value) {
    return typeof value === 'number' ? value : 0;
}

function average(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundOneDecimal(value) {
    return Math.round(value * 10) / 10;
}

function calculateTotalPoints(scoreMap, peso2Criterion) {
    const peso1 = numericValue(scoreMap.presenca_auxilios) + numericValue(scoreMap.comprometimento_eventos);
    const peso2 = numericValue(scoreMap[peso2Criterion]) * 8;
    const peso3Base = commonCriteria
        .slice(2)
        .reduce((sum, criterion) => sum + numericValue(scoreMap[criterion]), 0);

    return peso1 + peso2 + (peso3Base * (150 / 70));
}

function calculateFinalNote(scoreMap, peso2Criterion) {
    const total = calculateTotalPoints(scoreMap, peso2Criterion);
    return total ? roundOneDecimal(total / 25) : 0;
}

function determineResultStatus(finalNote, approved, numEvaluators) {
    // Aprovado se: nota >= 7 E maioria simples dos avaliadores.
    return finalNote >= 7 && approved > (numEvaluators / 2)
        ? 'Aprovado'
        : 'Reprovado';
}

module.exports = {
    average,
    calculateFinalNote,
    calculateTotalPoints,
    determineResultStatus,
    isPresenceEligible,
    numericValue,
    parsePresence,
    roundOneDecimal,
};

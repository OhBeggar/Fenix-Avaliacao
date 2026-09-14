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
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundOneDecimal(value) {
    return Math.round(value * 10) / 10;
}

/**
 * Nota final alinhada à planilha Excel da Fênix.
 *
 * Peso 1 (10%): Presença nos auxílios + Comprometimento
 * Peso 2 (30%): Deslocamento/Floreio + Abraço e Postura + Equilíbrio
 * Peso 3 (60%): Passos + Ritmo + Corpo do Ritmo + Condução + Musicalidade
 *
 * Presença nas aulas (%) NÃO entra na nota — só no filtro isPresenceEligible (>= 80).
 * 
 * Nota Final = (médiaPeso1 * 0.1) + (médiaPeso2 * 0.3) + (médiaPeso3 * 0.6)
 *
 * @param {object} scoreMap - Mapa de critérios com notas numéricas (de 1 a 10)
 * @param {string} peso2Criterion - Critério de gênero (deslocamento_cavalheiro ou floreio_dama)
 * @param {number} [_presencePercentage] - Mantido por compatibilidade; não entra na nota.
 */
function calculateFinalNote(scoreMap, peso2Criterion, _presencePercentage) {
    const mediaPeso1 = average([
        numericValue(scoreMap.presenca_auxilios),
        numericValue(scoreMap.comprometimento_eventos),
    ]);

    const mediaPeso2 = average([
        numericValue(scoreMap[peso2Criterion]),
        numericValue(scoreMap.abraco_postura),
        numericValue(scoreMap.equilibrio),
    ]);

    const mediaPeso3 = average([
        numericValue(scoreMap.passos),
        numericValue(scoreMap.ritmo),
        numericValue(scoreMap.corpo_ritmo),
        numericValue(scoreMap.conducao),
        numericValue(scoreMap.musicalidade),
    ]);

    const finalNote = (mediaPeso1 * 0.1) + (mediaPeso2 * 0.3) + (mediaPeso3 * 0.6);
    return roundOneDecimal(finalNote);
}

/**
 * @deprecated Preferir calculateFinalNote. Mantida por compatibilidade.
 */
function calculateTotalPoints(scoreMap, peso2Criterion) {
    return calculateFinalNote(scoreMap, peso2Criterion) * 25;
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

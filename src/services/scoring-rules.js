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

/**
 * Calcula a nota final usando médias ponderadas.
 *
 * Peso 1 (10%): Presença nas aulas (convertida de % para nota 0-10) + Presença nos auxílios
 * Peso 2 (30%): Comprometimento + Deslocamento/Floreio + Abraço e Postura
 * Peso 3 (60%): Equilíbrio + Passos + Ritmo + Corpo do Ritmo + Condução + Musicalidade
 *
 * Nota Final = (médiaPeso1 * 0.1) + (médiaPeso2 * 0.3) + (médiaPeso3 * 0.6)
 *
 * @param {object} scoreMap - Mapa de critérios com notas numéricas (de 1 a 10)
 * @param {string} peso2Criterion - Critério de gênero (deslocamento_cavalheiro ou floreio_dama)
 * @param {number} presencePercentage - Presença nas aulas em percentual (ex: 95.08)
 */
function calculateFinalNote(scoreMap, peso2Criterion, presencePercentage) {
    const presenceAsNote = typeof presencePercentage === 'number' ? presencePercentage / 10 : 0;

    // Peso 1 (10%): Presença nas aulas (nota) + Presença nos auxílios
    const peso1Values = [presenceAsNote, numericValue(scoreMap.presenca_auxilios)];
    const mediaPeso1 = average(peso1Values);

    // Peso 2 (30%): Comprometimento + Deslocamento/Floreio + Abraço e Postura
    const peso2Values = [
        numericValue(scoreMap.comprometimento_eventos),
        numericValue(scoreMap[peso2Criterion]),
        numericValue(scoreMap.abraco_postura),
        numericValue(scoreMap.equilibrio),
    ];
    const mediaPeso2 = average(peso2Values);

    // Peso 3 (60%): Equilíbrio + Passos + Ritmo + Corpo do Ritmo + Condução + Musicalidade
    const peso3Values = [
        numericValue(scoreMap.passos),
        numericValue(scoreMap.ritmo),
        numericValue(scoreMap.corpo_ritmo),
        numericValue(scoreMap.conducao),
        numericValue(scoreMap.musicalidade),
    ];
    const mediaPeso3 = average(peso3Values);

    const finalNote = (mediaPeso1 * 0.1) + (mediaPeso2 * 0.3) + (mediaPeso3 * 0.6);
    return roundOneDecimal(finalNote);
}

/**
 * @deprecated Use calculateFinalNote diretamente. Mantida apenas por compatibilidade. Excluir depois as linhas 69 a 74.
 */
function calculateTotalPoints(scoreMap, peso2Criterion) {
    return calculateFinalNote(scoreMap, peso2Criterion, 0) * 25;
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
    calculateTotalPoints, // Remover função deprecated depois de atualizar o front-end para usar calculateFinalNote
    determineResultStatus,
    isPresenceEligible,
    numericValue,
    parsePresence,
    roundOneDecimal,
};

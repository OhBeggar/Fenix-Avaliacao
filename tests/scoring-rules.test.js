const test = require('node:test');
const assert = require('node:assert/strict');

const {
    calculateFinalNote,
    calculateTotalPoints,
    determineResultStatus,
    isPresenceEligible,
    parsePresence,
} = require('../src/services/scoring-rules');

test('parsePresence handles percentage strings and special cases', () => {
    assert.equal(parsePresence('95.52%'), 95.52);
    assert.equal(parsePresence('83,58%'), 83.58);
    assert.equal(parsePresence('Grávida'), 0);
});

test('isPresenceEligible enforces the 80 percent rule', () => {
    assert.equal(isPresenceEligible(80), true);
    assert.equal(isPresenceEligible(79.99), false);
});

test('calculateTotalPoints matches the weighting model', () => {
    const scoreMap = {
        presenca_auxilios: 10,
        comprometimento_eventos: 10,
        deslocamento_cavalheiro: 10,
        abraco_postura: 10,
        equilibrio: 10,
        passos: 10,
        ritmo: 10,
        corpo_ritmo: 10,
        conducao: 10,
        musicalidade: 10,
    };

    assert.equal(calculateTotalPoints(scoreMap, 'deslocamento_cavalheiro'), 230);
    assert.equal(calculateFinalNote(scoreMap, 'deslocamento_cavalheiro'), 10);
});

test('calculateFinalNote ignores missing technical scores as zero', () => {
    const scoreMap = {
        presenca_auxilios: 8,
        comprometimento_eventos: 7,
        floreio_dama: 6,
        abraco_postura: '-',
        equilibrio: '-',
        passos: '-',
        ritmo: '-',
        corpo_ritmo: '-',
        conducao: '-',
        musicalidade: '-',
    };

    assert.equal(calculateTotalPoints(scoreMap, 'floreio_dama'), 27);
    assert.equal(calculateFinalNote(scoreMap, 'floreio_dama'), 1.2);
});

test('determineResultStatus requires final note and majority approval', () => {
    assert.equal(determineResultStatus(7.3, 7, 12), 'Aprovado');
    assert.equal(determineResultStatus(6.9, 10, 12), 'Reprovado');
    assert.equal(determineResultStatus(7.3, 6, 12), 'Reprovado');
});

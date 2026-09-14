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

    assert.equal(calculateTotalPoints(scoreMap, 'deslocamento_cavalheiro'), 250);
    assert.equal(calculateFinalNote(scoreMap, 'deslocamento_cavalheiro', 100), 10);
});

test('calculateFinalNote handles score boundaries and gender-specific criteria', () => {
    const allSeven = {
        presenca_auxilios: 7,
        comprometimento_eventos: 7,
        deslocamento_cavalheiro: 7,
        floreio_dama: 2,
        abraco_postura: 7,
        equilibrio: 7,
        passos: 7,
        ritmo: 7,
        corpo_ritmo: 7,
        conducao: 7,
        musicalidade: 7,
    };

    assert.equal(calculateFinalNote(allSeven, 'deslocamento_cavalheiro', 70), 7);
    assert.equal(calculateFinalNote(allSeven, 'deslocamento_cavalheiro', 80), 7);
    assert.equal(calculateFinalNote(allSeven, 'deslocamento_cavalheiro', 100), 7);
    assert.equal(calculateFinalNote(allSeven, 'floreio_dama', 100), 6.5);

    const missingScores = { presenca_auxilios: 10 };
    assert.equal(calculateFinalNote(missingScores, 'floreio_dama', 100), 0.5);
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

    assert.equal(calculateTotalPoints(scoreMap, 'floreio_dama'), 35);
    assert.equal(calculateFinalNote(scoreMap, 'floreio_dama', 0), 1.4);
});

test('determineResultStatus requires final note and majority approval', () => {
    assert.equal(determineResultStatus(7.3, 7, 12), 'Aprovado');
    assert.equal(determineResultStatus(7, 7, 12), 'Aprovado');
    assert.equal(determineResultStatus(6.9, 10, 12), 'Reprovado');
    assert.equal(determineResultStatus(7.3, 6, 12), 'Reprovado');
    assert.equal(determineResultStatus(7.3, 6, 12), 'Reprovado');
});

const commonCriteria = [
    'presenca_auxilios',
    'comprometimento_eventos',
    'abraco_postura',
    'equilibrio',
    'passos',
    'ritmo',
    'corpo_ritmo',
    'conducao',
    'musicalidade',
];

const maleCriteria = 'deslocamento_cavalheiro';
const femaleCriteria = 'floreio_dama';

function getCriteriaFor(gender) {
    return commonCriteria.concat(gender === 'male' ? maleCriteria : femaleCriteria);
}

module.exports = {
    commonCriteria,
    maleCriteria,
    femaleCriteria,
    getCriteriaFor,
};

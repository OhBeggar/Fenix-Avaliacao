const test = require('node:test');
const assert = require('node:assert/strict');

const { _private } = require('../src/services/pdf-service');

test('PDF title uses current_rank instead of evaluation status', () => {
    const title = _private.getDynamicTitle([
        {
            name: 'Aluno A',
            status: 'Aprovado',
            current_rank: 'Monitor',
            final_status: 'Professor',
        },
    ]);

    assert.equal(title, 'AUDICAO DE MONITORES 2024_2 PARA PROFESSORES 2025_2');
});

test('PDF title falls back to final_status for old history snapshots', () => {
    const title = _private.getDynamicTitle([
        {
            name: 'Aluno Antigo',
            status: 'Aprovado',
            final_status: 'Auxiliar',
        },
    ]);

    assert.equal(title, 'AUDICAO DE AUXILIARES 2024_2 PARA ASSISTENTES 2025_2');
});

test('PDF title falls back safely when no rank is available', () => {
    const title = _private.getDynamicTitle([
        {
            name: 'Aluno Sem Patente',
            status: 'Aprovado',
            final_status: 'Aprovado',
        },
    ]);

    assert.equal(title, 'AUDICAO DE CANDIDATOS 2024_2 PARA CANDIDATOS 2025_2');
});

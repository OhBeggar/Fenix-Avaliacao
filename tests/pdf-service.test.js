const test = require('node:test');
const assert = require('node:assert/strict');

const { _private } = require('../src/services/pdf-service');

test('PDF title uses turma and rank progression', () => {
    const title = _private.getDynamicTitle({
        turma: { name: 'T1' },
        results: [
            {
                name: 'Aluno A',
                status: 'Aprovado',
                current_rank: 'Bolsista',
                final_status: 'Auxiliar',
            },
        ],
    });

    assert.equal(title, 'T1 - Bolsistas para T1 Auxiliares');
});

test('PDF title uses predominant initial rank for mixed turma', () => {
    const title = _private.getDynamicTitle({
        turma: { name: 'T2' },
        results: [
            {
                name: 'Aluno Auxiliar',
                current_rank: 'Auxiliar',
                final_status: 'Assistente',
            },
            {
                name: 'Aluno Bolsista 1',
                current_rank: 'Bolsista',
                final_status: 'Auxiliar',
            },
            {
                name: 'Aluno Bolsista 2',
                current_rank: 'Bolsista',
                final_status: 'Auxiliar',
            },
        ],
    });

    assert.equal(title, 'T2 - Bolsistas para T2 Auxiliares');
});

test('PDF title keeps first valid rank when mixed turma has a tie', () => {
    const title = _private.getDynamicTitle({
        turma: { name: 'T3' },
        results: [
            {
                name: 'Aluno Auxiliar',
                current_rank: 'Auxiliar',
                final_status: 'Assistente',
            },
            {
                name: 'Aluno Bolsista',
                current_rank: 'Bolsista',
                final_status: 'Auxiliar',
            },
        ],
    });

    assert.equal(title, 'T3 - Auxiliares para T3 Assistentes');
});

test('PDF title uses historical event turma name', () => {
    const title = _private.getDynamicTitle({
        event: { turma_name: 'Histórico T1' },
        results: [
            {
                name: 'Aluno Histórico',
                current_rank: 'Auxiliar',
                final_status: 'Assistente',
            },
        ],
    });

    assert.equal(title, 'Histórico T1 - Auxiliares para Histórico T1 Assistentes');
});

test('PDF title falls back to final_status for old history snapshots', () => {
    const title = _private.getDynamicTitle({
        turma: { name: 'T4' },
        results: [
            {
                name: 'Aluno Antigo',
                status: 'Aprovado',
                final_status: 'Auxiliar',
            },
        ],
    });

    assert.equal(title, 'T4 - Auxiliares para T4 Assistentes');
});

test('PDF title uses generic consolidated title without turma', () => {
    const title = _private.getDynamicTitle({
        results: [
            {
                name: 'Aluno A',
                current_rank: 'Bolsista',
                final_status: 'Auxiliar',
            },
        ],
    });

    assert.equal(title, 'Avaliação Geral - Resultado Consolidado');
});

test('PDF title falls back safely when no rank is available', () => {
    const title = _private.getDynamicTitle({
        turma: { name: 'T5' },
        results: [
            {
                name: 'Aluno Sem Patente',
                status: 'Aprovado',
                final_status: 'Aprovado',
            },
        ],
    });

    assert.equal(title, 'T5 - Candidatos para T5 Candidatos');
});

test('PDF title keeps backwards compatibility for array-only calls as generic', () => {
    const title = _private.getDynamicTitle([
        {
            name: 'Aluno A',
            status: 'Aprovado',
            current_rank: 'Monitor',
            final_status: 'Professor',
        },
    ]);

    assert.equal(title, 'Avaliação Geral - Resultado Consolidado');
});

test('PDF text sanitizer preserves Portuguese accents and removes unsupported symbols', () => {
    assert.equal(
        _private.sanitize('Avaliação, Presença, Condução, Nº 🚀'),
        'Avaliação, Presença, Condução, Nº'
    );
});

test('PDF column labels keep Portuguese accents', () => {
    const labels = _private.COLUMNS.map(column => column.label);

    assert.ok(labels.includes('Nº'));
    assert.ok(labels.includes('Presença\nnas aulas\n(80%)'));
    assert.ok(labels.includes('Condução'));
    assert.ok(labels.includes('Abraço e\nPostura'));
});

test('PDF attachment disposition includes ASCII fallback and UTF-8 filename', () => {
    const disposition = _private.buildAttachmentDisposition('historico-Avaliação - T1 - 2026-05-29.pdf');

    assert.match(disposition, /^attachment; filename="historico-Avaliacao_-_T1_-_2026-05-29\.pdf"/);
    assert.match(disposition, /filename\*=UTF-8''historico-Avalia%C3%A7%C3%A3o%20-%20T1%20-%202026-05-29\.pdf/);
});

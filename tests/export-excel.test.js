const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { buildResultsExcel } = require('../src/services/export-excel');

test('buildResultsExcel generates valid workbook buffer with consolidation and evaluator sheets', async () => {
    const mockReport = {
        dynamicTitle: 'Audição Bolsistas 2025_1',
        turma: { name: 'Ivan Bonatti 2025_1' },
        results: [
            {
                name: 'Aluno A',
                presence: '100%',
                averages: {
                    presenca_auxilios: '10',
                    comprometimento_eventos: '9',
                    deslocamento_cavalheiro: '8',
                    abraco_postura: '8',
                    equilibrio: '9',
                    passos: '8',
                    ritmo: '9',
                    corpo_ritmo: '8',
                    conducao: '9',
                    musicalidade: '8',
                },
                final_note: 8.5,
                approved: 2,
                reproved: 0,
                status: 'Aprovado',
                final_status: 'Auxiliar',
                individual_evaluations: {
                    '1': {
                        name: 'Ivan Bonatti',
                        finalNote: 8.5,
                        isApproved: true,
                        scores: {
                            presenca_auxilios: 10,
                            comprometimento_eventos: 9,
                            deslocamento_cavalheiro: 8,
                            abraco_postura: 8,
                            equilibrio: 9,
                            passos: 8,
                            ritmo: 9,
                            corpo_ritmo: 8,
                            conducao: 9,
                            musicalidade: 8,
                        },
                    },
                    '2': {
                        name: 'Bruna Ribeiro',
                        finalNote: 8.5,
                        isApproved: true,
                        scores: {
                            presenca_auxilios: 10,
                            comprometimento_eventos: 9,
                            deslocamento_cavalheiro: 8,
                            abraco_postura: 8,
                            equilibrio: 9,
                            passos: 8,
                            ritmo: 9,
                            corpo_ritmo: 8,
                            conducao: 9,
                            musicalidade: 8,
                        },
                    },
                },
            },
            {
                name: 'Aluno B',
                presence: '70%',
                averages: {},
                final_note: 0,
                approved: 0,
                reproved: 2,
                status: 'Reprovado',
                final_status: 'Bolsista',
                individual_evaluations: {},
            },
        ],
    };

    const buffer = await buildResultsExcel(mockReport);
    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(buffer.length > 0);

    // Read back workbook from buffer to verify contents
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const consolSheet = workbook.getWorksheet('Consolidação');
    assert.ok(consolSheet, 'Consolidação sheet should exist');
    assert.equal(consolSheet.rowCount, 3); // Header + 2 rows

    const ivanSheet = workbook.getWorksheet('Ivan Bonatti');
    assert.ok(ivanSheet, 'Evaluator Ivan Bonatti sheet should exist');

    const brunaSheet = workbook.getWorksheet('Bruna Ribeiro');
    assert.ok(brunaSheet, 'Evaluator Bruna Ribeiro sheet should exist');

    const infoSheet = workbook.getWorksheet('Info');
    assert.ok(infoSheet, 'Info sheet should exist');
});

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// ==========================================
// CONFIGURAÇÕES DO RELATÓRIO
// ==========================================
// Semestres (Atualize manualmente apenas quando virar o semestre)
const SEMESTER_LABELS = {
    current: '2024_2',
    next: '2025_2'
};

// Hierarquia de Progressão de Patentes
const RANK_HIERARCHY = ['Bolsista', 'Auxiliar', 'Assistente', 'Monitor', 'Professor'];

// ==========================================

function sanitize(text) {
    return String(text)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\x00-\x7F]/g, '');
}

// Função para gerar o título dinâmico baseado no status dos candidatos
function getDynamicTitle(results) {
    if (!results || results.length === 0) return 'RELATORIO DE AVALIACAO';

    // 1. Tenta identificar o nível base da maioria dos alunos
    const validCandidates = results.filter(r => RANK_HIERARCHY.includes(r.status));

    let baseRank = 'Candidato'; // Fallback padrão

    if (validCandidates.length > 0) {
        // Pega o status do primeiro aluno válido (assumindo turma homogênea)
        baseRank = validCandidates[0].status;
    } else {
        // Status especial ou turma mista — pega o primeiro disponível que não seja reprovado
        const anyCandidate = results.find(r => r.status && r.status !== 'Reprovado');
        if (anyCandidate) baseRank = anyCandidate.status;
    }

    // 2. Descobre o próximo nível na hierarquia
    const currentIndex = RANK_HIERARCHY.indexOf(baseRank);
    let nextRank = baseRank;

    if (currentIndex !== -1 && currentIndex < RANK_HIERARCHY.length - 1) {
        nextRank = RANK_HIERARCHY[currentIndex + 1];
    }

    // 3. Formata para plural (ex: Bolsista -> Bolsistas)
    const formatPlural = (rank) => rank + 's';

    // 4. Monta o título final
    // Ex: AUDICAO DE BOLSISTAS 2024_2 PARA AUXILIARES 2025_2
    const currentPlural = formatPlural(baseRank).toUpperCase();
    const nextPlural = formatPlural(nextRank).toUpperCase();

    return `AUDICAO DE ${currentPlural} ${SEMESTER_LABELS.current} PARA ${nextPlural} ${SEMESTER_LABELS.next}`;
}

async function buildResultsPdf(report) {
    const { results, numEvaluators } = report;

    // Gera o título dinâmico baseado nos alunos
    const titleText = getDynamicTitle(results);

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontSize = 7;
    const headerSize = 12;

    let page = pdfDoc.addPage([842, 595]); // A4 Landscape
    const pageSize = page.getSize();
    let y = pageSize.height - 40;

    // Título Dinâmico
    page.drawText(titleText, {
        x: pageSize.width / 2 - fontBold.widthOfTextAtSize(titleText, headerSize) / 2,
        y,
        size: headerSize,
        font: fontBold,
    });
    y -= 20;

    const subtitleText = `Resultados finais - ${numEvaluators} avaliadores`;
    page.drawText(subtitleText, {
        x: pageSize.width / 2 - font.widthOfTextAtSize(subtitleText, 10) / 2,
        y,
        size: 10,
        font,
    });
    y -= 25;

    const headers = [
        'Nº', 'Candidato', 'Presenca', 'Pres.Aux', 'Comprom.', 'Desl./Flor.',
        'Abraco', 'Equil.', 'Passos', 'Ritmo', 'C.Ritmo', 'Conducao', 'Musical.',
        'Nota', 'Aprov.', 'Repr.', 'Status', 'Patente'
    ];
    const columnWidths = [22, 90, 42, 38, 42, 48, 38, 34, 38, 34, 40, 44, 42, 32, 32, 32, 48, 48];

    drawHeaderRow(page, y, headers, columnWidths, fontBold, fontSize);
    y -= 14;

    results.forEach((result, index) => {
        if (y < 40) {
            page = pdfDoc.addPage([842, 595]);
            y = 555;
            drawHeaderRow(page, y, headers, columnWidths, fontBold, fontSize);
            y -= 14;
        }

        const averages = result.averages || {};
        const genderCriterion = averages.deslocamento_cavalheiro ?? averages.floreio_dama ?? '-';
        const values = [
            String(index + 1),
            result.name,
            result.presence,
            String(averages.presenca_auxilios ?? '-'),
            String(averages.comprometimento_eventos ?? '-'),
            String(genderCriterion),
            String(averages.abraco_postura ?? '-'),
            String(averages.equilibrio ?? '-'),
            String(averages.passos ?? '-'),
            String(averages.ritmo ?? '-'),
            String(averages.corpo_ritmo ?? '-'),
            String(averages.conducao ?? '-'),
            String(averages.musicalidade ?? '-'),
            String(result.final_note),
            String(result.approved),
            String(result.reproved),
            result.status,
            result.final_status, // Patente final calculada pela hierarquia
        ];

        let x = 20;
        const rowColor = index % 2 === 0 ? rgb(1, 1, 1) : rgb(0.95, 0.97, 1);

        values.forEach((value, columnIndex) => {
            let fillColor = rowColor;
            let textColor = rgb(0, 0, 0);

            // Destaque para a Nota Final (coluna 13)
            if (columnIndex === 13) {
                if (result.final_note >= 7.0) {
                    fillColor = rgb(0.83, 0.93, 0.85); // Verde claro
                    textColor = rgb(0.08, 0.34, 0.14);
                } else {
                    fillColor = rgb(0.97, 0.84, 0.85); // Vermelho claro
                    textColor = rgb(0.45, 0.11, 0.14);
                }
            }

            page.drawRectangle({
                x,
                y: y - 2,
                width: columnWidths[columnIndex],
                height: 14,
                borderColor: rgb(0.6, 0.6, 0.6),
                borderWidth: 0.3,
                color: fillColor,
            });
            page.drawText(sanitize(value).substring(0, Math.floor(columnWidths[columnIndex] / 4)), {
                x: x + 2,
                y: y + 2,
                size: fontSize,
                font,
                color: textColor,
            });
            x += columnWidths[columnIndex];
        });

        y -= 14;
    });

    y -= 10;
    if (y < 40) {
        page = pdfDoc.addPage([842, 595]);
        y = 555;
    }

    page.drawText(
        `APROVADO = Nota media >= 7.0 e maioria simples dos avaliadores (mais de ${Math.floor(numEvaluators / 2)} aprovacoes)`,
        { x: 20, y, size: 8, font }
    );

    return pdfDoc.save();
}

function drawHeaderRow(page, y, headers, columnWidths, fontBold, fontSize) {
    let x = 20;
    headers.forEach((header, index) => {
        page.drawRectangle({
            x,
            y: y - 2,
            width: columnWidths[index],
            height: 14,
            borderColor: rgb(0.4, 0.4, 0.4),
            borderWidth: 0.5,
            color: rgb(0.88, 0.88, 0.88),
        });
        page.drawText(sanitize(header), {
            x: x + 2,
            y: y + 2,
            size: fontSize,
            font: fontBold,
        });
        x += columnWidths[index];
    });
}

module.exports = {
    buildResultsPdf,
};

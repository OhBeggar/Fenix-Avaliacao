const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const SEMESTER_LABELS = {
  current: '2024_2',
  next: '2025_2',
};

const RANK_HIERARCHY = ['Bolsista', 'Auxiliar', 'Assistente', 'Monitor', 'Professor'];
const PAGE_SIZE = [842, 595];
const MARGIN_X = 28;
const TABLE_WIDTH = PAGE_SIZE[0] - (MARGIN_X * 2);
const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 58;

const COLORS = {
  black: rgb(0.05, 0.05, 0.05),
  white: rgb(1, 1, 1),
  border: rgb(0.08, 0.08, 0.08),
  softBorder: rgb(0.35, 0.35, 0.35),
  titleBand: rgb(0.86, 0.83, 0.75),
  groupBlue: rgb(0.27, 0.49, 0.72),
  headerCyan: rgb(0.33, 0.92, 0.92),
  rankGreen: rgb(0.35, 0.95, 0.02),
  rowCream: rgb(0.86, 0.83, 0.74),
  rowBlue: rgb(0.48, 0.83, 0.92),
  passGreen: rgb(0.52, 1, 0.06),
  failPink: rgb(1, 0.9, 0.9),
  red: rgb(0.82, 0, 0.08),
};

const COLUMNS = [
  { key: 'index', label: 'No', width: 20, align: 'center' },
  { key: 'name', label: 'Candidatos', width: 84, align: 'center' },
  { key: 'presence', label: 'Presenca\nnas aulas\n(80%)', width: 42, align: 'center' },
  { key: 'presenca_auxilios', label: 'Presenca e\ncomportamento\nnos auxilios', width: 50, align: 'center' },
  { key: 'comprometimento_eventos', label: 'Comprometimento\ne participacao\nem eventos', width: 58, align: 'center' },
  { key: 'genderCriterion', label: 'Deslocamento\n/ Floreio', width: 54, align: 'center' },
  { key: 'abraco_postura', label: 'Abraco e\nPostura', width: 44, align: 'center' },
  { key: 'equilibrio', label: 'Equilibrio', width: 40, align: 'center' },
  { key: 'passos', label: 'Passos', width: 38, align: 'center' },
  { key: 'ritmo', label: 'Ritmo', width: 36, align: 'center' },
  { key: 'corpo_ritmo', label: 'Corpo do\nRitmo', width: 44, align: 'center' },
  { key: 'conducao', label: 'Conducao', width: 44, align: 'center' },
  { key: 'musicalidade', label: 'Musicalidade', width: 50, align: 'center' },
  { key: 'final_note', label: 'NOTA\nFINAL', width: 44, align: 'center' },
  { key: 'approved', label: 'A', width: 24, align: 'center' },
  { key: 'reproved', label: 'R', width: 24, align: 'center' },
  { key: 'status', label: 'STATUS', width: 48, align: 'center' },
  { key: 'final_status', label: 'PATENTE', width: 42, align: 'center' },
];

function sanitize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x00-\x7F]/g, '');
}

function getDynamicTitle(results) {
  if (!results || results.length === 0) return 'RELATORIO DE AVALIACAO';

  const validCandidates = results.filter(result => (
    result.current_rank && RANK_HIERARCHY.includes(result.current_rank)
  ) || (
    result.final_status && RANK_HIERARCHY.includes(result.final_status)
  ));

  const firstValid = validCandidates[0];
  const baseRank = firstValid
    ? (firstValid.current_rank || firstValid.final_status)
    : 'Candidato';
  const currentIndex = RANK_HIERARCHY.indexOf(baseRank);
  const nextRank = currentIndex !== -1 && currentIndex < RANK_HIERARCHY.length - 1
    ? RANK_HIERARCHY[currentIndex + 1]
    : baseRank;

  return `AUDICAO DE ${pluralizeRank(baseRank).toUpperCase()} ${SEMESTER_LABELS.current} PARA ${pluralizeRank(nextRank).toUpperCase()} ${SEMESTER_LABELS.next}`;
}

function pluralizeRank(rank) {
  const plural = {
    Bolsista: 'Bolsistas',
    Auxiliar: 'Auxiliares',
    Assistente: 'Assistentes',
    Monitor: 'Monitores',
    Professor: 'Professores',
    Candidato: 'Candidatos',
  };
  return plural[rank] || `${rank}s`;
}

async function buildResultsPdf(report) {
  const { results = [], numEvaluators = 0 } = report || {};
  const pdfDoc = await PDFDocument.create();
  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
  };
  const logo = await embedLogo(pdfDoc);
  const titleText = getDynamicTitle(results);

  let page = pdfDoc.addPage(PAGE_SIZE);
  let y = drawReportHeader(page, fonts, logo, titleText, report);
  drawTableHeader(page, fonts, y, numEvaluators);
  y -= HEADER_HEIGHT;

  results.forEach((result, index) => {
    if (y < 98) {
      page = pdfDoc.addPage(PAGE_SIZE);
      y = drawReportHeader(page, fonts, logo, titleText, report, true);
      drawTableHeader(page, fonts, y, numEvaluators);
      y -= HEADER_HEIGHT;
    }

    drawResultRow(page, fonts, result, index, y);
    y -= ROW_HEIGHT;
  });

  drawRules(page, fonts, Math.max(30, y - 16), numEvaluators);

  return pdfDoc.save();
}

async function embedLogo(pdfDoc) {
  const candidates = [
    path.join(__dirname, '..', '..', 'static', 'images', 'fenix.png'),
    path.join(__dirname, '..', '..', 'static', 'images', 'fenix (1).png'),
  ];
  const logoPath = candidates.find(filePath => fs.existsSync(filePath));
  if (!logoPath) return null;

  try {
    return pdfDoc.embedPng(fs.readFileSync(logoPath));
  } catch {
    return null;
  }
}

function drawReportHeader(page, fonts, logo, titleText, report, continued = false) {
  const pageWidth = PAGE_SIZE[0];
  let y = PAGE_SIZE[1] - 34;

  if (logo) {
    const logoWidth = 92;
    const scaled = logo.scale(logoWidth / logo.width);
    page.drawImage(logo, {
      x: (pageWidth - scaled.width) / 2,
      y: y - scaled.height + 8,
      width: scaled.width,
      height: scaled.height,
    });
    y -= 36;
  } else {
    drawCenteredText(page, 'FENIX DANCA DE SALAO', pageWidth / 2, y, 14, fonts.bold);
    y -= 22;
  }

  const bandY = y - 18;
  page.drawRectangle({
    x: MARGIN_X,
    y: bandY,
    width: TABLE_WIDTH,
    height: 22,
    borderColor: COLORS.border,
    borderWidth: 1.3,
    color: COLORS.titleBand,
  });
  drawCenteredText(page, continued ? `${titleText} - CONTINUACAO` : titleText, pageWidth / 2, bandY + 6, 11, fonts.bold);

  const meta = buildMetaText(report);
  if (meta) {
    page.drawText(sanitize(meta), {
      x: MARGIN_X,
      y: bandY - 14,
      size: 7,
      font: fonts.italic,
      color: rgb(0.25, 0.25, 0.25),
    });
  }

  return bandY - 28;
}

function buildMetaText(report) {
  if (report?.event?.title) return report.event.title;
  if (report?.turma?.name) return `Turma: ${report.turma.name}`;
  return '';
}

function drawTableHeader(page, fonts, y, numEvaluators) {
  const topY = y;
  const groupY = topY - 20;
  const labelY = groupY - 38;

  drawCell(page, MARGIN_X, groupY, COLUMNS[0].width + COLUMNS[1].width, 20, 'JOAO ANTONIO', fonts.bold, 8, {
    fill: COLORS.rankGreen,
    align: 'center',
  });

  const pointsX = MARGIN_X + COLUMNS[0].width + COLUMNS[1].width;
  const pointsWidth = sumWidths(2, 14);
  drawCell(page, pointsX, groupY, pointsWidth, 20, 'PONTOS AVALIADOS DE 1 A 10', fonts.bold, 8.5, {
    fill: COLORS.groupBlue,
    color: COLORS.black,
    align: 'center',
  });

  const evaluatorX = pointsX + pointsWidth;
  const evaluatorWidth = TABLE_WIDTH - (evaluatorX - MARGIN_X);
  drawCell(page, evaluatorX, groupY, evaluatorWidth, 20, `AVALIADORES (${numEvaluators})`, fonts.bold, 8, {
    fill: COLORS.groupBlue,
    align: 'center',
  });

  let x = MARGIN_X;
  COLUMNS.forEach((column, index) => {
    const fill = index >= 13 ? COLORS.rankGreen : COLORS.headerCyan;
    drawCell(page, x, labelY, column.width, 38, column.label, fonts.regular, index === 1 ? 7.5 : 6.4, {
      fill,
      align: 'center',
      lineGap: 8,
    });
    x += column.width;
  });
}

function drawResultRow(page, fonts, result, index, y) {
  const values = getResultValues(result, index);
  const baseFill = index % 2 === 0 ? COLORS.rowCream : COLORS.rowBlue;
  let x = MARGIN_X;

  COLUMNS.forEach((column, columnIndex) => {
    const value = values[column.key] ?? '-';
    let fill = columnIndex >= 13 ? COLORS.passGreen : baseFill;
    let color = COLORS.black;
    let font = fonts.regular;

    if (column.key === 'final_note' && Number(result.final_note) < 7) {
      color = COLORS.red;
      font = fonts.bold;
    }
    if (column.key === 'status' && result.status !== 'Aprovado') {
      fill = COLORS.failPink;
      color = COLORS.red;
      font = fonts.bold;
    }
    if (column.key === 'name') {
      font = fonts.bold;
    }

    drawCell(page, x, y - ROW_HEIGHT, column.width, ROW_HEIGHT, value, font, column.key === 'name' ? 6.8 : 7, {
      fill,
      color,
      align: column.align,
      padding: 3,
      lineGap: 8,
    });
    x += column.width;
  });
}

function getResultValues(result, index) {
  const averages = result.averages || {};
  const genderCriterion = averages.deslocamento_cavalheiro ?? averages.floreio_dama ?? '-';

  return {
    index: String(index + 1),
    name: result.name || '-',
    presence: result.presence || '-',
    presenca_auxilios: valueOrDash(averages.presenca_auxilios),
    comprometimento_eventos: valueOrDash(averages.comprometimento_eventos),
    genderCriterion: valueOrDash(genderCriterion),
    abraco_postura: valueOrDash(averages.abraco_postura),
    equilibrio: valueOrDash(averages.equilibrio),
    passos: valueOrDash(averages.passos),
    ritmo: valueOrDash(averages.ritmo),
    corpo_ritmo: valueOrDash(averages.corpo_ritmo),
    conducao: valueOrDash(averages.conducao),
    musicalidade: valueOrDash(averages.musicalidade),
    final_note: valueOrDash(result.final_note),
    approved: String(result.approved ?? 0),
    reproved: String(result.reproved ?? 0),
    status: result.status || '-',
    final_status: result.final_status || result.current_rank || '-',
  };
}

function drawRules(page, fonts, y, numEvaluators) {
  const rules = [
    'Regras:',
    '1. O candidato que nao atingir a frequencia minima de 80% das aulas sera automaticamente REPROVADO.',
    '2. A chamada sera por ordem alfabetica.',
    '3. O parceiro sera escolhido atraves de SORTEIO.',
    '4. O professor podera solicitar ao avaliado movimentos, conducao ou repeticoes quando necessario.',
    '5. O professor que nao desejar avaliar determinado item podera marcar X no quadro referente ao item.',
    '6. Professores atribuem notas INTEIRAS entre 1 e 10 pontos.',
    `7. Sera APROVADO quem atingir 70% da media dos pontos totais E maioria simples dos professores (${Math.floor(numEvaluators / 2) + 1} de ${numEvaluators || 0}).`,
    '8. Pontos totais = 20 + 80 + 150 = 250. APROVADO = 175 pontos (70% de 250).',
  ];

  const boxHeight = 82;
  const boxY = Math.max(20, y - boxHeight);
  page.drawRectangle({
    x: MARGIN_X,
    y: boxY,
    width: TABLE_WIDTH,
    height: boxHeight,
    borderColor: COLORS.border,
    borderWidth: 1,
    color: COLORS.white,
  });

  let textY = boxY + boxHeight - 12;
  rules.forEach((rule, index) => {
    page.drawText(sanitize(rule), {
      x: MARGIN_X + 5,
      y: textY,
      size: index === 0 ? 8.5 : 6.4,
      font: index === 0 ? fonts.bold : fonts.regular,
      color: COLORS.black,
    });
    textY -= index === 0 ? 10 : 8;
  });
}

function drawCell(page, x, y, width, height, text, font, size, options = {}) {
  page.drawRectangle({
    x,
    y,
    width,
    height,
    borderColor: options.border || COLORS.border,
    borderWidth: options.borderWidth ?? 0.8,
    color: options.fill || COLORS.white,
  });

  const padding = options.padding ?? 2;
  const lines = wrapText(sanitize(text), font, size, width - (padding * 2), 3);
  const lineGap = options.lineGap ?? (size + 1);
  const totalTextHeight = (lines.length - 1) * lineGap;
  let textY = y + ((height + totalTextHeight) / 2) - size + 1;

  lines.forEach(line => {
    const lineWidth = font.widthOfTextAtSize(line, size);
    let textX = x + padding;
    if (options.align === 'center') {
      textX = x + ((width - lineWidth) / 2);
    } else if (options.align === 'right') {
      textX = x + width - padding - lineWidth;
    }

    page.drawText(line, {
      x: Math.max(x + padding, textX),
      y: textY,
      size,
      font,
      color: options.color || COLORS.black,
    });
    textY -= lineGap;
  });
}

function drawCenteredText(page, text, centerX, y, size, font) {
  const safe = sanitize(text);
  page.drawText(safe, {
    x: centerX - (font.widthOfTextAtSize(safe, size) / 2),
    y,
    size,
    font,
    color: COLORS.black,
  });
}

function wrapText(text, font, size, maxWidth, maxLines = 2) {
  const explicitLines = String(text).split('\n');
  const lines = [];

  explicitLines.forEach(part => {
    const words = part.split(/\s+/).filter(Boolean);
    let current = '';

    words.forEach(word => {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        return;
      }
      if (current) lines.push(current);
      current = truncateText(word, font, size, maxWidth);
    });

    if (current || words.length === 0) lines.push(current);
  });

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = truncateText(`${kept[maxLines - 1]}...`, font, size, maxWidth);
  return kept;
}

function truncateText(text, font, size, maxWidth) {
  let output = String(text);
  while (output.length > 1 && font.widthOfTextAtSize(output, size) > maxWidth) {
    output = output.slice(0, -1);
  }
  return output;
}

function valueOrDash(value) {
  if (value === undefined || value === null || value === '') return '-';
  return String(value);
}

function sumWidths(startIndex, endIndexExclusive) {
  return COLUMNS
    .slice(startIndex, endIndexExclusive)
    .reduce((sum, column) => sum + column.width, 0);
}

module.exports = {
  buildResultsPdf,
  _private: {
    getDynamicTitle,
    RANK_HIERARCHY,
  },
};

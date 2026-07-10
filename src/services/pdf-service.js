const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const RANK_HIERARCHY = ['Bolsista', 'Auxiliar', 'Assistente', 'Monitor', 'Professor'];
const PAGE_SIZE = [842, 595];
const MARGIN_X = 28;
const TABLE_WIDTH = PAGE_SIZE[0] - (MARGIN_X * 2);
const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 58;
const BRAND_TOP = 578;

const COLORS = {
  black: rgb(0.12, 0.04, 0.05),
  white: rgb(1, 1, 1),
  border: rgb(0.24, 0.12, 0.12),
  softBorder: rgb(0.75, 0.62, 0.48),
  titleBand: rgb(0.96, 0.89, 0.78),
  groupBlue: rgb(0.72, 0.58, 0.40),
  headerCyan: rgb(0.98, 0.93, 0.84),
  rankGreen: rgb(0.90, 0.78, 0.58),
  rowCream: rgb(0.99, 0.95, 0.87),
  rowBlue: rgb(0.96, 0.86, 0.76),
  passGreen: rgb(0.94, 0.82, 0.60),
  failPink: rgb(0.99, 0.88, 0.84),
  red: rgb(0.72, 0.03, 0.06),
  textGreen: rgb(0.1, 0.55, 0.1),
  brandRed: rgb(0.72, 0.03, 0.06),
  brandGold: rgb(0.74, 0.58, 0.37),
  pageCream: rgb(1, 0.97, 0.90),
};

const COLUMNS = [
  { key: 'index', label: 'Nº', width: 20, align: 'center' },
  { key: 'name', label: 'Candidatos', width: 84, align: 'center' },
  { key: 'presence', label: 'Presença\nnas aulas\n(80%)', width: 42, align: 'center' },
  { key: 'presenca_auxilios', label: 'Presença e\ncomportamento\nnos auxílios', width: 50, align: 'center' },
  { key: 'comprometimento_eventos', label: 'Comprometimento\ne participação\nem eventos', width: 58, align: 'center' },
  { key: 'genderCriterion', label: 'Deslocamento\n/ Floreio', width: 54, align: 'center' },
  { key: 'abraco_postura', label: 'Abraço e\nPostura', width: 44, align: 'center' },
  { key: 'equilibrio', label: 'Equilíbrio', width: 40, align: 'center' },
  { key: 'passos', label: 'Passos', width: 38, align: 'center' },
  { key: 'ritmo', label: 'Ritmo', width: 36, align: 'center' },
  { key: 'corpo_ritmo', label: 'Corpo do\nRitmo', width: 44, align: 'center' },
  { key: 'conducao', label: 'Condução', width: 44, align: 'center' },
  { key: 'musicalidade', label: 'Musicalidade', width: 50, align: 'center' },
  { key: 'final_note', label: 'NOTA\nFINAL', width: 44, align: 'center' },
  { key: 'approved', label: 'A', width: 24, align: 'center' },
  { key: 'reproved', label: 'R', width: 24, align: 'center' },
  { key: 'status', label: 'STATUS', width: 48, align: 'center' },
  { key: 'final_status', label: 'PATENTE', width: 42, align: 'center' },
];

function sanitize(text) {
  return String(text ?? '')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim();
}

function getDynamicTitle(report) {
  const normalizedReport = Array.isArray(report) ? { results: report } : (report || {});
  const turmaName = getReportTurmaName(normalizedReport);

  if (!turmaName) return 'Avaliação Geral - Resultado Consolidado';

  const results = Array.isArray(normalizedReport.results) ? normalizedReport.results : [];
  const baseRank = getPredominantRank(results) || 'Candidato';
  const nextRank = getNextRank(baseRank);

  // Extrai ano_semestre do nome da turma (ex: "Ivan Bonatti 2025_1" → "2025_1")
  const periodMatch = turmaName.match(/(\d{4}_\d)/);
  if (!periodMatch) {
    // Fallback se não encontrar o padrão ano_semestre
    return `Audição ${pluralizeRank(baseRank)} para ${pluralizeRank(nextRank)}`;
  }

  const currentPeriod = periodMatch[1]; // ex: "2025_1"
  const [yearStr, semester] = currentPeriod.split('_');
  const nextPeriod = `${Number(yearStr) + 1}_${semester}`; // ex: "2026_1"

  return `Audição ${pluralizeRank(baseRank)} ${currentPeriod} para ${pluralizeRank(nextRank)} ${nextPeriod}`;
}

function getReportTurmaName(report) {
  const turmaName = report?.turma?.name || report?.event?.turma_name || '';
  return String(turmaName).trim();
}

function getPredominantRank(results) {
  const counts = new Map();
  let bestRank = null;
  let bestCount = 0;

  results.forEach(result => {
    const rank = getRankForResult(result);
    if (!rank) return;

    const count = (counts.get(rank) || 0) + 1;
    counts.set(rank, count);

    if (count > bestCount) {
      bestRank = rank;
      bestCount = count;
    }
  });

  return bestRank;
}

function getRankForResult(result) {
  if (result?.current_rank && RANK_HIERARCHY.includes(result.current_rank)) {
    return result.current_rank;
  }
  if (result?.final_status && RANK_HIERARCHY.includes(result.final_status)) {
    return result.final_status;
  }
  return null;
}

function getNextRank(rank) {
  const currentIndex = RANK_HIERARCHY.indexOf(rank);
  if (currentIndex === -1 || currentIndex >= RANK_HIERARCHY.length - 1) return rank;
  return RANK_HIERARCHY[currentIndex + 1];
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
    brand: await pdfDoc.embedFont(StandardFonts.TimesRomanItalic),
    brandRegular: await pdfDoc.embedFont(StandardFonts.TimesRoman),
  };
  const titleText = getDynamicTitle(report);

  let page = pdfDoc.addPage(PAGE_SIZE);
  let y = drawReportHeader(page, fonts, titleText, report);
  let headerTopY = y;
  drawTableHeader(page, fonts, y, numEvaluators, report);
  y -= HEADER_HEIGHT;

  let pageData = [];
  let currentTopY = headerTopY - 20; // Starts right below the top header text
  let currentBottomY = y;

  results.forEach((result, index) => {
    if (y < 98) {
      pageData.push({ page, topY: currentTopY, bottomY: currentBottomY });
      
      page = pdfDoc.addPage(PAGE_SIZE);
      y = drawReportHeader(page, fonts, titleText, report, true);
      headerTopY = y;
      drawTableHeader(page, fonts, y, numEvaluators, report);
      
      currentTopY = headerTopY - 20;
      y -= HEADER_HEIGHT;
      currentBottomY = y;
    }

    drawResultRow(page, fonts, result, index, y);
    y -= ROW_HEIGHT;
    currentBottomY = y;
  });

  pageData.push({ page, topY: currentTopY, bottomY: currentBottomY });

  // Draw separators for all pages
  pageData.forEach(({ page, topY, bottomY }) => {
    drawWeightSeparators(page, topY, bottomY);
  });

  drawRules(page, fonts, Math.max(30, y - 16), numEvaluators);

  return pdfDoc.save();
}

function drawWeightSeparators(page, topY, bottomY) {
  // Column indices after which we draw the thick separator
  // 2: fim da Presença %
  // 4: fim do Peso 1 (Comprometimento)
  // 7: fim do Peso 2 (Equilíbrio)
  // 12: fim do Peso 3 (Musicalidade)
  const separatorIndices = [2, 4, 7, 12];
  let x = MARGIN_X;
  
  COLUMNS.forEach((column, index) => {
    x += column.width;
    if (separatorIndices.includes(index)) {
      page.drawLine({
        start: { x: x, y: topY },
        end: { x: x, y: bottomY },
        thickness: 1.5,
        color: COLORS.black
      });
    }
  });
}

function drawReportHeader(page, fonts, titleText, report, continued = false) {
  const pageWidth = PAGE_SIZE[0];
  page.drawRectangle({
    x: 0,
    y: 0,
    width: PAGE_SIZE[0],
    height: PAGE_SIZE[1],
    color: COLORS.pageCream,
  });

  drawBrandMark(page, fonts, pageWidth / 2, BRAND_TOP);

  const bandY = BRAND_TOP - 58;
  page.drawRectangle({
    x: MARGIN_X,
    y: bandY,
    width: TABLE_WIDTH,
    height: 22,
    borderColor: COLORS.border,
    borderWidth: 1.3,
    color: COLORS.titleBand,
  });
  drawCenteredText(page, continued ? `${titleText} - CONTINUAÇÃO` : titleText, pageWidth / 2, bandY + 6, 11, fonts.bold);

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

function drawBrandMark(page, fonts, centerX, y) {
  const brand = 'fênix';
  const brandSize = 26;
  const brandWidth = fonts.brand.widthOfTextAtSize(brand, brandSize);
  page.drawText(brand, {
    x: centerX - (brandWidth / 2),
    y: y - brandSize,
    size: brandSize,
    font: fonts.brand,
    color: COLORS.brandRed,
  });

  const subtitle = 'Dança de Salão';
  const subtitleSize = 6.8;
  const subtitleWidth = fonts.brandRegular.widthOfTextAtSize(subtitle, subtitleSize);
  page.drawText(subtitle, {
    x: centerX - (subtitleWidth / 2),
    y: y - brandSize - 8,
    size: subtitleSize,
    font: fonts.brandRegular,
    color: COLORS.black,
  });

  page.drawLine({
    start: { x: centerX - 58, y: y - brandSize - 13 },
    end: { x: centerX + 58, y: y - brandSize - 13 },
    thickness: 0.6,
    color: COLORS.brandGold,
  });
}

function buildMetaText(report) {
  let text = '';
  if (report?.event?.title) text = report.event.title;
  else if (report?.turma?.name) text = `Turma: ${report.turma.name}`;

  if (report?.turma?.ritmos_avaliados) {
    if (text) text += ` - Ritmos: ${report.turma.ritmos_avaliados}`;
    else text = `Ritmos: ${report.turma.ritmos_avaliados}`;
  }
  return text;
}

function drawTableHeader(page, fonts, y, numEvaluators, report) {
  const topY = y;
  const groupY = topY - 20;
  const labelY = groupY - 38;

  const teacherName = report?.turma?.teacher_name?.toUpperCase() || 'CANDIDATOS';

  drawCell(page, MARGIN_X, groupY, COLUMNS[0].width + COLUMNS[1].width, 20, teacherName, fonts.bold, 8, {
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
    if (column.key === 'status') {
      if (result.status === 'Aprovado') {
        color = COLORS.textGreen;
        font = fonts.bold;
      } else if (result.status !== 'Aprovado' && result.status !== '-') {
        fill = COLORS.failPink;
        color = COLORS.red;
        font = fonts.bold;
      }
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
    '1. O candidato que não atingir a frequência mínima de 80% das aulas será automaticamente REPROVADO.',
    '2. A chamada será por ordem alfabética.',
    '3. O parceiro será escolhido por SORTEIO.',
    '4. O professor poderá solicitar movimentos, condução ou repetições quando necessário.',
    '5. O professor que não desejar avaliar determinado item poderá marcar X no quadro referente ao item.',
    '6. Professores atribuem notas INTEIRAS entre 1 e 10 pontos.',
    `7. Será APROVADO quem atingir 70% da média dos pontos totais E maioria simples dos professores (${Math.floor(numEvaluators / 2) + 1} de ${numEvaluators || 0}).`,
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

function asciiFilename(value, fallback = 'arquivo') {
  const normalized = String(value || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);

  return normalized || fallback;
}

function buildAttachmentDisposition(filename) {
  const safeAscii = asciiFilename(filename, 'download.pdf');
  const utf8Name = encodeURIComponent(filename).replace(/[()]/g, escape);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${utf8Name}`;
}

function sumWidths(startIndex, endIndexExclusive) {
  return COLUMNS
    .slice(startIndex, endIndexExclusive)
    .reduce((sum, column) => sum + column.width, 0);
}

module.exports = {
  buildResultsPdf,
  buildAttachmentDisposition,
  asciiFilename,
  getDynamicTitle,
  _private: {
    getDynamicTitle,
    sanitize,
    buildAttachmentDisposition,
    asciiFilename,
    COLUMNS,
    RANK_HIERARCHY,
  },
};

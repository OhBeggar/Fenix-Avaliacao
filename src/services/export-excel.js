const ExcelJS = require('exceljs');

function safeSheetName(name) {
  const cleaned = String(name || 'Avaliador')
    .replace(/[\\\/\?\*\[\]:]/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned || 'Avaliador';
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF0F766E' },
  };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 28;
}

function paintFinalNote(cell, value) {
  const note = Number(value);
  if (Number.isNaN(note)) return;
  if (note >= 7) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
    cell.font = { bold: true, color: { argb: 'FF047857' } };
  } else {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
    cell.font = { bold: true, color: { argb: 'FFB91C1C' } };
  }
}

function getDesloc(avg) {
  if (!avg) return '—';
  if (avg.deslocamento_cavalheiro != null && avg.deslocamento_cavalheiro !== '—' && avg.deslocamento_cavalheiro !== '-') {
    return avg.deslocamento_cavalheiro;
  }
  if (avg.floreio_dama != null && avg.floreio_dama !== '—' && avg.floreio_dama !== '-') {
    return avg.floreio_dama;
  }
  return '—';
}

function addConsolidationSheet(workbook, report) {
  const sheet = workbook.addWorksheet('Consolidação', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = [
    { header: 'Nº', key: 'n', width: 6 },
    { header: 'Candidato', key: 'name', width: 28 },
    { header: 'Presença', key: 'presence', width: 12 },
    { header: 'Pres. Auxílios', key: 'presenca_auxilios', width: 14 },
    { header: 'Comprometimento', key: 'comprometimento_eventos', width: 16 },
    { header: 'Desloc./Floreio', key: 'desloc', width: 14 },
    { header: 'Abraço', key: 'abraco_postura', width: 10 },
    { header: 'Equilíbrio', key: 'equilibrio', width: 11 },
    { header: 'Passos', key: 'passos', width: 10 },
    { header: 'Ritmo', key: 'ritmo', width: 10 },
    { header: 'C. Ritmo', key: 'corpo_ritmo', width: 10 },
    { header: 'Condução', key: 'conducao', width: 11 },
    { header: 'Musicalidade', key: 'musicalidade', width: 13 },
    { header: 'Nota Final', key: 'final_note', width: 12 },
    { header: 'Aprov.', key: 'approved', width: 9 },
    { header: 'Reprov.', key: 'reproved', width: 9 },
    { header: 'Status', key: 'status', width: 22 },
    { header: 'Patente', key: 'final_status', width: 14 },
  ];

  styleHeader(sheet.getRow(1));

  (report.results || []).forEach((r, i) => {
    const avg = r.averages || {};
    const row = sheet.addRow({
      n: i + 1,
      name: r.name,
      presence: r.presence,
      presenca_auxilios: avg.presenca_auxilios ?? '—',
      comprometimento_eventos: avg.comprometimento_eventos ?? '—',
      desloc: getDesloc(avg),
      abraco_postura: avg.abraco_postura ?? '—',
      equilibrio: avg.equilibrio ?? '—',
      passos: avg.passos ?? '—',
      ritmo: avg.ritmo ?? '—',
      corpo_ritmo: avg.corpo_ritmo ?? '—',
      conducao: avg.conducao ?? '—',
      musicalidade: avg.musicalidade ?? '—',
      final_note: r.final_note,
      approved: r.approved,
      reproved: r.reproved,
      status: r.status,
      final_status: r.final_status,
    });

    row.alignment = { vertical: 'middle', horizontal: 'center' };
    row.getCell('name').alignment = { horizontal: 'left' };
    paintFinalNote(row.getCell('final_note'), r.final_note);
  });

  return sheet;
}

function collectEvaluators(results) {
  const map = new Map();
  (results || []).forEach((r) => {
    const ind = r.individual_evaluations || {};
    Object.entries(ind).forEach(([id, data]) => {
      if (!map.has(id)) {
        map.set(id, data.name || `Avaliador ${id}`);
      }
    });
  });
  return map; // id -> name
}

function addEvaluatorSheet(workbook, report, evaluatorId, evaluatorName) {
  const sheet = workbook.addWorksheet(safeSheetName(evaluatorName), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = [
    { header: 'Nº', key: 'n', width: 6 },
    { header: 'Candidato', key: 'name', width: 28 },
    { header: 'Presença', key: 'presence', width: 12 },
    { header: 'Pres. Auxílios', key: 'presenca_auxilios', width: 14 },
    { header: 'Comprometimento', key: 'comprometimento_eventos', width: 16 },
    { header: 'Desloc./Floreio', key: 'desloc', width: 14 },
    { header: 'Abraço', key: 'abraco_postura', width: 10 },
    { header: 'Equilíbrio', key: 'equilibrio', width: 11 },
    { header: 'Passos', key: 'passos', width: 10 },
    { header: 'Ritmo', key: 'ritmo', width: 10 },
    { header: 'C. Ritmo', key: 'corpo_ritmo', width: 10 },
    { header: 'Condução', key: 'conducao', width: 11 },
    { header: 'Musicalidade', key: 'musicalidade', width: 13 },
    { header: 'Nota Final', key: 'final_note', width: 12 },
    { header: 'Decisão', key: 'decision', width: 12 },
  ];

  styleHeader(sheet.getRow(1));

  (report.results || []).forEach((r, i) => {
    const ind = (r.individual_evaluations || {})[evaluatorId];
    const scores = (ind && ind.scores) || {};
    const finalNote = ind ? ind.finalNote : '—';
    const decision = ind
      ? (ind.isApproved ? 'Aprovado' : 'Reprovado')
      : '—';

    const row = sheet.addRow({
      n: i + 1,
      name: r.name,
      presence: r.presence,
      presenca_auxilios: scores.presenca_auxilios ?? '—',
      comprometimento_eventos: scores.comprometimento_eventos ?? '—',
      desloc: scores.deslocamento_cavalheiro ?? scores.floreio_dama ?? '—',
      abraco_postura: scores.abraco_postura ?? '—',
      equilibrio: scores.equilibrio ?? '—',
      passos: scores.passos ?? '—',
      ritmo: scores.ritmo ?? '—',
      corpo_ritmo: scores.corpo_ritmo ?? '—',
      conducao: scores.conducao ?? '—',
      musicalidade: scores.musicalidade ?? '—',
      final_note: finalNote,
      decision,
    });

    row.alignment = { vertical: 'middle', horizontal: 'center' };
    row.getCell('name').alignment = { horizontal: 'left' };
    paintFinalNote(row.getCell('final_note'), finalNote);
  });

  return sheet;
}

async function buildResultsExcel(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fênix Avaliação';
  workbook.created = new Date();

  addConsolidationSheet(workbook, report);

  const evaluators = collectEvaluators(report.results);
  for (const [id, name] of evaluators) {
    addEvaluatorSheet(workbook, report, id, name);
  }

  // Aba resumo (metadados)
  const meta = workbook.addWorksheet('Info');
  meta.getCell('A1').value = 'Sistema de Avaliação Fênix';
  meta.getCell('A2').value = report.dynamicTitle || report.event?.title || 'Resultados';
  meta.getCell('A3').value = `Gerado em ${new Date().toLocaleString('pt-BR')}`;
  meta.getCell('A4').value = `Avaliadores: ${evaluators.size}`;
  meta.getCell('A5').value = `Candidatos: ${(report.results || []).length}`;
  meta.columns = [{ width: 50 }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

module.exports = { buildResultsExcel };

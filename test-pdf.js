const fs = require('fs');
const path = require('path');
const service = require('./src/services/evaluation-service');
const { buildResultsPdf } = require('./src/services/pdf-service');

async function run() {
  console.log('Iniciando teste de PDF...');
  service.initDb();

  // 1. Criar professor
  service.addTeacher('Prof PDF Teste', '123');
  const teacher = service.getTeacherByName('Prof PDF Teste');
  
  // 2. Criar turma com ritmos
  service.createTurma('Ivan Bonatti 2025_1', teacher.id, '', 'Forró,Samba');
  const turma = service.getTurmas().find(t => t.name === 'Ivan Bonatti 2025_1');
  console.log('Turma criada:', turma.id);

  // 3. Adicionar alunos
  service.createCandidate({ name: 'João Teste', number: 1, role: 'Cavalheiro' });
  service.createCandidate({ name: 'Maria Teste', number: 2, role: 'Dama' });
  const candId1 = service.getCandidates().find(c => c.name === 'João Teste').id;
  const candId2 = service.getCandidates().find(c => c.name === 'Maria Teste').id;
  service.assignCandidateToTurma(candId1, turma.id);
  service.assignCandidateToTurma(candId2, turma.id);
  
  // 4. Abrir sessão
  service.generateSessionCode(turma.id);
  
  // 5. Criar avaliador e registrar notas
  // O formato das chaves é: `${candidateId}_${criterion}`
  const evaluator = service.getOrCreateEvaluator('Prof PDF Teste');

  const formBody = {
    // João (Cavalheiro) - critérios comuns + deslocamento_cavalheiro
    [`${candId1}_presenca_auxilios`]: '10',
    [`${candId1}_comprometimento_eventos`]: '10',
    [`${candId1}_abraco_postura`]: '10',
    [`${candId1}_equilibrio`]: '10',
    [`${candId1}_passos`]: '10',
    [`${candId1}_ritmo`]: '10',
    [`${candId1}_corpo_ritmo`]: '10',
    [`${candId1}_conducao`]: '10',
    [`${candId1}_musicalidade`]: '10',
    [`${candId1}_deslocamento_cavalheiro`]: '10',

    // Maria (Dama) - critérios comuns + floreio_dama
    [`${candId2}_presenca_auxilios`]: '9',
    [`${candId2}_comprometimento_eventos`]: '9',
    [`${candId2}_abraco_postura`]: '9',
    [`${candId2}_equilibrio`]: '8',
    [`${candId2}_passos`]: '8',
    [`${candId2}_ritmo`]: '9',
    [`${candId2}_corpo_ritmo`]: '8',
    [`${candId2}_conducao`]: '8',
    [`${candId2}_musicalidade`]: '9',
    [`${candId2}_floreio_dama`]: '9',
  };

  service.saveScores(evaluator.id, formBody, turma.id);
  console.log('Notas salvas para', evaluator.name);

  // 6. Verificar avaliadores ativos
  const activeStatus = service.getActiveEvaluatorStatus(turma.id);
  console.log('Avaliadores ativos:', activeStatus.activeCount);

  // 7. Fechar o semestre (isso gera o histórico)
  const result = service.closeSemesterForTurmas([turma.id], 'admin');
  console.log('Fechamento:', JSON.stringify(result));

  // 8. Verificar histórico
  const history = service.getEvaluationHistory();
  console.log('Eventos no histórico:', history.length);

  if (!history.length) {
    console.error('ERRO: Nenhum evento gerado no histórico!');
    process.exit(1);
  }

  const event = history[0];
  console.log('Evento:', event.id, event.title);

  // 9. Gerar relatório e PDF
  const report = service.getEvaluationHistoryReport(event.id);
  const pdfBytes = await buildResultsPdf(report);
  
  const outPath = path.join(__dirname, 'test-output7.pdf');
  fs.writeFileSync(outPath, Buffer.from(pdfBytes));
  console.log('\n✅ PDF gerado com sucesso em:', outPath);
  console.log('Abra o arquivo para verificar o layout!');
}

run().catch(err => {
  console.error('\n❌ Erro:', err.message);
  console.error(err.stack);
});

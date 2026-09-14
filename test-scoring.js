// Teste da nova fórmula de cálculo
const {
  calculateFinalNote,
  determineResultStatus,
  isPresenceEligible,
  roundOneDecimal,
} = require('./src/services/scoring-rules');

function assertClose(actual, expected, label, eps = 0.05) {
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`${label}: obtido ${actual}, esperado ${expected}`);
  }
}

// Caso 1: Notas perfeitas
const perfect = {
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
const notePerfect = calculateFinalNote(perfect, 'deslocamento_cavalheiro', 100);
assertClose(notePerfect, 10, 'todas 10');
console.log(`Caso 1 - Notas perfeitas (esperado 10): ${notePerfect}`);
console.log(`  Peso1: média(10, 10) * 0.1 = ${roundOneDecimal(10 * 0.1)}`);
console.log(`  Peso2: média(10, 10, 10) * 0.3 = ${roundOneDecimal(10 * 0.3)}`);
console.log(`  Peso3: média(10, 10, 10, 10, 10) * 0.6 = ${roundOneDecimal(10 * 0.6)}`);

// Caso 2: Exemplo realista
const example = {
  presenca_auxilios: 8,
  comprometimento_eventos: 7,
  deslocamento_cavalheiro: 6,
  abraco_postura: 8,
  equilibrio: 7,
  passos: 6,
  ritmo: 5,
  corpo_ritmo: 7,
  conducao: 6,
  musicalidade: 8,
};
const noteExample = calculateFinalNote(example, 'deslocamento_cavalheiro', 95.08);
console.log(`\nCaso 2 - Notas realistas (presença 95.08%):`);
const mp1 = (8 + 7) / 2;
const mp2 = (6 + 8 + 7) / 3;
const mp3 = (6 + 5 + 7 + 6 + 8) / 5;
const expected = roundOneDecimal(mp1 * 0.1 + mp2 * 0.3 + mp3 * 0.6);
console.log(`  Peso1 média: ${roundOneDecimal(mp1)} => * 0.1 = ${roundOneDecimal(mp1 * 0.1)}`);
console.log(`  Peso2 média: ${roundOneDecimal(mp2)} => * 0.3 = ${roundOneDecimal(mp2 * 0.3)}`);
console.log(`  Peso3 média: ${roundOneDecimal(mp3)} => * 0.6 = ${roundOneDecimal(mp3 * 0.6)}`);
console.log(`  Nota Final calculada: ${noteExample} (esperado: ${expected})`);

// Caso 3: Notas todas 7 com presença 80% (presença não altera a nota)
const borderline = {
  presenca_auxilios: 7,
  comprometimento_eventos: 7,
  deslocamento_cavalheiro: 7,
  abraco_postura: 7,
  equilibrio: 7,
  passos: 7,
  ritmo: 7,
  corpo_ritmo: 7,
  conducao: 7,
  musicalidade: 7,
};
const noteBorder = calculateFinalNote(borderline, 'deslocamento_cavalheiro', 80);
assertClose(noteBorder, 7, 'todas 7 + 80% presença');
console.log(`\nCaso 3 - Todas notas 7, presença 80% (esperado 7): ${noteBorder}`);
const mp1b = 7;
console.log(`  Peso1 média: ${mp1b} => * 0.1 = ${roundOneDecimal(mp1b * 0.1)}`);
console.log(`  Peso2 média: 7 => * 0.3 = ${roundOneDecimal(7 * 0.3)}`);
console.log(`  Peso3 média: 7 => * 0.6 = ${roundOneDecimal(7 * 0.6)}`);

const noteAtFullPresence = calculateFinalNote(borderline, 'deslocamento_cavalheiro', 100);
assertClose(noteAtFullPresence, noteBorder, 'presença % não altera nota');

const samiraLike = {
  presenca_auxilios: 0,
  comprometimento_eventos: 9,
  deslocamento_cavalheiro: 7,
  abraco_postura: 7,
  equilibrio: 6,
  passos: 7,
  ritmo: 7,
  corpo_ritmo: 7,
  conducao: 8.1,
  musicalidade: 7,
};
assertClose(calculateFinalNote(samiraLike, 'deslocamento_cavalheiro', 85.2), 6.8, 'samira-like aux 0');

const dama = { ...perfect, floreio_dama: 10 };
delete dama.deslocamento_cavalheiro;
assertClose(calculateFinalNote(dama, 'floreio_dama', 100), 10, 'dama com floreio 10');

const statusOk = determineResultStatus(7.0, 7, 12);
const statusNo = determineResultStatus(6.9, 7, 12);
if (statusOk !== 'Aprovado' || statusNo !== 'Reprovado') {
  throw new Error(`status de aprovação inválido: ${statusOk} / ${statusNo}`);
}
if (!isPresenceEligible(80) || isPresenceEligible(79)) {
  throw new Error('regra de presença inválida');
}

console.log('\n✅ Todos os testes concluídos!');

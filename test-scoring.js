// Teste da nova fórmula de cálculo
const { calculateFinalNote, roundOneDecimal } = require('./src/services/scoring-rules');

// Caso 1: Notas perfeitas (10 em tudo, 100% presença)
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
console.log(`Caso 1 - Notas perfeitas (esperado 10): ${notePerfect}`);
console.log(`  Peso1: ((100/10) + 10) / 2 * 0.1 = ${roundOneDecimal(((100/10) + 10) / 2 * 0.1)}`);
console.log(`  Peso2: (10 + 10 + 10) / 3 * 0.3 = ${roundOneDecimal((10 + 10 + 10) / 3 * 0.3)}`);
console.log(`  Peso3: (10 + 10 + 10 + 10 + 10 + 10) / 6 * 0.6 = ${roundOneDecimal((10+10+10+10+10+10) / 6 * 0.6)}`);

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
const mp1 = ((95.08/10) + 8) / 2;
const mp2 = (7 + 6 + 8) / 3;
const mp3 = (7 + 6 + 5 + 7 + 6 + 8) / 6;
const expected = roundOneDecimal(mp1 * 0.1 + mp2 * 0.3 + mp3 * 0.6);
console.log(`  Peso1 média: ${roundOneDecimal(mp1)} => * 0.1 = ${roundOneDecimal(mp1 * 0.1)}`);
console.log(`  Peso2 média: ${roundOneDecimal(mp2)} => * 0.3 = ${roundOneDecimal(mp2 * 0.3)}`);
console.log(`  Peso3 média: ${roundOneDecimal(mp3)} => * 0.6 = ${roundOneDecimal(mp3 * 0.6)}`);
console.log(`  Nota Final calculada: ${noteExample} (esperado: ${expected})`);

// Caso 3: Notas todas 7 com presença 80%
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
console.log(`\nCaso 3 - Todas notas 7, presença 80% (esperado ~7): ${noteBorder}`);
const mp1b = ((80/10) + 7) / 2;
console.log(`  Peso1 média: ${roundOneDecimal(mp1b)} => * 0.1 = ${roundOneDecimal(mp1b * 0.1)}`);
console.log(`  Peso2 média: 7 => * 0.3 = ${roundOneDecimal(7 * 0.3)}`);
console.log(`  Peso3 média: 7 => * 0.6 = ${roundOneDecimal(7 * 0.6)}`);

console.log('\n✅ Todos os testes concluídos!');

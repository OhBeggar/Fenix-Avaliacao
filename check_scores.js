const { calculateFinalNote, calculateTotalPoints } = require('./src/services/scoring-rules');

const lucasScores = {
  presenca_auxilios: 10,
  comprometimento_eventos: 8,
  deslocamento_cavalheiro: 7,
  abraco_postura: 6,
  equilibrio: 7,
  passos: 7,
  ritmo: 6,
  corpo_ritmo: 6,
  conducao: 8,
  musicalidade: 7
};

const beatrizScores = {
  presenca_auxilios: 10,
  comprometimento_eventos: 8,
  deslocamento_cavalheiro: 6,
  abraco_postura: 7,
  equilibrio: 8,
  passos: 7,
  ritmo: 7,
  corpo_ritmo: 6,
  conducao: 8,
  musicalidade: 7
};

console.log("Lucas:");
const tLucas = calculateTotalPoints(lucasScores, 'deslocamento_cavalheiro');
console.log("Total:", tLucas);
console.log("Final Note:", calculateFinalNote(lucasScores, 'deslocamento_cavalheiro'));

console.log("\nBeatriz:");
const tBeatriz = calculateTotalPoints(beatrizScores, 'deslocamento_cavalheiro');
console.log("Total:", tBeatriz);
console.log("Final Note:", calculateFinalNote(beatrizScores, 'deslocamento_cavalheiro'));

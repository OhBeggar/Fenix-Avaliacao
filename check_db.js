const evaluationService = require('./src/services/evaluation-service');
evaluationService.initDb();
console.log(evaluationService.getActiveSessions());

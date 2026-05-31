const http = require('http');
const config = require('./src/config');
const { signAccessPayload } = require('./src/utils/admin-auth'); // wait, auth might be different. Let me just use evaluationService directly.

const evaluationService = require('./src/services/evaluation-service');
evaluationService.initDb();
const activeSessions = evaluationService.getActiveSessions();
const latestSession = activeSessions[0] || null;

console.log("Session:", latestSession);

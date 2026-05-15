const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.EVALUATIONS_DB_PATH || path.join(__dirname, '..', '..', 'evaluations.db');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');

function runInTransaction(callback) {
    db.exec('BEGIN');

    try {
        const result = callback();
        db.exec('COMMIT');
        return result;
    } catch (error) {
        try {
            db.exec('ROLLBACK');
        } catch {}

        throw error;
    }
}

module.exports = {
    db,
    runInTransaction,
};

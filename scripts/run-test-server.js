// Runs the app on port 3100 against a throw-away embedded database seeded from data/seed.json,
// so testing never touches Supabase or the local data.
const path = require('path');
const os = require('os');
const fs = require('fs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yard-test-'));
process.env.PORT = process.env.PORT || '3100';
process.env.IGNORE_ENV_FILE = '1';
delete process.env.DATABASE_URL;
process.env.LOCAL_DB_DIR = path.join(dir, 'pg');
process.env.IMPORT_FROM = 'seed';
console.log('Test database:', process.env.LOCAL_DB_DIR);
import('../src/local-server.mjs').catch(e => { console.error(e); process.exit(1); });

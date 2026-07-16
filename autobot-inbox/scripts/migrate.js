import 'dotenv/config';
import { initializeDatabase, close } from '../src/db.js';

/**
 * Run SQL migrations against PGlite.
 * Creates database directory + runs all sql/*.sql files on first launch.
 * Idempotent — safe to run repeatedly.
 */
async function migrate() {
  try {
    const isNew = await initializeDatabase();
    if (isNew) {
      console.log('Database initialized successfully');
    } else {
      console.log('Database already initialized (schemas exist)');
    }
  } finally {
    await close();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

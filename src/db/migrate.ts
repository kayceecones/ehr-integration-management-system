/** Applies schema.sql. Idempotent; safe to run repeatedly. */
import { migrate, db } from './client.ts';

migrate()
  .then(async () => {
    console.log('Schema applied.');
    await db().end();
    process.exit(0);
  })
  .catch((err) => { console.error(err); process.exit(1); });

import bcrypt from 'bcryptjs';
import { pathToFileURL } from 'node:url';
import { closeDatabase, pool } from '../config/database.js';

async function setAdminPassword() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!process.env.DATABASE_URL || !password) {
    throw new Error('DATABASE_URL and ADMIN_PASSWORD are required');
  }

  const result = await pool.query(
    `UPDATE users SET password_hash = $1
     WHERE username = $2 AND role = 'admin' RETURNING id`,
    [bcrypt.hashSync(password, 10), username],
  );
  if (!result.rowCount) {
    throw new Error(`No admin account exists with username "${username}"`);
  }
  console.log(`[admin] Password updated for admin account "${username}"`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await setAdminPassword();
  } catch (error) {
    console.error('[admin] Password update failed:', error);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

export { setAdminPassword };

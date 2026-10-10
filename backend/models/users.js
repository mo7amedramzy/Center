import { pool } from '../config/database.js';

export async function findActiveUserByUsername(username) {
  const result = await pool.query(
    `SELECT u.id, u.username, u.password_hash, u.role, u.teacher_id, t.name
     FROM users u LEFT JOIN teachers t ON t.id = u.teacher_id
     WHERE u.username = $1 AND u.active = TRUE`,
    [username],
  );
  return result.rows[0];
}

export async function findUserById(id) {
  const result = await pool.query(
    `SELECT u.id, u.username, u.role, u.teacher_id, t.name
     FROM users u LEFT JOIN teachers t ON t.id = u.teacher_id
     WHERE u.id = $1`,
    [id],
  );
  return result.rows[0];
}

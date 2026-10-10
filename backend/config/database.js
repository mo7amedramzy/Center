import bcrypt from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { cairoDate, shiftDate } from '../services/helpers.js';

const { Pool, types } = pg;
const directory = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(directory, 'schema.sql');

types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1082, (value) => value);

function poolOptions() {
  const databaseUrl = process.env.DATABASE_URL
    ? new URL(process.env.DATABASE_URL)
    : null;
  const isNeon = databaseUrl?.hostname.endsWith('.neon.tech');
  const sslMode = databaseUrl?.searchParams.get('sslmode');
  const ssl =
    sslMode === 'disable'
      ? false
      : isNeon || process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : undefined;

  return {
    connectionString: process.env.DATABASE_URL,
    ...(ssl ? { ssl } : {}),
    max: Number(process.env.PG_POOL_SIZE || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

export const pool = new Pool(poolOptions());

let initialization;
let shutdown;

export async function initializeSchema() {
  const schema = await readFile(schemaPath, 'utf8');
  await pool.query(schema);
}

export async function withTransaction(callback) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[database] Transaction rollback failed:', rollbackError);
      releaseError = rollbackError;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

async function initializeAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const existing = await pool.query(
    'SELECT id, role FROM users WHERE username = $1',
    [username],
  );
  if (existing.rowCount) {
    if (existing.rows[0].role !== 'admin') {
      throw new Error(
        `ADMIN_USERNAME "${username}" is already assigned to a non-admin user`,
      );
    }
    return;
  }

  const password =
    process.env.ADMIN_PASSWORD ||
    (process.env.NODE_ENV === 'production' ? '' : 'markaz123');
  if (!password) {
    throw new Error(
      'ADMIN_PASSWORD is required to initialize the production admin account',
    );
  }

  await pool.query(
    `INSERT INTO users (username, password_hash, role, teacher_id)
     VALUES ($1, $2, 'admin', NULL)
     ON CONFLICT (username) DO NOTHING`,
    [username, bcrypt.hashSync(password, 10)],
  );
}

async function seedDevelopmentData() {
  if (process.env.NODE_ENV !== 'development') return;

  const result = await withTransaction(async (client) => {
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM teachers) AS teachers,
        (SELECT COUNT(*) FROM students) AS students,
        (SELECT COUNT(*) FROM groups) AS groups
    `);
    const { teachers, students, groups } = counts.rows[0];
    if (Number(teachers) || Number(students) || Number(groups)) return false;

    const demoTeachers = [
      ['أحمد محمد', '01012345678', 'رياضيات', 'الثالث الثانوي', 'مجموعة A', 'ahmed'],
      ['منى إبراهيم', '01123456789', 'فيزياء', 'الثالث الثانوي', 'مجموعة B', 'mona'],
      ['خالد حسن', '01234567890', 'كيمياء', 'الثاني الثانوي', 'مجموعة A', 'khaled'],
    ];
    const seededGroups = [];
    for (const [name, phone, subject, grade, groupName, username] of demoTeachers) {
      const teacher = await client.query(
        'INSERT INTO teachers (name, phone) VALUES ($1, $2) RETURNING id',
        [name, phone],
      );
      const teacherId = teacher.rows[0].id;
      await client.query(
        `INSERT INTO users (username, password_hash, role, teacher_id)
         VALUES ($1, $2, 'teacher', $3)`,
        [username, bcrypt.hashSync('teacher123', 10), teacherId],
      );
      const group = await client.query(
        'INSERT INTO groups (teacher_id, name, subject, grade) VALUES ($1, $2, $3, $4) RETURNING id',
        [teacherId, groupName, subject, grade],
      );
      seededGroups.push({ id: group.rows[0].id, grade });
    }

    const demoStudents = [
      ['محمد أحمد', '01020000001', 0],
      ['محمود علي', '01020000002', 0],
      ['أحمد حسن', '01020000003', 0],
      ['سارة محمود', '01020000004', 0],
      ['عمر خالد', '01020000005', 0],
      ['نور الدين سامي', '01020000006', 0],
      ['ليلى أشرف', '01020000007', 1],
      ['يوسف عادل', '01020000008', 1],
      ['مريم مصطفى', '01020000009', 1],
      ['زياد طارق', '01020000010', 1],
      ['ملك هشام', '01020000011', 2],
      ['آدم شريف', '01020000012', 2],
    ];
    const today = cairoDate();
    const sessions = new Map();
    for (const [index, [name, phone, groupIndex]] of demoStudents.entries()) {
      const group = seededGroups[groupIndex];
      const student = await client.query(
        `INSERT INTO students (name, phone, grade, guardian_phone)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          name,
          phone,
          group.grade,
          `010300000${String(index + 1).padStart(2, '0')}`,
        ],
      );
      const studentId = student.rows[0].id;
      await client.query(
        'INSERT INTO enrollments (student_id, group_id) VALUES ($1, $2)',
        [studentId, group.id],
      );

      const date = index % 3 === 0 ? shiftDate(today, -1) : today;
      let sessionId = sessions.get(`${group.id}:${date}`);
      if (!sessionId) {
        const session = await client.query(
          `INSERT INTO sessions (group_id, session_date) VALUES ($1, $2)
           ON CONFLICT (group_id, session_date) DO UPDATE
           SET session_date = EXCLUDED.session_date RETURNING id`,
          [group.id, date],
        );
        sessionId = session.rows[0].id;
        sessions.set(`${group.id}:${date}`, sessionId);
      }
      await client.query(
        'INSERT INTO attendance (session_id, student_id, status) VALUES ($1, $2, $3)',
        [sessionId, studentId, index % 4 === 0 ? 'absent' : 'present'],
      );
    }
    return true;
  });

  if (result) console.log('[database] Development sample data initialized');
}

export async function initializeDatabase() {
  if (!initialization) {
    initialization = (async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required to connect to PostgreSQL');
      }
      await pool.query('SELECT 1');
      await initializeSchema();
      await initializeAdmin();
      await seedDevelopmentData();
      console.log('[database] PostgreSQL schema and admin account are ready');
    })();
  }
  return initialization;
}

export function closeDatabase() {
  if (!shutdown) shutdown = pool.end();
  return shutdown;
}

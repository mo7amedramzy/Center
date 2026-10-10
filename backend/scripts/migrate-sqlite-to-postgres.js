import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeDatabase, initializeSchema, pool, withTransaction } from '../config/database.js';

const tables = [
  {
    name: 'teachers',
    columns: ['id', 'name', 'phone', 'photo', 'active', 'created_at'],
  },
  {
    name: 'students',
    columns: [
      'id',
      'name',
      'phone',
      'grade',
      'guardian_phone',
      'notes',
      'active',
      'created_at',
    ],
  },
  {
    name: 'users',
    columns: [
      'id',
      'username',
      'password_hash',
      'role',
      'teacher_id',
      'active',
      'created_at',
    ],
  },
  {
    name: 'groups',
    columns: [
      'id',
      'teacher_id',
      'name',
      'subject',
      'grade',
      'grade_level',
      'schedule',
      'active',
      'created_at',
    ],
  },
  {
    name: 'enrollments',
    columns: ['id', 'student_id', 'group_id', 'active', 'created_at'],
  },
  {
    name: 'sessions',
    columns: ['id', 'group_id', 'session_date', 'created_at'],
  },
  {
    name: 'attendance',
    columns: [
      'id',
      'session_id',
      'student_id',
      'status',
      'updated_at',
    ],
  },
];

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sourceColumns(database, table) {
  const found = database
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((column) => column.name);
  if (!found.length) {
    throw new Error(`SQLite source is missing the required table "${table}"`);
  }
  return found;
}

function normalizeValue(column, value) {
  if (column === 'active' && value !== null) return Boolean(value);
  return value;
}

async function migrate(sourcePath) {
  if (!process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL to the empty Neon/PostgreSQL destination first');
  }
  if (!sourcePath) {
    throw new Error(
      'Usage: npm --workspace backend run migrate:sqlite -- <path-to-sqlite-file>',
    );
  }

  const absoluteSourcePath = path.resolve(sourcePath);
  const source = new Database(absoluteSourcePath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    await pool.query('SELECT 1');
    await initializeSchema();

    const migrationPlan = tables.map((table) => {
      const available = new Set(sourceColumns(source, table.name));
      const columns = table.columns.filter((column) => available.has(column));
      if (!columns.includes('id')) {
        throw new Error(`SQLite table "${table.name}" has no id column`);
      }
      return {
        ...table,
        columns,
        rows: source.prepare(`SELECT * FROM ${quoteIdentifier(table.name)}`).all(),
      };
    });
    const adminPasswordHashes = source
      .prepare("SELECT password_hash FROM users WHERE role = 'admin'")
      .all();
    if (
      adminPasswordHashes.some(({ password_hash }) =>
        bcrypt.compareSync('markaz123', password_hash),
      )
    ) {
      console.warn(
        '[migration] WARNING: the SQLite admin uses the development password; explicitly rotate it before exposing the app publicly.',
      );
    }

    const occupiedTables = [];
    for (const table of tables) {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(table.name)}`,
      );
      if (result.rows[0].count) occupiedTables.push(table.name);
    }
    if (occupiedTables.length) {
      throw new Error(
        `Refusing to import into non-empty PostgreSQL tables: ${occupiedTables.join(', ')}. ` +
          'Use an empty destination database; no existing rows were changed.',
      );
    }

    const counts = await withTransaction(async (client) => {
      const migratedCounts = {};
      for (const table of migrationPlan) {
        const columnsSql = table.columns.map(quoteIdentifier).join(', ');
        const chunkSize = 500;
        for (let offset = 0; offset < table.rows.length; offset += chunkSize) {
          const chunk = table.rows.slice(offset, offset + chunkSize);
          const values = [];
          const rowsSql = chunk.map((row, rowIndex) => {
            const placeholders = table.columns.map((column, columnIndex) => {
              values.push(normalizeValue(column, row[column]));
              return `$${rowIndex * table.columns.length + columnIndex + 1}`;
            });
            return `(${placeholders.join(', ')})`;
          });
          if (chunk.length) {
            await client.query(
              `INSERT INTO ${quoteIdentifier(table.name)} (${columnsSql})
               VALUES ${rowsSql.join(', ')}`,
              values,
            );
          }
        }

        const actual = await client.query(
          `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(table.name)}`,
        );
        if (actual.rows[0].count !== table.rows.length) {
          throw new Error(
            `Row count mismatch for "${table.name}": source ${table.rows.length}, destination ${actual.rows[0].count}`,
          );
        }
        migratedCounts[table.name] = actual.rows[0].count;

        await client.query(
          `SELECT setval(
             pg_get_serial_sequence($1, 'id'),
             GREATEST(COALESCE((SELECT MAX(id) FROM ${quoteIdentifier(table.name)}), 1), 1),
             EXISTS (SELECT 1 FROM ${quoteIdentifier(table.name)})
           )`,
          [table.name],
        );
      }
      return migratedCounts;
    });

    for (const [table, count] of Object.entries(counts)) {
      console.log(`[migration] ${table}: ${count} rows verified`);
    }
    console.log('[migration] SQLite data imported successfully; source was opened read-only.');
  } finally {
    source.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await migrate(process.argv[2]);
  } catch (error) {
    console.error('[migration] SQLite-to-PostgreSQL migration failed:', error);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

export { migrate };

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const runId = `${process.pid}_${Date.now()}`;
const adminUsername = `integration_admin_${runId}`;
const adminPassword = `integration_password_${runId}`;

if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = `integration_jwt_${runId}`;
  process.env.ADMIN_USERNAME = adminUsername;
  process.env.ADMIN_PASSWORD = adminPassword;
}

describe('PostgreSQL API integration', () => {
  if (!testDatabaseUrl) {
    test(
      'requires a disposable PostgreSQL database',
      { skip: 'Set TEST_DATABASE_URL to a disposable PostgreSQL database' },
      () => {},
    );
  } else {
    let app;
    let pool;
    let initializeDatabase;
    let closeDatabase;
    let server;
    let baseUrl;
    let teacherId;
    let groupId;
    let studentId;

    before(async () => {
      ({ default: app } = await import('../app.js'));
      ({ pool, initializeDatabase, closeDatabase } = await import(
        '../config/database.js'
      ));
      await initializeDatabase();
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
      if (server?.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      if (pool) {
        if (teacherId) {
          await pool.query(
            `DELETE FROM attendance
             WHERE session_id IN (SELECT id FROM sessions WHERE group_id IN
               (SELECT id FROM groups WHERE teacher_id = $1))`,
            [teacherId],
          );
          await pool.query(
            'DELETE FROM sessions WHERE group_id IN (SELECT id FROM groups WHERE teacher_id = $1)',
            [teacherId],
          );
          await pool.query(
            'DELETE FROM enrollments WHERE group_id IN (SELECT id FROM groups WHERE teacher_id = $1)',
            [teacherId],
          );
          if (studentId) {
            await pool.query('DELETE FROM attendance WHERE student_id = $1', [
              studentId,
            ]);
            await pool.query('DELETE FROM enrollments WHERE student_id = $1', [
              studentId,
            ]);
            await pool.query('DELETE FROM students WHERE id = $1', [studentId]);
          }
          await pool.query('DELETE FROM groups WHERE teacher_id = $1', [
            teacherId,
          ]);
          await pool.query('DELETE FROM users WHERE teacher_id = $1', [
            teacherId,
          ]);
          await pool.query('DELETE FROM teachers WHERE id = $1', [teacherId]);
        }
        await pool.query('DELETE FROM users WHERE username = $1', [
          adminUsername,
        ]);
      }
      if (closeDatabase) await closeDatabase();
    });

    test('initializes schema and admin, authenticates users, and preserves API operations', async () => {
      const healthResponse = await fetch(`${baseUrl}/api/health`);
      const health = await healthResponse.json();
      assert.equal(healthResponse.status, 200);
      assert.equal(health.ok, true);
      assert.equal(health.database, 'ok');

      await initializeDatabase();
      const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: adminUsername,
          password: adminPassword,
        }),
      });
      const adminPayload = await adminLogin.json();
      assert.equal(adminLogin.status, 200);
      assert.equal(adminPayload.user.role, 'admin');
      assert.ok(adminPayload.token);

      const adminHeaders = {
        Authorization: `Bearer ${adminPayload.token}`,
        'Content-Type': 'application/json',
      };
      const teacherResponse = await fetch(`${baseUrl}/api/teachers`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          name: `Integration teacher ${runId}`,
          phone: '01000000000',
          subject: 'Physics',
        }),
      });
      assert.equal(teacherResponse.status, 201);
      teacherId = (await teacherResponse.json()).id;

      const groupsResponse = await fetch(`${baseUrl}/api/groups`, {
        headers: adminHeaders,
      });
      assert.equal(groupsResponse.status, 200);
      const groups = await groupsResponse.json();
      groupId = groups.find((group) => group.teacherId === teacherId)?.id;
      assert.ok(groupId);

      const teacherLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: `teacher_${teacherId}`,
          password: 'teacher123',
        }),
      });
      const teacherPayload = await teacherLogin.json();
      assert.equal(teacherLogin.status, 200);
      assert.equal(teacherPayload.user.role, 'teacher');

      const teacherGroupsResponse = await fetch(`${baseUrl}/api/groups`, {
        headers: { Authorization: `Bearer ${teacherPayload.token}` },
      });
      const teacherGroups = await teacherGroupsResponse.json();
      assert.equal(teacherGroupsResponse.status, 200);
      assert.ok(teacherGroups.every((group) => group.teacherId === teacherId));

      const studentResponse = await fetch(`${baseUrl}/api/students`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          name: `Integration student ${runId}`,
          phone: '01000000001',
          groupId,
        }),
      });
      assert.equal(studentResponse.status, 201);
      studentId = (await studentResponse.json()).id;

      const duplicateEnrollment = await fetch(
        `${baseUrl}/api/students/${studentId}/enrollments`,
        {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ groupId }),
        },
      );
      assert.equal(duplicateEnrollment.status, 409);

      const attendanceResponse = await fetch(
        `${baseUrl}/api/groups/${groupId}/attendance`,
        {
          method: 'PUT',
          headers: adminHeaders,
          body: JSON.stringify({
            date: '2026-10-10',
            entries: [{ studentId, status: 'present' }],
          }),
        },
      );
      const attendancePayload = await attendanceResponse.json();
      assert.equal(attendanceResponse.status, 200);
      assert.ok(attendancePayload.sessionId);

      const attendanceListResponse = await fetch(
        `${baseUrl}/api/groups/${groupId}/attendance?date=2026-10-10`,
        { headers: adminHeaders },
      );
      const attendanceList = await attendanceListResponse.json();
      assert.equal(attendanceListResponse.status, 200);
      assert.equal(attendanceList.students[0].status, 'present');

      const studentDetailResponse = await fetch(
        `${baseUrl}/api/students/${studentId}`,
        { headers: adminHeaders },
      );
      const studentDetail = await studentDetailResponse.json();
      assert.equal(studentDetailResponse.status, 200);
      assert.equal(studentDetail.attendanceRate, 100);
    });

    test('rolls back a failed multi-statement PostgreSQL transaction', async () => {
      const { withTransaction } = await import('../config/database.js');
      const marker = `rollback_${runId}`;
      await assert.rejects(
        withTransaction(async (client) => {
          await client.query(
            'INSERT INTO teachers (name, phone) VALUES ($1, $2)',
            [marker, ''],
          );
          await client.query(
            `INSERT INTO groups (teacher_id, name, subject, grade)
             VALUES (2147483000, $1, 'test', 'test')`,
            [marker],
          );
        }),
      );
      const result = await pool.query(
        'SELECT COUNT(*)::int AS count FROM teachers WHERE name = $1',
        [marker],
      );
      assert.equal(result.rows[0].count, 0);
    });

    test('rejects invalid credentials and protects admin-only routes', async () => {
      const invalidLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminUsername, password: 'incorrect' }),
      });
      assert.equal(invalidLogin.status, 401);

      const teacherLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: `teacher_${teacherId}`,
          password: 'teacher123',
        }),
      });
      const teacher = await teacherLogin.json();
      const forbidden = await fetch(`${baseUrl}/api/teachers`, {
        headers: { Authorization: `Bearer ${teacher.token}` },
      });
      assert.equal(forbidden.status, 403);
    });
  }
});

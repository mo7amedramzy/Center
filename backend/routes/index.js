import express from 'express';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../config/database.js';
import { login, getCurrentUser } from '../controllers/auth.js';
import { importStudents } from '../controllers/students.js';
import {
  authenticate,
  requireAdmin,
  requireGroupAccess,
  requireStudentAccess,
  canAccessGroup,
} from '../middleware/auth.js';
import {
  cairoDate,
  fixedGradeLabels,
  isValidTeacherPhoto,
  normalizeGroupGrade,
} from '../services/helpers.js';

const router = express.Router();

function isPositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0;
}

router.get('/api/health', async (request, response) => {
  let dbStatus = 'ok';
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    console.error('[health] PostgreSQL check failed:', error);
    dbStatus = 'unavailable';
  }
  response.status(dbStatus === 'ok' ? 200 : 503).json({
    ok: dbStatus === 'ok',
    status: dbStatus,
    app: 'center-backend',
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

router.post('/api/auth/login', login);
router.get('/api/auth/me', authenticate, getCurrentUser);

router.get('/api/dashboard', authenticate, async (request, response) => {
  const user = request.user;
  const isTeacher = user.role === 'teacher';
  const teacherId = user.teacher_id;
  const teachers = isTeacher
    ? 1
    : (
        await pool.query(
          'SELECT COUNT(*)::int AS count FROM teachers WHERE active = TRUE',
        )
      ).rows[0].count;
  const studentResult = isTeacher
    ? await pool.query(
        `SELECT COUNT(DISTINCT s.id)::int AS count
         FROM students s
         JOIN enrollments e ON e.student_id = s.id
         JOIN groups g ON g.id = e.group_id
         WHERE s.active = TRUE AND e.active = TRUE AND g.active = TRUE
           AND g.teacher_id = $1`,
        [teacherId],
      )
    : await pool.query(
        'SELECT COUNT(*)::int AS count FROM students WHERE active = TRUE',
      );
  const today = cairoDate();
  const todayCounts = await pool.query(
    `SELECT a.status, COUNT(*)::int AS count
     FROM attendance a
     JOIN sessions se ON se.id = a.session_id
     JOIN groups g ON g.id = se.group_id
     WHERE se.session_date = $1::date ${isTeacher ? 'AND g.teacher_id = $2' : ''}
     GROUP BY a.status`,
    isTeacher ? [today, teacherId] : [today],
  );
  const counts = Object.fromEntries(
    todayCounts.rows.map((row) => [row.status, row.count]),
  );
  const recent = await pool.query(
    `SELECT s.id, s.name, s.phone, s.created_at AS "createdAt",
       STRING_AGG(DISTINCT t.name, ',') AS teachers,
       STRING_AGG(DISTINCT g.subject, ',') AS subjects,
       STRING_AGG(DISTINCT g.name, ',') AS groups
     FROM students s
     JOIN enrollments e ON e.student_id = s.id
     JOIN groups g ON g.id = e.group_id
     JOIN teachers t ON t.id = g.teacher_id
     WHERE s.active = TRUE AND e.active = TRUE
       ${isTeacher ? 'AND g.teacher_id = $1' : ''}
     GROUP BY s.id
     ORDER BY s.created_at DESC
     LIMIT 5`,
    isTeacher ? [teacherId] : [],
  );
  response.json({
    teachers,
    students: studentResult.rows[0].count,
    present: counts.present || 0,
    absent: counts.absent || 0,
    recent: recent.rows,
    today,
  });
});

router.get('/api/teachers', authenticate, requireAdmin, async (request, response) => {
  const result = await pool.query(`
    SELECT t.id, t.name, t.phone, t.photo, t.active,
      COUNT(DISTINCT g.id)::int AS "groupCount",
      COUNT(DISTINCT e.student_id)::int AS "studentCount",
      STRING_AGG(DISTINCT g.subject, ',') AS subjects,
      STRING_AGG(DISTINCT g.grade, ',') AS grades
    FROM teachers t
    LEFT JOIN groups g ON g.teacher_id = t.id AND g.active = TRUE
    LEFT JOIN enrollments e ON e.group_id = g.id AND e.active = TRUE
    WHERE t.active = TRUE
    GROUP BY t.id
    ORDER BY t.name
  `);
  response.json(result.rows);
});

router.post('/api/teachers', authenticate, requireAdmin, async (request, response) => {
  const {
    name,
    phone = '',
    subject,
    grade = 'الثالث الثانوي',
    photo = '',
  } = request.body || {};
  if (!name?.trim() || !subject?.trim()) {
    return response.status(400).json({ error: 'أكمل اسم المدرس والمادة' });
  }
  if (photo && !isValidTeacherPhoto(photo)) {
    return response.status(400).json({ error: 'الصورة غير صالحة أو حجمها كبير' });
  }
  const normalizedGrade =
    String(grade || 'الثالث الثانوي').trim() || 'الثالث الثانوي';
  const id = await withTransaction(async (client) => {
    const teacher = await client.query(
      'INSERT INTO teachers (name, phone, photo) VALUES ($1, $2, $3) RETURNING id',
      [name.trim(), phone.trim(), photo],
    );
    const teacherId = teacher.rows[0].id;
    await client.query(
      'INSERT INTO groups (teacher_id, name, subject, grade) VALUES ($1, $2, $3, $4)',
      [teacherId, 'مجموعة A', subject.trim(), normalizedGrade],
    );
    await client.query(
      `INSERT INTO users (username, password_hash, role, teacher_id)
       VALUES ($1, $2, 'teacher', $3)`,
      [`teacher_${teacherId}`, bcrypt.hashSync('teacher123', 10), teacherId],
    );
    return teacherId;
  });
  response.status(201).json({ id });
});

router.put(
  '/api/teachers/:id',
  authenticate,
  requireAdmin,
  async (request, response) => {
    const { name, phone = '', photo } = request.body || {};
    if (!isPositiveInteger(request.params.id)) {
      return response.status(404).json({ error: 'المدرس غير موجود' });
    }
    if (!name?.trim()) {
      return response.status(400).json({ error: 'اسم المدرس مطلوب' });
    }
    if (photo !== undefined && photo !== '' && !isValidTeacherPhoto(photo)) {
      return response.status(400).json({ error: 'الصورة غير صالحة أو حجمها كبير' });
    }
    const values =
      photo === undefined
        ? [name.trim(), phone.trim(), Number(request.params.id)]
        : [name.trim(), phone.trim(), photo, Number(request.params.id)];
    const result = await pool.query(
      photo === undefined
        ? 'UPDATE teachers SET name = $1, phone = $2 WHERE id = $3 AND active = TRUE'
        : 'UPDATE teachers SET name = $1, phone = $2, photo = $3 WHERE id = $4 AND active = TRUE',
      values,
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: 'المدرس غير موجود' });
    }
    response.json({ ok: true });
  },
);

router.delete(
  '/api/teachers/:id',
  authenticate,
  requireAdmin,
  async (request, response) => {
    const teacherId = Number(request.params.id);
    if (!isPositiveInteger(teacherId)) {
      return response.status(404).json({ error: 'المدرس غير موجود' });
    }
    const deleted = await withTransaction(async (client) => {
      const exclusiveStudents = await client.query(
        `SELECT DISTINCT e.student_id AS id
         FROM enrollments e
         JOIN groups g ON g.id = e.group_id
         WHERE g.teacher_id = $1 AND e.active = TRUE
           AND NOT EXISTS (
             SELECT 1
             FROM enrollments other
             JOIN groups other_group ON other_group.id = other.group_id
             WHERE other.student_id = e.student_id
               AND other.active = TRUE
               AND other_group.teacher_id <> $1
           )`,
        [teacherId],
      );
      await client.query(
        `DELETE FROM attendance
         WHERE session_id IN (
           SELECT id FROM sessions
           WHERE group_id IN (SELECT id FROM groups WHERE teacher_id = $1)
         )`,
        [teacherId],
      );
      await client.query(
        'DELETE FROM sessions WHERE group_id IN (SELECT id FROM groups WHERE teacher_id = $1)',
        [teacherId],
      );
      await client.query(
        'DELETE FROM enrollments WHERE group_id IN (SELECT id FROM groups WHERE teacher_id = $1)',
        [teacherId],
      );
      const studentIds = exclusiveStudents.rows.map((row) => row.id);
      if (studentIds.length) {
        await client.query(
          'DELETE FROM attendance WHERE student_id = ANY($1::int[])',
          [studentIds],
        );
        await client.query(
          'DELETE FROM enrollments WHERE student_id = ANY($1::int[])',
          [studentIds],
        );
        await client.query(
          'DELETE FROM students WHERE id = ANY($1::int[])',
          [studentIds],
        );
      }
      await client.query('DELETE FROM groups WHERE teacher_id = $1', [teacherId]);
      await client.query('DELETE FROM users WHERE teacher_id = $1', [teacherId]);
      const teacher = await client.query(
        'DELETE FROM teachers WHERE id = $1',
        [teacherId],
      );
      return teacher.rowCount;
    });
    if (!deleted) {
      return response.status(404).json({ error: 'المدرس غير موجود' });
    }
    response.json({ ok: true });
  },
);

router.get('/api/groups', authenticate, async (request, response) => {
  const isTeacher = request.user.role === 'teacher';
  const result = await pool.query(
    `SELECT g.id, g.name, g.subject, g.grade,
       g.grade_level AS "gradeLevel", g.schedule,
       g.teacher_id AS "teacherId", t.name AS "teacherName",
       COUNT(DISTINCT e.student_id)::int AS "studentCount"
     FROM groups g
     JOIN teachers t ON t.id = g.teacher_id
     LEFT JOIN enrollments e ON e.group_id = g.id AND e.active = TRUE
     WHERE g.active = TRUE ${isTeacher ? 'AND g.teacher_id = $1' : ''}
     GROUP BY g.id, t.name
     ORDER BY t.name, g.subject, g.name`,
    isTeacher ? [request.user.teacher_id] : [],
  );
  response.json(result.rows);
});

router.post(
  '/api/groups/bulk',
  authenticate,
  requireAdmin,
  async (request, response) => {
    const {
      teacherId,
      subject,
      grade,
      gradeLevel = '',
      schedule,
      names,
    } = request.body || {};
    const cleanNames = Array.isArray(names)
      ? names.map((name) => String(name).trim())
      : [];
    if (
      !teacherId ||
      !subject?.trim() ||
      !schedule?.trim() ||
      cleanNames.length < 1 ||
      cleanNames.length > 20 ||
      cleanNames.some((name) => !name || name.length > 80)
    ) {
      return response.status(400).json({ error: 'أكمل بيانات المجموعات' });
    }
    const normalizedTeacherId = Number(teacherId);
    if (!isPositiveInteger(normalizedTeacherId)) {
      return response.status(400).json({ error: 'المدرس غير موجود' });
    }
    const teacher = await pool.query(
      'SELECT id FROM teachers WHERE id = $1 AND active = TRUE',
      [normalizedTeacherId],
    );
    if (!teacher.rowCount) {
      return response.status(400).json({ error: 'المدرس غير موجود' });
    }
    const normalizedGradeLevel = String(gradeLevel || '').trim();
    const normalizedGrade = normalizeGroupGrade(normalizedGradeLevel, grade);
    const ids = await withTransaction(async (client) => {
      const created = [];
      for (const name of cleanNames) {
        const result = await client.query(
          `INSERT INTO groups (teacher_id, name, subject, grade, grade_level, schedule)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            normalizedTeacherId,
            name,
            subject.trim(),
            normalizedGrade,
            normalizedGradeLevel,
            schedule.trim(),
          ],
        );
        created.push(result.rows[0].id);
      }
      return created;
    });
    response.status(201).json({ ids });
  },
);

router.post('/api/groups', authenticate, requireAdmin, async (request, response) => {
  const {
    teacherId,
    name,
    subject,
    grade,
    gradeLevel = '',
    schedule,
  } = request.body || {};
  if (!teacherId || !subject?.trim() || !schedule?.trim()) {
    return response.status(400).json({ error: 'أكمل بيانات المجموعة' });
  }
  const normalizedTeacherId = Number(teacherId);
  if (!isPositiveInteger(normalizedTeacherId)) {
    return response.status(400).json({ error: 'المدرس غير موجود' });
  }
  const teacher = await pool.query(
    'SELECT id FROM teachers WHERE id = $1 AND active = TRUE',
    [normalizedTeacherId],
  );
  if (!teacher.rowCount) {
    return response.status(400).json({ error: 'المدرس غير موجود' });
  }
  const normalizedGradeLevel = String(gradeLevel || '').trim();
  const normalizedGrade = normalizeGroupGrade(normalizedGradeLevel, grade);
  const result = await pool.query(
    `INSERT INTO groups (teacher_id, name, subject, grade, grade_level, schedule)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      normalizedTeacherId,
      name?.trim() || 'مجموعة A',
      subject.trim(),
      normalizedGrade,
      normalizedGradeLevel,
      schedule.trim(),
    ],
  );
  response.status(201).json({ id: result.rows[0].id });
});

router.put('/api/groups/:id', authenticate, requireAdmin, async (request, response) => {
  const {
    teacherId,
    name,
    subject,
    grade,
    gradeLevel = '',
    schedule,
  } = request.body || {};
  if (
    !teacherId ||
    !subject?.trim() ||
    !schedule?.trim() ||
    (name !== undefined && !name.trim())
  ) {
    return response.status(400).json({ error: 'أكمل بيانات المجموعة' });
  }
  const normalizedTeacherId = Number(teacherId);
  const groupId = Number(request.params.id);
  if (!isPositiveInteger(normalizedTeacherId) || !isPositiveInteger(groupId)) {
    return response.status(400).json({ error: 'المدرس أو المجموعة غير موجودة' });
  }
  const teacher = await pool.query(
    'SELECT id FROM teachers WHERE id = $1 AND active = TRUE',
    [normalizedTeacherId],
  );
  if (!teacher.rowCount) {
    return response.status(400).json({ error: 'المدرس غير موجود' });
  }
  const currentGroup = await pool.query(
    'SELECT grade, grade_level, name FROM groups WHERE id = $1 AND active = TRUE',
    [groupId],
  );
  if (!currentGroup.rowCount) {
    return response.status(404).json({ error: 'المجموعة غير موجودة' });
  }
  const current = currentGroup.rows[0];
  const normalizedGradeLevel = String(gradeLevel || '').trim();
  const normalizedGrade = normalizeGroupGrade(
    normalizedGradeLevel,
    grade || current.grade,
  );
  const result = await pool.query(
    `UPDATE groups
     SET teacher_id = $1, name = $2, subject = $3, grade = $4,
         grade_level = $5, schedule = $6
     WHERE id = $7 AND active = TRUE`,
    [
      normalizedTeacherId,
      name?.trim() || current.name || 'مجموعة A',
      subject.trim(),
      normalizedGrade,
      normalizedGradeLevel || current.grade_level || '',
      schedule.trim(),
      groupId,
    ],
  );
  if (!result.rowCount) {
    return response.status(404).json({ error: 'المجموعة غير موجودة' });
  }
  response.json({ ok: true });
});

router.delete(
  '/api/groups/:id',
  authenticate,
  requireAdmin,
  async (request, response) => {
    const groupId = Number(request.params.id);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      return response.status(400).json({ error: 'المجموعة غير موجودة' });
    }
    const deleted = await withTransaction(async (client) => {
      const group = await client.query(
        'SELECT id FROM groups WHERE id = $1 AND active = TRUE',
        [groupId],
      );
      if (!group.rowCount) return false;
      await client.query(
        `DELETE FROM attendance
         WHERE session_id IN (SELECT id FROM sessions WHERE group_id = $1)`,
        [groupId],
      );
      await client.query('DELETE FROM sessions WHERE group_id = $1', [groupId]);
      await client.query('DELETE FROM enrollments WHERE group_id = $1', [groupId]);
      await client.query('DELETE FROM groups WHERE id = $1', [groupId]);
      return true;
    });
    if (!deleted) {
      return response.status(404).json({ error: 'المجموعة غير موجودة' });
    }
    response.json({ ok: true });
  },
);

router.put(
  '/api/teachers/:teacherId/grade-labels',
  authenticate,
  requireAdmin,
  async (request, response) => {
    const { from, to } = request.body || {};
    const fromLabel = String(from || '').trim();
    const toLabel = String(to || '').trim();
    if (!fromLabel || !toLabel) {
      return response.status(400).json({ error: 'اسم الصف مطلوب' });
    }
    const teacherId = Number(request.params.teacherId);
    const teacher = await pool.query(
      'SELECT id FROM teachers WHERE id = $1 AND active = TRUE',
      [teacherId],
    );
    if (!teacher.rowCount) {
      return response.status(404).json({ error: 'المدرس غير موجود' });
    }
    const sourceGrade = fixedGradeLabels[fromLabel] || fromLabel;
    const result = await pool.query(
      `UPDATE groups SET grade = $1, grade_level = ''
       WHERE teacher_id = $2 AND active = TRUE
         AND (grade = $3 OR grade_level = $4)`,
      [toLabel, teacherId, sourceGrade, fromLabel],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: 'لا توجد مجموعات لهذا الصف' });
    }
    response.json({ ok: true });
  },
);

router.delete(
  '/api/teachers/:teacherId/grade-labels',
  authenticate,
  requireAdmin,
  async (request, response) => {
    const label = String(request.body?.label || '').trim();
    if (!label) {
      return response.status(400).json({ error: 'اسم الصف مطلوب' });
    }
    const teacherId = Number(request.params.teacherId);
    const teacher = await pool.query(
      'SELECT id FROM teachers WHERE id = $1 AND active = TRUE',
      [teacherId],
    );
    if (!teacher.rowCount) {
      return response.status(404).json({ error: 'المدرس غير موجود' });
    }
    const sourceGrade = fixedGradeLabels[label] || label;
    const deletedCount = await withTransaction(async (client) => {
      const groups = await client.query(
        `SELECT id FROM groups
         WHERE teacher_id = $1 AND active = TRUE AND (grade = $2 OR grade_level = $3)`,
        [teacherId, sourceGrade, label],
      );
      const ids = groups.rows.map((group) => group.id);
      if (!ids.length) return 0;
      await client.query(
        `DELETE FROM attendance
         WHERE session_id IN (SELECT id FROM sessions WHERE group_id = ANY($1::int[]))`,
        [ids],
      );
      await client.query(
        'DELETE FROM sessions WHERE group_id = ANY($1::int[])',
        [ids],
      );
      await client.query(
        'DELETE FROM enrollments WHERE group_id = ANY($1::int[])',
        [ids],
      );
      await client.query('DELETE FROM groups WHERE id = ANY($1::int[])', [ids]);
      return ids.length;
    });
    if (!deletedCount) {
      return response.status(404).json({ error: 'لا توجد مجموعات لهذا الصف' });
    }
    response.json({ ok: true });
  },
);

router.get('/api/students', authenticate, async (request, response) => {
  const filters = ['s.active = TRUE', 'e.active = TRUE', 'g.active = TRUE'];
  const values = [];
  const addFilter = (sql, value) => {
    values.push(value);
    filters.push(sql.replace('?', `$${values.length}`));
  };
  const search = String(request.query.search || '').trim();
  const groupId = Number(request.query.groupId || 0);
  const teacherId = Number(request.query.teacherId || 0);
  if (
    (request.query.groupId && !isPositiveInteger(groupId)) ||
    (request.query.teacherId && !isPositiveInteger(teacherId))
  ) {
    return response.status(400).json({ error: 'معرّف المدرس أو المجموعة غير صالح' });
  }
  if (request.user.role === 'teacher') {
    addFilter('g.teacher_id = ?', request.user.teacher_id);
  }
  if (teacherId) {
    if (request.user.role === 'teacher' && teacherId !== request.user.teacher_id) {
      return response
        .status(403)
        .json({ error: 'غير مسموح بعرض طلاب هذا المدرس' });
    }
    addFilter('g.teacher_id = ?', teacherId);
  }
  if (groupId) addFilter('g.id = ?', groupId);
  if (search) {
    values.push(`%${search}%`);
    const placeholder = `$${values.length}`;
    filters.push(
      `(s.name ILIKE ${placeholder} OR s.phone ILIKE ${placeholder} OR s.guardian_phone ILIKE ${placeholder})`,
    );
  }
  const result = await pool.query(
    `SELECT s.id, s.name, s.phone, s.grade,
       s.guardian_phone AS "guardianPhone", s.notes,
       STRING_AGG(DISTINCT t.name, ',') AS teachers,
       STRING_AGG(DISTINCT g.subject, ',') AS subjects,
       STRING_AGG(DISTINCT g.name, ',') AS groups,
       STRING_AGG(DISTINCT g.id::text, ',') AS "groupIds"
     FROM students s
     JOIN enrollments e ON e.student_id = s.id
     JOIN groups g ON g.id = e.group_id
     JOIN teachers t ON t.id = g.teacher_id
     WHERE ${filters.join(' AND ')}
     GROUP BY s.id
     ORDER BY s.name`,
    values,
  );
  response.json(result.rows);
});

router.post('/api/students', authenticate, async (request, response) => {
  const {
    name,
    phone = '',
    grade = '',
    guardianPhone = '',
    notes = '',
    groupId,
  } = request.body || {};
  if (!name?.trim() || !groupId) {
    return response.status(400).json({ error: 'اسم الطالب والمجموعة مطلوبان' });
  }
  const normalizedGroupId = Number(groupId);
  if (!(await canAccessGroup(request.user, normalizedGroupId))) {
    return response.status(404).json({ error: 'المجموعة غير موجودة' });
  }
  const id = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO students (name, phone, grade, guardian_phone, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name.trim(), phone.trim(), grade.trim(), guardianPhone.trim(), notes.trim()],
    );
    const studentId = inserted.rows[0].id;
    await client.query(
      'INSERT INTO enrollments (student_id, group_id) VALUES ($1, $2)',
      [studentId, normalizedGroupId],
    );
    return studentId;
  });
  response.status(201).json({ id });
});

router.post('/api/students/import', authenticate, requireAdmin, importStudents);

router.get(
  '/api/students/:id',
  authenticate,
  requireStudentAccess,
  async (request, response) => {
    const studentResult = await pool.query(
      `SELECT id, name, phone, grade, guardian_phone AS "guardianPhone", notes
       FROM students WHERE id = $1 AND active = TRUE`,
      [request.params.id],
    );
    if (!studentResult.rowCount) {
      return response.status(404).json({ error: 'الطالب غير موجود' });
    }
    const student = studentResult.rows[0];
    const isTeacher = request.user.role === 'teacher';
    const values = isTeacher
      ? [request.params.id, request.user.teacher_id]
      : [request.params.id];
    const scope = isTeacher ? 'AND g.teacher_id = $2' : '';
    const groups = await pool.query(
      `SELECT g.id, g.name, g.subject, g.grade, t.name AS "teacherName"
       FROM enrollments e
       JOIN groups g ON g.id = e.group_id
       JOIN teachers t ON t.id = g.teacher_id
       WHERE e.student_id = $1 AND e.active = TRUE AND g.active = TRUE ${scope}`,
      values,
    );
    const attendance = await pool.query(
      `SELECT se.session_date AS date, a.status, g.name AS "groupName",
         g.subject, t.name AS "teacherName"
       FROM attendance a
       JOIN sessions se ON se.id = a.session_id
       JOIN groups g ON g.id = se.group_id
       JOIN teachers t ON t.id = g.teacher_id
       WHERE a.student_id = $1 ${scope}
       ORDER BY se.session_date DESC, a.id DESC`,
      values,
    );
    student.groups = groups.rows;
    student.attendance = attendance.rows;
    student.attendanceRate = attendance.rowCount
      ? Math.round(
          (attendance.rows.filter((item) => item.status === 'present').length /
            attendance.rowCount) *
            100,
        )
      : null;
    response.json(student);
  },
);

router.put(
  '/api/students/:id',
  authenticate,
  requireStudentAccess,
  async (request, response) => {
    const {
      name,
      phone = '',
      grade = '',
      guardianPhone = '',
      notes = '',
    } = request.body || {};
    if (!name?.trim()) {
      return response.status(400).json({ error: 'اسم الطالب مطلوب' });
    }
    const result = await pool.query(
      `UPDATE students
       SET name = $1, phone = $2, grade = $3, guardian_phone = $4, notes = $5
       WHERE id = $6 AND active = TRUE`,
      [
        name.trim(),
        phone.trim(),
        grade.trim(),
        guardianPhone.trim(),
        notes.trim(),
        request.params.id,
      ],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: 'الطالب غير موجود' });
    }
    response.json({ ok: true });
  },
);

router.post(
  '/api/students/:id/enrollments',
  authenticate,
  requireStudentAccess,
  async (request, response) => {
    const { groupId } = request.body || {};
    const normalizedGroupId = Number(groupId);
    if (
      !groupId ||
      !isPositiveInteger(normalizedGroupId) ||
      !(await canAccessGroup(request.user, normalizedGroupId))
    ) {
      return response.status(404).json({ error: 'المجموعة غير موجودة' });
    }
    try {
      await pool.query(
        'INSERT INTO enrollments (student_id, group_id) VALUES ($1, $2)',
        [request.params.id, normalizedGroupId],
      );
    } catch (error) {
      if (error.code === '23505') {
        return response
          .status(409)
          .json({ error: 'الطالب مسجل في هذه المجموعة بالفعل' });
      }
      throw error;
    }
    response.status(201).json({ ok: true });
  },
);

router.delete(
  '/api/students/:id',
  authenticate,
  requireAdmin,
  async (request, response) => {
    const id = Number(request.params.id);
    const deleted = await withTransaction(async (client) => {
      await client.query('DELETE FROM attendance WHERE student_id = $1', [id]);
      await client.query('DELETE FROM enrollments WHERE student_id = $1', [id]);
      const result = await client.query('DELETE FROM students WHERE id = $1', [
        id,
      ]);
      return result.rowCount;
    });
    if (!deleted) {
      return response.status(404).json({ error: 'الطالب غير موجود' });
    }
    response.json({ ok: true });
  },
);

router.get(
  '/api/groups/:groupId/attendance',
  authenticate,
  requireGroupAccess,
  async (request, response) => {
    const date = String(request.query.date || cairoDate());
    if (!isValidDate(date)) {
      return response.status(400).json({ error: 'التاريخ غير صالح' });
    }
    const session = await pool.query(
      'SELECT id FROM sessions WHERE group_id = $1 AND session_date = $2::date',
      [request.params.groupId, date],
    );
    const sessionId = session.rows[0]?.id || null;
    const students = await pool.query(
      `SELECT s.id, s.name, s.phone, a.status
       FROM enrollments e
       JOIN students s ON s.id = e.student_id
       LEFT JOIN attendance a ON a.student_id = s.id AND a.session_id = $1
       WHERE e.group_id = $2 AND e.active = TRUE AND s.active = TRUE
       ORDER BY s.name`,
      [sessionId || -1, request.params.groupId],
    );
    response.json({ sessionId, date, students: students.rows });
  },
);

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

router.put(
  '/api/groups/:groupId/attendance',
  authenticate,
  requireGroupAccess,
  async (request, response) => {
    const { date = cairoDate(), entries = [] } = request.body || {};
    if (!isValidDate(date) || !Array.isArray(entries)) {
      return response.status(400).json({ error: 'بيانات الحضور غير صالحة' });
    }
    const sessionId = await withTransaction(async (client) => {
      const session = await client.query(
        `INSERT INTO sessions (group_id, session_date) VALUES ($1, $2::date)
         ON CONFLICT (group_id, session_date) DO UPDATE
         SET session_date = EXCLUDED.session_date RETURNING id`,
        [request.params.groupId, date],
      );
      const currentSessionId = session.rows[0].id;
      const enrollments = await client.query(
        'SELECT student_id FROM enrollments WHERE group_id = $1 AND active = TRUE',
        [request.params.groupId],
      );
      const enrolled = new Set(
        enrollments.rows.map((row) => Number(row.student_id)),
      );
      for (const entry of entries) {
        if (
          enrolled.has(Number(entry.studentId)) &&
          ['present', 'absent'].includes(entry.status)
        ) {
          await client.query(
            `INSERT INTO attendance (session_id, student_id, status)
             VALUES ($1, $2, $3)
             ON CONFLICT (session_id, student_id) DO UPDATE
             SET status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP`,
            [currentSessionId, Number(entry.studentId), entry.status],
          );
        }
      }
      return currentSessionId;
    });
    response.json({ ok: true, sessionId });
  },
);

export default router;

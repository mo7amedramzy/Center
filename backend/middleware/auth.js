import jwt from 'jsonwebtoken';
import { pool } from '../config/database.js';

export const jwtSecret =
  process.env.JWT_SECRET || 'development-only-change-before-deploying';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('Set JWT_SECRET before starting in production');
}

export async function authenticate(request, response, next) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return response.status(401).json({ error: 'يلزم تسجيل الدخول' });

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret);
  } catch {
    return response
      .status(401)
      .json({ error: 'انتهت جلسة الدخول، سجل الدخول مجددًا' });
  }

  const result = await pool.query(
    'SELECT id, username, role, teacher_id, active FROM users WHERE id = $1',
    [payload.id],
  );
  const user = result.rows[0];
  if (!user || !user.active) {
    return response.status(401).json({ error: 'يلزم تسجيل الدخول' });
  }
  request.user = user;
  next();
}

export function requireAdmin(request, response, next) {
  if (request.user.role !== 'admin') {
    return response.status(403).json({ error: 'هذه العملية متاحة للمدير فقط' });
  }
  next();
}

export async function canAccessGroup(user, groupId) {
  if (!user || !Number.isSafeInteger(Number(groupId)) || Number(groupId) < 1) {
    return false;
  }
  if (user.role === 'admin') return true;
  if (user.role !== 'teacher' || !user.teacher_id) return false;
  const result = await pool.query(
    'SELECT 1 FROM groups WHERE id = $1 AND teacher_id = $2 AND active = TRUE',
    [Number(groupId), user.teacher_id],
  );
  return result.rowCount > 0;
}

export async function canAccessStudent(user, studentId) {
  if (
    !user ||
    !Number.isSafeInteger(Number(studentId)) ||
    Number(studentId) < 1
  ) {
    return false;
  }
  if (user.role === 'admin') return true;
  if (user.role !== 'teacher' || !user.teacher_id) return false;
  const result = await pool.query(
    `SELECT 1 FROM enrollments e JOIN groups g ON g.id = e.group_id
     WHERE e.student_id = $1 AND e.active = TRUE
       AND g.teacher_id = $2 AND g.active = TRUE`,
    [Number(studentId), user.teacher_id],
  );
  return result.rowCount > 0;
}

export async function requireGroupAccess(request, response, next) {
  const id = Number(request.params.groupId || request.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return response.status(404).json({ error: 'المجموعة غير موجودة' });
  }
  if (!(await canAccessGroup(request.user, id))) {
    return response.status(404).json({ error: 'المجموعة غير موجودة' });
  }
  if (request.params.groupId) request.params.groupId = String(id);
  if (request.params.id) request.params.id = String(id);
  next();
}

export async function requireStudentAccess(request, response, next) {
  const id = Number(request.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return response.status(404).json({ error: 'الطالب غير موجود' });
  }
  if (!(await canAccessStudent(request.user, id))) {
    return response.status(404).json({ error: 'الطالب غير موجود' });
  }
  request.params.id = String(id);
  next();
}

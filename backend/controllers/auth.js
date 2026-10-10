import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { jwtSecret } from '../middleware/auth.js';
import { findActiveUserByUsername, findUserById } from '../models/users.js';

export async function login(request, response) {
  const { username, password } = request.body || {};
  const user = await findActiveUserByUsername(String(username || '').trim());
  if (
    !user ||
    !bcrypt.compareSync(String(password || ''), user.password_hash)
  ) {
    return response
      .status(401)
      .json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  const token = jwt.sign({ id: user.id }, jwtSecret, { expiresIn: '12h' });
  response.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      teacherId: user.teacher_id,
      name: user.name || (user.role === 'admin' ? 'مدير السنتر' : 'مدرس'),
    },
  });
}

export async function getCurrentUser(request, response) {
  const user = await findUserById(request.user.id);
  if (!user) {
    return response.status(401).json({ error: 'المستخدم غير موجود' });
  }
  response.json({
    id: user.id,
    username: user.username,
    role: user.role,
    teacherId: user.teacher_id,
    name: user.name || (user.role === 'admin' ? 'مدير السنتر' : 'مدرس'),
  });
}

import { withTransaction } from '../config/database.js';

const MAX_IMPORT_STUDENTS = 500;

function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeContact(value) {
  const westernDigits = String(value ?? '')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
  const digits = westernDigits.replace(/\D/g, '');
  return digits || '';
}

function getRowErrors(student, source) {
  const errors = [];
  for (const field of ['name', 'phone', 'guardianPhone', 'grade', 'notes']) {
    if (source[field] !== undefined && typeof source[field] !== 'string') {
      errors.push('بيانات الطالب غير صالحة؛ يجب إرسال الحقول كنصوص.');
      return errors;
    }
  }
  if (!student.name) errors.push('اسم الطالب مطلوب');
  if (student.name.length > 120)
    errors.push('اسم الطالب أطول من الحد المسموح (120 حرفًا)');
  if (student.phone.length > 40)
    errors.push('رقم هاتف الطالب أطول من الحد المسموح (40 حرفًا)');
  if (student.guardianPhone.length > 40)
    errors.push('رقم هاتف ولي الأمر أطول من الحد المسموح (40 حرفًا)');
  if (student.grade.length > 80)
    errors.push('الصف الدراسي أطول من الحد المسموح (80 حرفًا)');
  if (student.notes.length > 1000)
    errors.push('الملاحظات أطول من الحد المسموح (1000 حرف)');
  return errors;
}

export async function importStudents(request, response) {
  const { groupId, students } = request.body || {};
  const numericGroupId = Number(groupId);
  if (!Number.isSafeInteger(numericGroupId) || numericGroupId < 1) {
    return response
      .status(400)
      .json({ error: 'اختر مجموعة صحيحة لإضافة الطلاب إليها.' });
  }
  if (
    !Array.isArray(students) ||
    students.length < 1 ||
    students.length > MAX_IMPORT_STUDENTS
  ) {
    return response.status(400).json({
      error: 'يجب إرسال من طالب واحد إلى 500 طالب في الدفعة الواحدة.',
    });
  }

  const normalizedRows = students.map((input, index) => {
    const source =
      input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const fields = {};
    for (const field of ['name', 'phone', 'guardianPhone', 'grade', 'notes']) {
      fields[field] = typeof source[field] === 'string' ? source[field].trim() : '';
    }
    const suppliedRowNumber = Number(source.rowNumber);
    const rowNumber =
      Number.isSafeInteger(suppliedRowNumber) && suppliedRowNumber > 0
        ? suppliedRowNumber
        : index + 2;
    return { ...fields, rowNumber, errors: getRowErrors(fields, source) };
  });

  let result;
  try {
    result = await withTransaction(async (client) => {
      const group = await client.query(
        'SELECT id FROM groups WHERE id = $1 AND active = TRUE',
        [numericGroupId],
      );
      if (!group.rowCount) {
        return { groupMissing: true, added: 0, errors: [] };
      }

      const existingContacts = new Map();
      const activeStudents = await client.query(
        `SELECT name, phone, guardian_phone AS "guardianPhone"
         FROM students WHERE active = TRUE`,
      );
      for (const existing of activeStudents.rows) {
        const name = normalizeName(existing.name);
        const contacts = [
          normalizeContact(existing.phone),
          normalizeContact(existing.guardianPhone),
        ].filter(Boolean);
        if (!name || !contacts.length) continue;
        const knownContacts = existingContacts.get(name) || new Set();
        contacts.forEach((contact) => knownContacts.add(contact));
        existingContacts.set(name, knownContacts);
      }

      const importedContacts = new Map();
      const errors = [];
      let added = 0;
      let skipped = 0;

      for (const student of normalizedRows) {
        if (student.errors.length) {
          errors.push({
            rowNumber: student.rowNumber,
            error: student.errors.join('، '),
          });
          skipped += 1;
          continue;
        }

        const normalizedStudentName = normalizeName(student.name);
        const contacts = [
          normalizeContact(student.phone),
          normalizeContact(student.guardianPhone),
        ].filter(Boolean);
        const duplicateInDatabase = contacts.some((contact) =>
          existingContacts.get(normalizedStudentName)?.has(contact),
        );
        const duplicateInBatch = contacts.some((contact) =>
          importedContacts.get(normalizedStudentName)?.has(contact),
        );

        if (duplicateInDatabase || duplicateInBatch) {
          errors.push({
            rowNumber: student.rowNumber,
            error:
              'الطالب موجود بالفعل (الاسم ورقم الهاتف متطابقان)، ولم يتم تعديل بياناته.',
          });
          skipped += 1;
          continue;
        }

        const inserted = await client.query(
          `INSERT INTO students (name, phone, grade, guardian_phone, notes)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [
            student.name,
            student.phone,
            student.grade,
            student.guardianPhone,
            student.notes,
          ],
        );
        await client.query(
          'INSERT INTO enrollments (student_id, group_id) VALUES ($1, $2)',
          [inserted.rows[0].id, numericGroupId],
        );
        added += 1;

        if (contacts.length) {
          const knownExistingContacts =
            existingContacts.get(normalizedStudentName) || new Set();
          contacts.forEach((contact) => knownExistingContacts.add(contact));
          existingContacts.set(normalizedStudentName, knownExistingContacts);
          const knownContacts =
            importedContacts.get(normalizedStudentName) || new Set();
          contacts.forEach((contact) => knownContacts.add(contact));
          importedContacts.set(normalizedStudentName, knownContacts);
        }
      }
      return { groupMissing: false, added, skipped, errors };
    });
  } catch (error) {
    console.error('Student import failed; transaction rolled back.', error);
    return response.status(500).json({
      error: 'تعذر استيراد الطلاب. لم تُحفظ أي بيانات من هذه الدفعة.',
    });
  }

  if (result.groupMissing) {
    return response
      .status(400)
      .json({ error: 'المجموعة غير موجودة أو غير نشطة.' });
  }
  response.json({
    added: result.added,
    skipped: result.skipped,
    errors: result.errors,
  });
}

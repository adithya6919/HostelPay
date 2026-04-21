const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const {
  db, getSetting, getStudentByPhone, getStudent,
  getStudentTransactions, getPendingEBReading, getEBHistory,
  getLatestReading, getStudentsByRoom, calcRent, getRoom
} = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'hostelpay_student_secret';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' }
});

// ── Auth middleware ────────────────────────────────────────
function authStudent(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(header.split(' ')[1], JWT_SECRET);
    req.student = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// ── POST /api/students/login ───────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });

  const clean = phone.replace(/\D/g, '').slice(-10);
  const student = getStudentByPhone(clean);

  if (!student) return res.status(401).json({ error: 'No account found with this phone number' });
  if (!student.active) return res.status(403).json({ error: 'Your account has been deactivated. Please contact admin.' });

  const match = await bcrypt.compare(password, student.password);
  if (!match) return res.status(401).json({ error: 'Incorrect password' });

  db.prepare('UPDATE students SET last_login=? WHERE id=?')
    .run(new Date().toLocaleString('en-IN'), student.id);

  const token = jwt.sign(
    { id: student.id, roll: student.roll, name: student.name },
    JWT_SECRET, { expiresIn: '7d' }
  );

  const { password: _, ...safe } = student;
  res.json({ token, student: safe });
});

// ── GET /api/students/me ───────────────────────────────────
router.get('/me', authStudent, (req, res) => {
  const student = getStudent(req.student.id);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const { password: _, ...safe } = student;

  // Advance calculations
  const advance_remaining = Math.max(0, student.advance_paid - student.advance_used);
  const refundable = Math.max(0, advance_remaining - student.base_hold);

  // Config for portal
  const config = {
    upi_id:    getSetting('upi_id'),
    upi_name:  getSetting('upi_name'),
    prop_name: getSetting('prop_name'),
    wa_number: getSetting('wa_number'),
    due_day:   getSetting('due_day'),
    mess_enabled: getSetting('mess_enabled'),
    currency:  getSetting('currency') || '₹',
    pdf_receipts: getSetting('pdf_receipts'),
  };

  res.json({ student: { ...safe, advance_remaining, refundable }, config });
});

// ── PATCH /api/students/password ──────────────────────────
router.patch('/password', authStudent, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'Both current and new password required' });
  if (new_password.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const student = db.prepare('SELECT * FROM students WHERE id=?').get(req.student.id);
  const match = await bcrypt.compare(current_password, student.password);
  if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

  const hash = await bcrypt.hash(new_password, 10);
  db.prepare('UPDATE students SET password=? WHERE id=?').run(hash, req.student.id);
  res.json({ success: true });
});

// ── GET /api/students/transactions ────────────────────────
router.get('/transactions', authStudent, (req, res) => {
  const txns = getStudentTransactions(req.student.id);
  const total_paid = txns.filter(t => t.status === 'Paid').reduce((s, t) => s + t.amount, 0);
  const pending    = txns.filter(t => t.status === 'Under review' || t.status === 'Pending').length;
  res.json({ transactions: txns, total_paid, pending });
});

// ── POST /api/students/change-request ─────────────────────
router.post('/change-request', authStudent, (req, res) => {
  const { field, new_value, reason } = req.body;
  if (!field || !new_value) return res.status(400).json({ error: 'Field and new value required' });
  if (!['phone', 'room_id', 'name'].includes(field))
    return res.status(400).json({ error: 'Invalid field' });

  const existing = db.prepare(
    `SELECT id FROM change_requests WHERE student_id=? AND field=? AND status='Pending'`
  ).get(req.student.id, field);
  if (existing) return res.status(409).json({ error: 'You already have a pending change request for this field' });

  const student = getStudent(req.student.id);
  const old_value = student[field] || '';

  db.prepare(
    `INSERT INTO change_requests (student_id,field,old_value,new_value,reason) VALUES (?,?,?,?,?)`
  ).run(req.student.id, field, String(old_value), new_value, reason || '');

  res.json({ success: true });
});

// ── POST /api/students/partial-request ────────────────────
router.post('/partial-request', authStudent, (req, res) => {
  const { month, fee_type, amount, reason } = req.body;
  if (!month || !amount || !reason)
    return res.status(400).json({ error: 'Month, amount and reason required' });

  const existing = db.prepare(
    `SELECT id FROM partial_requests WHERE student_id=? AND month=? AND fee_type=? AND status='Pending'`
  ).get(req.student.id, month, fee_type || 'Hostel Rent');
  if (existing) return res.status(409).json({ error: 'You already have a pending partial payment request for this month' });

  db.prepare(
    `INSERT INTO partial_requests (student_id,month,fee_type,amount,reason) VALUES (?,?,?,?,?)`
  ).run(req.student.id, month, fee_type || 'Hostel Rent', parseFloat(amount), reason);

  res.json({ success: true });
});

// ── GET /api/students/eb ──────────────────────────────────
router.get('/eb', authStudent, (req, res) => {
  const student = getStudent(req.student.id);
  if (!student?.room_id) return res.json({ readings: [], pending: null, latest: null });

  const readings = getEBHistory(student.room_id);
  const pending  = getPendingEBReading(student.room_id);
  const latest   = getLatestReading(student.room_id);
  const roommates = getStudentsByRoom(student.room_id).map(s => ({ id: s.id, name: s.name, roll: s.roll }));

  res.json({ readings, pending, latest, roommates });
});

// ── POST /api/students/eb ─────────────────────────────────
router.post('/eb', authStudent, (req, res) => {
  const { current_units, billing_period } = req.body;
  if (!current_units || !billing_period)
    return res.status(400).json({ error: 'Current units and billing period required' });

  const student = getStudent(req.student.id);
  if (!student?.room_id) return res.status(400).json({ error: 'You are not assigned to a room' });

  const pending = getPendingEBReading(student.room_id);
  if (pending) return res.status(409).json({ error: 'A reading request is already pending for your room. Wait for admin to resolve it.' });

  const latest        = getLatestReading(student.room_id);
  const previous_units = latest ? latest.current_units : 0;
  const units_used    = Math.max(0, parseFloat(current_units) - previous_units);
  const rate          = parseFloat(getSetting('eb_rate_per_unit')) || 0;
  const occupants     = getStudentsByRoom(student.room_id).length || 1;
  const total_bill    = units_used * rate;
  const per_person    = Math.ceil(total_bill / occupants);

  db.prepare(`
    INSERT INTO eb_readings
    (room_id,submitted_by,current_units,previous_units,units_used,billing_period,rate_per_unit,total_bill,per_person,occupants)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(student.room_id, req.student.id, parseFloat(current_units), previous_units,
         units_used, billing_period, rate, total_bill, per_person, occupants);

  res.json({ success: true, units_used, total_bill, per_person });
});

module.exports = router;

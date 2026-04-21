const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const jwt     = require('jsonwebtoken');
const { createTransaction, getSetting, getStudentByRoll, db } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'hostelpay_student_secret';

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `ss_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'));
  }
});

function getStudentFromToken(req) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    return jwt.verify(header.split(' ')[1], JWT_SECRET);
  } catch { return null; }
}

// ── POST /api/payments ────────────────────────────────────
router.post('/', upload.single('screenshot'), (req, res) => {
  try {
    const { roll, name, room, phone, fee_type, month, amount, notes, utr } = req.body;
    if (!roll || !name || !room || !phone || !fee_type || !month || !amount)
      return res.status(400).json({ error: 'Missing required fields' });
    if (!/^[A-Z0-9]{2,20}$/.test(roll.toUpperCase()))
      return res.status(400).json({ error: 'Invalid roll number' });
    if (!/^[6-9][0-9]{9}$/.test(phone))
      return res.status(400).json({ error: 'Invalid phone number' });
    if (isNaN(amount) || parseFloat(amount) < 1)
      return res.status(400).json({ error: 'Invalid amount' });
    if (!req.file)
      return res.status(400).json({ error: 'Screenshot is required' });

    // Duplicate check
    const existing = db.prepare(`
      SELECT id, status FROM transactions
      WHERE roll=? AND fee_type=? AND month=?
      AND status IN ('Paid','Under review','Pending')
    `).get(roll.toUpperCase(), fee_type, month);
    if (existing) {
      const msg = existing.status === 'Paid'
        ? `Payment for ${fee_type} in ${month} is already marked as Paid.`
        : `A ${existing.status.toLowerCase()} submission for ${fee_type} in ${month} already exists.`;
      return res.status(409).json({ error: msg });
    }

    // Check for approved partial request
    const partial = db.prepare(`
      SELECT amount FROM partial_requests
      WHERE student_id=(SELECT id FROM students WHERE roll=?) AND month=? AND fee_type=? AND status='Approved'
    `).get(roll.toUpperCase(), month, fee_type);

    const studentPayload = getStudentFromToken(req);
    const student = studentPayload ? { id: studentPayload.id } : null;

    const txn = createTransaction({
      student_id: student?.id || null,
      roll: roll.toUpperCase(),
      name: name.trim(),
      room: room.trim(),
      phone: phone.trim(),
      fee_type,
      month,
      amount: parseFloat(amount),
      notes: notes || '',
      utr: utr || '',
      screenshot: req.file.filename
    });

    res.status(201).json({ success: true, transaction: txn });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/payments/config ──────────────────────────────
router.get('/config', (req, res) => {
  res.json({
    upi_id:    getSetting('upi_id'),
    upi_name:  getSetting('upi_name'),
    prop_name: getSetting('prop_name'),
    wa_number: getSetting('wa_number'),
    due_day:   getSetting('due_day'),
    currency:  getSetting('currency') || '₹',
  });
});

module.exports = router;

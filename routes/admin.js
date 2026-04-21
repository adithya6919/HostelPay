const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const XLSX    = require('xlsx');
const {
  db, getSetting, setSetting, getAllSettings,
  getAllTransactions, getPendingTransactions,
  updateTransactionStatus, deleteTransaction, getStats,
  getStudents, getStudent, getStudentByPhone, getStudentByRoll,
  getStudentTransactions, updateRoomOccupancy, calcRent,
  getRooms, getRoom, getLatestReading, getPendingEBReading, getEBHistory,
  getPartialRequests, getChangeRequests, getStudentsByRoom
} = require('../db');

const JWT_SECRET = process.env.JWT_ADMIN_SECRET || 'hostelpay_admin_secret';

function authAdmin(req, res, next) {
  const header = req.headers.authorization;
  const queryToken = req.query.token;
  const token = queryToken || (header?.startsWith('Bearer ') ? header.split(' ')[1] : null);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ── POST /api/admin/login ──────────────────────────────────
router.post('/login', async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  const hash = getSetting('admin_pin');
  if (!await bcrypt.compare(String(pin), hash))
    return res.status(401).json({ error: 'Incorrect PIN' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// ── Stats ──────────────────────────────────────────────────
router.get('/stats', authAdmin, (req, res) => res.json(getStats()));

// ── Transactions ───────────────────────────────────────────
router.get('/transactions', authAdmin, (req, res) => {
  let txns = getAllTransactions();
  if (req.query.status && req.query.status !== 'All')
    txns = txns.filter(t => t.status === req.query.status);
  res.json(txns.map(t => ({ ...t, screenshot_url: t.screenshot ? `/uploads/${t.screenshot}` : null })));
});

router.get('/pending', authAdmin, (req, res) => {
  const txns = getPendingTransactions().map(t => ({ ...t, screenshot_url: t.screenshot ? `/uploads/${t.screenshot}` : null }));
  res.json(txns);
});

router.patch('/transactions/:id/approve', authAdmin, (req, res) => {
  const txn = updateTransactionStatus(req.params.id, 'Paid', {
    paid_on: new Date().toLocaleDateString('en-IN')
  });
  res.json(txn);
});

router.patch('/transactions/:id/reject', authAdmin, (req, res) => {
  const txn = updateTransactionStatus(req.params.id, 'Rejected', { rej_reason: req.body.reason || '' });
  res.json(txn);
});

router.delete('/transactions/:id', authAdmin, (req, res) => {
  deleteTransaction(req.params.id); res.json({ success: true });
});

// ── Export ─────────────────────────────────────────────────
router.get('/export/xlsx', authAdmin, (req, res) => {
  const txns = getAllTransactions();
  const data = txns.map(t => ({
    'Date': t.created_at, 'Roll No.': t.roll, 'Name': t.name,
    'Room': t.room, 'Phone': '+91'+t.phone, 'Fee type': t.fee_type,
    'Month': t.month, 'Amount (₹)': t.amount, 'UTR': t.utr||'',
    'Status': t.status, 'Paid On': t.paid_on||'', 'Rejection reason': t.rej_reason||''
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{wch:18},{wch:12},{wch:18},{wch:8},{wch:14},{wch:16},{wch:14},{wch:12},{wch:20},{wch:12},{wch:12},{wch:20}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ledger');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=hostel_ledger.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/export/csv', authAdmin, (req, res) => {
  const txns = getAllTransactions();
  const hdr = ['Date','Roll No.','Name','Room','Phone','Fee type','Month','Amount','UTR','Status','Paid On','Rejection reason'];
  const rows = txns.map(t => [t.created_at,t.roll,t.name,t.room,'+91'+t.phone,t.fee_type,t.month,t.amount,t.utr||'',t.status,t.paid_on||'',t.rej_reason||'']);
  const csv = [hdr,...rows].map(r => r.map(c => `"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Disposition', 'attachment; filename=hostel_payments.csv');
  res.setHeader('Content-Type', 'text/csv');
  res.send(csv);
});

// ── Settings ───────────────────────────────────────────────
router.get('/settings', authAdmin, (req, res) => res.json(getAllSettings()));

router.post('/settings', authAdmin, async (req, res) => {
  const allowed = ['upi_id','upi_name','prop_name','prop_address','wa_number','due_day',
    'eb_rate_per_unit','eb_billing_cycle','eb_payment_mode','mess_enabled',
    'late_fee_enabled','late_fee_amount','pdf_receipts','currency'];
  allowed.forEach(k => { if (req.body[k] !== undefined) setSetting(k, req.body[k]); });
  if (req.body.new_pin) setSetting('admin_pin', await bcrypt.hash(String(req.body.new_pin), 10));
  res.json({ success: true, settings: getAllSettings() });
});

// ── Rooms ──────────────────────────────────────────────────
router.get('/rooms', authAdmin, (req, res) => {
  const rooms = getRooms();
  res.json(rooms.map(r => ({ ...r, calculated_rent: calcRent(r) })));
});

router.patch('/rooms/:id', authAdmin, (req, res) => {
  const { total_cost, legacy_fixed, legacy_price, max_occupancy } = req.body;
  db.prepare(`UPDATE rooms SET total_cost=COALESCE(?,total_cost), legacy_fixed=COALESCE(?,legacy_fixed),
    legacy_price=COALESCE(?,legacy_price), max_occupancy=COALESCE(?,max_occupancy) WHERE id=?`)
    .run(total_cost||null, legacy_fixed??null, legacy_price||null, max_occupancy||null, req.params.id);
  res.json({ success: true });
});

// ── Students ───────────────────────────────────────────────
router.get('/students', authAdmin, (req, res) => {
  const students = getStudents();
  const month = req.query.month || '';
  const result = students.map(s => {
    const { password: _, ...safe } = s;
    let month_status = 'no_record';
    if (month) {
      const txn = db.prepare(
        `SELECT status FROM transactions WHERE student_id=? AND month=? AND fee_type='Hostel Rent' ORDER BY created_at DESC LIMIT 1`
      ).get(s.id, month);
      if (txn) month_status = txn.status === 'Paid' ? 'paid' : 'pending';
    }
    return { ...safe, month_status };
  });
  res.json(result);
});

router.get('/students/:id', authAdmin, (req, res) => {
  const s = getStudent(req.params.id);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  const { password: _, ...safe } = s;
  const txns = getStudentTransactions(s.id);
  const total_paid = txns.filter(t => t.status==='Paid').reduce((sum,t) => sum+t.amount, 0);
  const advance_remaining = Math.max(0, s.advance_paid - s.advance_used);
  const refundable = Math.max(0, advance_remaining - s.base_hold);
  const change_reqs = db.prepare(`SELECT * FROM change_requests WHERE student_id=? ORDER BY created_at DESC`).all(s.id);
  const partial_reqs = db.prepare(`SELECT * FROM partial_requests WHERE student_id=? ORDER BY created_at DESC`).all(s.id);
  res.json({ student: { ...safe, advance_remaining, refundable, total_paid }, transactions: txns, change_requests: change_reqs, partial_requests: partial_reqs });
});

router.post('/students', authAdmin, async (req, res) => {
  const { roll, name, room_id, phone, joined_at, notes, monthly_rent, advance_paid } = req.body;
  if (!roll || !name || !phone) return res.status(400).json({ error: 'Roll, name and phone required' });
  const cleanPhone = phone.replace(/\D/g,'').slice(-10);
  if (!/^[6-9][0-9]{9}$/.test(cleanPhone)) return res.status(400).json({ error: 'Invalid phone number' });

  // Default password = roll number
  const password = await bcrypt.hash(roll.toUpperCase(), 10);
  try {
    const r = db.prepare(`
      INSERT INTO students (roll,name,room_id,phone,password,monthly_rent,advance_paid,joined_at,notes)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(roll.toUpperCase(), name.trim(), room_id||null, cleanPhone, password,
           parseFloat(monthly_rent)||0, parseFloat(advance_paid)||15000,
           joined_at||new Date().toLocaleDateString('en-IN'), notes||'');

    if (room_id) updateRoomOccupancy(room_id);

    // Recalculate rents for room
    if (room_id) recalcRoomRents(room_id);

    const student = getStudent(r.lastInsertRowid);
    const { password:_,...safe } = student;
    res.status(201).json({ success: true, student: safe, temp_password: roll.toUpperCase() });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Roll number or phone already exists' });
    throw err;
  }
});

router.patch('/students/:id', authAdmin, async (req, res) => {
  const { name, roll, phone, room_id, active, notes, monthly_rent, advance_paid,
          advance_used, is_legacy_pricing, joined_at, mess_enabled } = req.body;
  const s = getStudent(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });

  const old_room = s.room_id;

  db.prepare(`UPDATE students SET
    name=COALESCE(?,name), roll=COALESCE(?,roll), phone=COALESCE(?,phone),
    room_id=COALESCE(?,room_id), active=COALESCE(?,active), notes=COALESCE(?,notes),
    monthly_rent=COALESCE(?,monthly_rent), advance_paid=COALESCE(?,advance_paid),
    advance_used=COALESCE(?,advance_used), is_legacy_pricing=COALESCE(?,is_legacy_pricing),
    joined_at=COALESCE(?,joined_at), mess_enabled=COALESCE(?,mess_enabled)
    WHERE id=?`).run(
    name||null, roll?.toUpperCase()||null, phone?.replace(/\D/g,'').slice(-10)||null,
    room_id||null, active??null, notes||null, monthly_rent||null, advance_paid||null,
    advance_used||null, is_legacy_pricing??null, joined_at||null, mess_enabled??null,
    req.params.id
  );

  // Update room occupancy if room changed
  if (room_id && room_id !== old_room) {
    if (old_room) { updateRoomOccupancy(old_room); recalcRoomRents(old_room); }
    updateRoomOccupancy(room_id);
    recalcRoomRents(room_id);
  }

  res.json({ success: true, student: getStudent(req.params.id) });
});

router.post('/students/:id/reset-password', authAdmin, async (req, res) => {
  const s = getStudent(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const temp = s.roll;
  const hash = await bcrypt.hash(temp, 10);
  db.prepare('UPDATE students SET password=? WHERE id=?').run(hash, req.params.id);
  res.json({ success: true, temp_password: temp });
});

router.delete('/students/:id', authAdmin, (req, res) => {
  const s = getStudent(req.params.id);
  if (s?.room_id) { updateRoomOccupancy(s.room_id); recalcRoomRents(s.room_id); }
  db.prepare('DELETE FROM students WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

function recalcRoomRents(roomId) {
  const room = getRoom(roomId);
  if (!room || room.legacy_fixed) return;
  const rent = calcRent(room);
  db.prepare(`UPDATE students SET monthly_rent=? WHERE room_id=? AND active=1 AND is_legacy_pricing=0`)
    .run(rent, roomId);
}

// ── Change requests ────────────────────────────────────────
router.get('/change-requests', authAdmin, (req, res) => {
  res.json(getChangeRequests(req.query.status || null));
});

router.patch('/change-requests/:id/approve', authAdmin, (req, res) => {
  const cr = db.prepare('SELECT * FROM change_requests WHERE id=?').get(req.params.id);
  if (!cr) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE students SET ${cr.field}=? WHERE id=?`).run(cr.new_value, cr.student_id);
  db.prepare(`UPDATE change_requests SET status='Approved', resolved_at=? WHERE id=?`)
    .run(new Date().toLocaleString('en-IN'), req.params.id);
  res.json({ success: true });
});

router.patch('/change-requests/:id/reject', authAdmin, (req, res) => {
  db.prepare(`UPDATE change_requests SET status='Rejected', resolved_at=? WHERE id=?`)
    .run(new Date().toLocaleString('en-IN'), req.params.id);
  res.json({ success: true });
});

// ── Partial payment requests ───────────────────────────────
router.get('/partial-requests', authAdmin, (req, res) => {
  res.json(getPartialRequests(req.query.status || null));
});

router.patch('/partial-requests/:id/approve', authAdmin, (req, res) => {
  db.prepare(`UPDATE partial_requests SET status='Approved', resolved_at=? WHERE id=?`)
    .run(new Date().toLocaleString('en-IN'), req.params.id);
  res.json({ success: true });
});

router.patch('/partial-requests/:id/reject', authAdmin, (req, res) => {
  db.prepare(`UPDATE partial_requests SET status='Rejected', admin_note=?, resolved_at=? WHERE id=?`)
    .run(req.body.note||'', new Date().toLocaleString('en-IN'), req.params.id);
  res.json({ success: true });
});

// ── EB routes ──────────────────────────────────────────────
router.get('/eb', authAdmin, (req, res) => {
  const rooms = getRooms();
  const result = rooms.map(r => ({
    ...r,
    latest_reading: getLatestReading(r.id),
    pending_reading: getPendingEBReading(r.id),
    occupants: db.prepare(`SELECT COUNT(*) as c FROM students WHERE room_id=? AND active=1`).get(r.id).c
  }));
  res.json(result);
});

router.get('/eb/:roomId/history', authAdmin, (req, res) => {
  res.json(getEBHistory(req.params.roomId));
});

router.patch('/eb/:id/approve', authAdmin, (req, res) => {
  const reading = db.prepare('SELECT * FROM eb_readings WHERE id=?').get(req.params.id);
  if (!reading) return res.status(404).json({ error: 'Not found' });
  const rate = parseFloat(getSetting('eb_rate_per_unit')) || 0;
  const total_bill = reading.units_used * rate;
  const per_person = Math.ceil(total_bill / reading.occupants);
  db.prepare(`UPDATE eb_readings SET status='Approved', rate_per_unit=?, total_bill=?, per_person=?, resolved_at=? WHERE id=?`)
    .run(rate, total_bill, per_person, new Date().toLocaleString('en-IN'), req.params.id);

  // Create EB transactions for each occupant
  const payMode = getSetting('eb_payment_mode');
  const occupants = db.prepare(`SELECT s.*, r.room_number FROM students s JOIN rooms r ON s.room_id=r.id WHERE s.room_id=? AND s.active=1`).all(reading.room_id);
  if (payMode === 'individual') {
    occupants.forEach(s => {
      db.prepare(`INSERT INTO transactions (student_id,roll,name,room,phone,fee_type,month,amount,notes,status)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        s.id, s.roll, s.name, s.room_number, s.phone,
        'Electricity Bill', reading.billing_period, per_person,
        `EB: ${reading.units_used} units @ ₹${rate}/unit`, 'Pending'
      );
    });
  }
  res.json({ success: true, total_bill, per_person });
});

router.patch('/eb/:id/reject', authAdmin, (req, res) => {
  db.prepare(`UPDATE eb_readings SET status='Rejected', admin_note=?, resolved_at=? WHERE id=?`)
    .run(req.body.note||'', new Date().toLocaleString('en-IN'), req.params.id);
  res.json({ success: true });
});

// ── Broadcast WhatsApp log ─────────────────────────────────
router.post('/broadcast', authAdmin, (req, res) => {
  const { message, recipient_count } = req.body;
  db.prepare('INSERT INTO broadcast_log (message,recipient_count) VALUES (?,?)').run(message, recipient_count||0);
  res.json({ success: true });
});

module.exports = router;

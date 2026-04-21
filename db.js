const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcrypt');

const db = new Database(path.join(__dirname, 'hostelpay.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    room_number      TEXT NOT NULL UNIQUE,
    room_type        TEXT NOT NULL,
    total_cost       REAL NOT NULL DEFAULT 0,
    max_occupancy    INTEGER NOT NULL DEFAULT 2,
    current_occupancy INTEGER NOT NULL DEFAULT 0,
    legacy_fixed     INTEGER NOT NULL DEFAULT 0,
    legacy_price     REAL NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS students (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    roll             TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    room_id          INTEGER REFERENCES rooms(id),
    phone            TEXT NOT NULL UNIQUE,
    password         TEXT NOT NULL,
    monthly_rent     REAL NOT NULL DEFAULT 0,
    advance_paid     REAL NOT NULL DEFAULT 15000,
    advance_used     REAL NOT NULL DEFAULT 0,
    base_hold        REAL NOT NULL DEFAULT 5000,
    is_legacy_pricing INTEGER NOT NULL DEFAULT 0,
    mess_enabled     INTEGER NOT NULL DEFAULT 0,
    active           INTEGER NOT NULL DEFAULT 1,
    notes            TEXT DEFAULT '',
    last_login       TEXT,
    joined_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id   INTEGER REFERENCES students(id),
    roll         TEXT NOT NULL,
    name         TEXT NOT NULL,
    room         TEXT NOT NULL,
    phone        TEXT NOT NULL,
    fee_type     TEXT NOT NULL,
    month        TEXT NOT NULL,
    amount       REAL NOT NULL,
    notes        TEXT,
    utr          TEXT,
    status       TEXT NOT NULL DEFAULT 'Under review',
    screenshot   TEXT,
    paid_on      TEXT,
    rej_reason   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS eb_readings (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id          INTEGER NOT NULL REFERENCES rooms(id),
    submitted_by     INTEGER NOT NULL REFERENCES students(id),
    current_units    REAL NOT NULL,
    previous_units   REAL NOT NULL DEFAULT 0,
    units_used       REAL NOT NULL DEFAULT 0,
    billing_period   TEXT NOT NULL,
    rate_per_unit    REAL NOT NULL DEFAULT 0,
    total_bill       REAL NOT NULL DEFAULT 0,
    per_person       REAL NOT NULL DEFAULT 0,
    occupants        INTEGER NOT NULL DEFAULT 1,
    status           TEXT NOT NULL DEFAULT 'Pending',
    admin_note       TEXT,
    submitted_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    resolved_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS partial_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id   INTEGER NOT NULL REFERENCES students(id),
    month        TEXT NOT NULL,
    fee_type     TEXT NOT NULL DEFAULT 'Hostel Rent',
    amount       REAL NOT NULL,
    reason       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'Pending',
    admin_note   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    resolved_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS change_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id   INTEGER NOT NULL REFERENCES students(id),
    field        TEXT NOT NULL,
    old_value    TEXT NOT NULL,
    new_value    TEXT NOT NULL,
    reason       TEXT,
    status       TEXT NOT NULL DEFAULT 'Pending',
    created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    resolved_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS broadcast_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    message        TEXT NOT NULL,
    recipient_count INTEGER NOT NULL DEFAULT 0,
    sent_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

// ── Seed settings ──────────────────────────────────────────
const seed = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
seed.run('upi_id',           'hostel@upi');
seed.run('upi_name',         'Hostel');
seed.run('prop_name',        'My PG');
seed.run('prop_address',     '');
seed.run('wa_number',        '');
seed.run('admin_pin',        bcrypt.hashSync('1234', 10));
seed.run('due_day',          '5');
seed.run('eb_rate_per_unit', '0');
seed.run('eb_billing_cycle', 'monthly');
seed.run('eb_payment_mode',  'single');
seed.run('mess_enabled',     '0');
seed.run('late_fee_enabled', '0');
seed.run('late_fee_amount',  '0');
seed.run('pdf_receipts',     '1');
seed.run('currency',         '₹');

// ── Seed rooms ─────────────────────────────────────────────
const seedRoom = db.prepare(`
  INSERT OR IGNORE INTO rooms (room_number,room_type,total_cost,max_occupancy,legacy_fixed,legacy_price)
  VALUES (?,?,?,?,?,?)
`);
seedRoom.run('101', '4-5 sharing', 20000, 5, 0, 0);
seedRoom.run('102', '4-5 sharing', 20000, 5, 0, 0);
seedRoom.run('103', '4-5 sharing', 20000, 5, 0, 0);
seedRoom.run('104', '8 sharing',   40000, 8, 0, 0);
seedRoom.run('105', '10 sharing',  40000, 10, 1, 4000);
seedRoom.run('106', '2 sharing',   0,     2, 1, 4500);
seedRoom.run('107', '2 sharing',   0,     2, 1, 4500);

// ── Settings helpers ───────────────────────────────────────
function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, String(value));
}
function getAllSettings() {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const out = {};
  rows.forEach(r => out[r.key] = r.value);
  delete out.admin_pin;
  return out;
}

// ── Room helpers ───────────────────────────────────────────
function getRooms() {
  return db.prepare('SELECT * FROM rooms ORDER BY room_number').all();
}
function getRoom(id) {
  return db.prepare('SELECT * FROM rooms WHERE id=?').get(id);
}
function getRoomByNumber(num) {
  return db.prepare('SELECT * FROM rooms WHERE room_number=?').get(num);
}
function calcRent(room) {
  if (!room) return 0;
  if (room.legacy_fixed) return room.legacy_price;
  if (room.current_occupancy === 0) return 0;
  const raw = room.total_cost / room.current_occupancy;
  return Math.ceil(raw / 100) * 100;
}
function updateRoomOccupancy(roomId) {
  const count = db.prepare(
    `SELECT COUNT(*) as c FROM students WHERE room_id=? AND active=1`
  ).get(roomId);
  db.prepare('UPDATE rooms SET current_occupancy=? WHERE id=?')
    .run(count.c, roomId);
}

// ── Student helpers ────────────────────────────────────────
function getStudents() {
  return db.prepare(`
    SELECT s.*, r.room_number, r.room_type, r.total_cost, r.max_occupancy,
           r.current_occupancy, r.legacy_fixed, r.legacy_price
    FROM students s LEFT JOIN rooms r ON s.room_id=r.id
    ORDER BY s.name
  `).all();
}
function getStudent(id) {
  return db.prepare(`
    SELECT s.*, r.room_number, r.room_type, r.total_cost, r.max_occupancy,
           r.current_occupancy, r.legacy_fixed, r.legacy_price
    FROM students s LEFT JOIN rooms r ON s.room_id=r.id
    WHERE s.id=?
  `).get(id);
}
function getStudentByPhone(phone) {
  return db.prepare(`
    SELECT s.*, r.room_number, r.room_type
    FROM students s LEFT JOIN rooms r ON s.room_id=r.id
    WHERE s.phone=?
  `).get(phone);
}
function getStudentByRoll(roll) {
  return db.prepare(`
    SELECT s.*, r.room_number, r.room_type
    FROM students s LEFT JOIN rooms r ON s.room_id=r.id
    WHERE s.roll=?
  `).get(roll);
}
function getStudentsByRoom(roomId) {
  return db.prepare(
    `SELECT * FROM students WHERE room_id=? AND active=1`
  ).all(roomId);
}

// ── Transaction helpers ────────────────────────────────────
function createTransaction(data) {
  const r = db.prepare(`
    INSERT INTO transactions
    (student_id,roll,name,room,phone,fee_type,month,amount,notes,utr,screenshot)
    VALUES (@student_id,@roll,@name,@room,@phone,@fee_type,@month,@amount,@notes,@utr,@screenshot)
  `).run(data);
  return db.prepare('SELECT * FROM transactions WHERE id=?').get(r.lastInsertRowid);
}
function getTransaction(id) {
  return db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
}
function getAllTransactions() {
  return db.prepare('SELECT * FROM transactions ORDER BY created_at DESC').all();
}
function getPendingTransactions() {
  return db.prepare(
    `SELECT * FROM transactions WHERE status IN ('Under review','Pending') ORDER BY created_at DESC`
  ).all();
}
function getStudentTransactions(studentId) {
  return db.prepare(
    `SELECT * FROM transactions WHERE student_id=? ORDER BY created_at DESC`
  ).all(studentId);
}
function updateTransactionStatus(id, status, extra = {}) {
  db.prepare(`
    UPDATE transactions SET status=?,
    paid_on=COALESCE(?,paid_on), rej_reason=COALESCE(?,rej_reason)
    WHERE id=?
  `).run(status, extra.paid_on||null, extra.rej_reason||null, id);
  return getTransaction(id);
}
function deleteTransaction(id) {
  db.prepare('DELETE FROM transactions WHERE id=?').run(id);
}

// ── Stats ──────────────────────────────────────────────────
function getStats() {
  const collected = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE status='Paid'`
  ).get();
  const pending = db.prepare(
    `SELECT COUNT(*) as count FROM transactions WHERE status IN ('Under review','Pending')`
  ).get();
  const total = db.prepare('SELECT COUNT(*) as count FROM transactions').get();
  const rooms = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN current_occupancy>0 THEN 1 ELSE 0 END) as occupied FROM rooms').get();
  const overdue_count = db.prepare(
    `SELECT COUNT(DISTINCT student_id) as c FROM transactions WHERE status IN ('Under review','Pending')`
  ).get();
  return {
    collected: collected.total,
    pending: pending.count,
    total: total.count,
    total_rooms: rooms.total,
    occupied_rooms: rooms.occupied,
    vacant_rooms: rooms.total - rooms.occupied,
  };
}

// ── EB helpers ─────────────────────────────────────────────
function getLatestReading(roomId) {
  return db.prepare(
    `SELECT * FROM eb_readings WHERE room_id=? AND status='Approved' ORDER BY submitted_at DESC LIMIT 1`
  ).get(roomId);
}
function getPendingEBReading(roomId) {
  return db.prepare(
    `SELECT * FROM eb_readings WHERE room_id=? AND status='Pending'`
  ).get(roomId);
}
function getEBHistory(roomId) {
  return db.prepare(
    `SELECT e.*, s.name as submitter_name FROM eb_readings e
     JOIN students s ON e.submitted_by=s.id
     WHERE e.room_id=? ORDER BY e.submitted_at DESC`
  ).all(roomId);
}

// ── Partial requests ───────────────────────────────────────
function getPartialRequests(status) {
  const q = status
    ? `SELECT p.*, s.name, s.roll FROM partial_requests p JOIN students s ON p.student_id=s.id WHERE p.status=? ORDER BY p.created_at DESC`
    : `SELECT p.*, s.name, s.roll FROM partial_requests p JOIN students s ON p.student_id=s.id ORDER BY p.created_at DESC`;
  return status ? db.prepare(q).all(status) : db.prepare(q).all();
}

// ── Change requests ────────────────────────────────────────
function getChangeRequests(status) {
  const q = status
    ? `SELECT c.*, s.name, s.roll FROM change_requests c JOIN students s ON c.student_id=s.id WHERE c.status=? ORDER BY c.created_at DESC`
    : `SELECT c.*, s.name, s.roll FROM change_requests c JOIN students s ON c.student_id=s.id ORDER BY c.created_at DESC`;
  return status ? db.prepare(q).all(status) : db.prepare(q).all();
}

module.exports = {
  db, getSetting, setSetting, getAllSettings,
  getRooms, getRoom, getRoomByNumber, calcRent, updateRoomOccupancy,
  getStudents, getStudent, getStudentByPhone, getStudentByRoll, getStudentsByRoom,
  createTransaction, getTransaction, getAllTransactions, getPendingTransactions,
  getStudentTransactions, updateTransactionStatus, deleteTransaction,
  getStats, getLatestReading, getPendingEBReading, getEBHistory,
  getPartialRequests, getChangeRequests
};

const express = require('express');
const cors    = require('cors');
const path    = require('path');

require('./db'); // initialise DB

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/payments', require('./routes/payments'));
app.use('/api/students', require('./routes/students'));
app.use('/api/admin',    require('./routes/admin'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Route pages
app.get('/',              (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.get('/admin',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin.html',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/student.html',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));

app.listen(PORT, () => {
  console.log(`\n  HostelPay v2 running`);
  console.log(`  Student portal: http://localhost:${PORT}`);
  console.log(`  Admin console:  http://localhost:${PORT}/admin`);
  console.log(`  Default admin PIN: 1234\n`);
});

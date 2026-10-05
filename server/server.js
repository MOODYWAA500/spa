const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// الاتصال بقاعدة بيانات Neon PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// التحقق من الاتصال عند تشغيل السيرفر
pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err.stack);
  }
  console.log('✅ تم الاتصال بنجاح بقاعدة بيانات Neon السحابية!');
  release();
});

/* ==========================================================================
   1. تهيئة قاعدة البيانات والجداول الأولية (Setup & Seed Data)
   ========================================================================== */

// تهيئة أنواع ENUM والجداول والخدمات
app.get('/api/init-db', async (req, res) => {
  try {
    // إنشاء أنواع الـ ENUM في حال عدم وجودها
    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE user_role AS ENUM ('client', 'therapist', 'driver', 'admin');
      EXCEPTION WHEN duplicate_object THEN null; END $$;

      DO $$ BEGIN
        CREATE TYPE booking_status AS ENUM ('pending', 'assigned', 'on_the_way', 'arrived', 'in_progress', 'completed', 'cancelled');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    // إنشاء الجداول
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name VARCHAR(100) NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(100),
        role user_role NOT NULL DEFAULT 'client',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,
        title VARCHAR(100) NOT NULL,
        description TEXT,
        duration_minutes INT NOT NULL,
        price DECIMAL(10, 2) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES users(id) ON DELETE CASCADE,
        therapist_id UUID REFERENCES users(id) ON DELETE SET NULL,
        driver_id UUID REFERENCES users(id) ON DELETE SET NULL,
        service_id INT REFERENCES services(id),
        people_count INT DEFAULT 1,
        booking_date DATE NOT NULL,
        booking_time TIME NOT NULL,
        location_address TEXT NOT NULL,
        notes TEXT,
        status booking_status DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // إضافة خدمات أولية إذا كان الجدول فارغاً
    const checkServices = await pool.query('SELECT COUNT(*) FROM services');
    if (parseInt(checkServices.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO services (title, description, duration_minutes, price) VALUES
        ('مساج استرخائي (Swedish)', 'جلسة مساج ناعم لتخفيف التوتر وإراحة العضلات', 60, 350.00),
        ('مساج الأنسجة العميقة (Deep Tissue)', 'تركيز على طبقات العضلات العميقة لفك التعقدات', 90, 450.00),
        ('مساج بالأحجار الدافئة', 'استخدام أحجار بركانية دافئة لتنشيط الدورة الدموية', 60, 400.00);
      `);
    }

    res.json({ success: true, message: 'تم تهيئة وتجهيز الجداول والبيانات الأساسية بنجاح!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// مسار إدخال الموظفين التجريبيين (معالجات وسائقين)
app.get('/api/seed-staff', async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO users (full_name, phone, role) VALUES
      ('سارة أحمد', '0501111111', 'therapist'),
      ('منى محمود', '0502222222', 'therapist'),
      ('خالد عبد الله', '0503333333', 'driver'),
      ('أحمد علي', '0504444444', 'driver')
      ON CONFLICT (phone) DO NOTHING;
    `);
    res.json({ success: true, message: 'تم إضافة الموظفين التجريبيين بنجاح!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ==========================================================================
   2. مسارات تطبيق العميل (Client APIs)
   ========================================================================== */

// جلب قائمة الخدمات المتاحة
app.get('/api/services', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM services ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// إنشاء حجز جديد من العميل
app.post('/api/bookings', async (req, res) => {
  const { full_name, phone, service_id, people_count, booking_date, booking_time, location_address, notes } = req.body;

  try {
    let userResult = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    let userId;

    if (userResult.rows.length === 0) {
      const newUser = await pool.query(
        'INSERT INTO users (full_name, phone, role) VALUES ($1, $2, $3) RETURNING id',
        [full_name, phone, 'client']
      );
      userId = newUser.rows[0].id;
    } else {
      userId = userResult.rows[0].id;
    }

    const newBooking = await pool.query(
      `INSERT INTO bookings (client_id, service_id, people_count, booking_date, booking_time, location_address, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [userId, service_id, people_count || 1, booking_date, booking_time, location_address, notes, 'pending']
    );

    res.status(201).json({
      success: true,
      message: 'تم تسجيل طلب الحجز بنجاح',
      booking: newBooking.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ==========================================================================
   3. مسارات لوحة الإدارة والموظفين (Admin & Staff APIs)
   ========================================================================== */

// جلب جميع الحجوزات مع التفاصيل
app.get('/api/admin/bookings', async (req, res) => {
  try {
    const query = `
      SELECT 
        b.id, b.booking_date, b.booking_time, b.location_address, b.status, b.notes, b.people_count,
        b.therapist_id, b.driver_id,
        c.full_name AS client_name, c.phone AS client_phone,
        s.title AS service_title, s.price AS service_price,
        t.full_name AS therapist_name,
        d.full_name AS driver_name
      FROM bookings b
      LEFT JOIN users c ON b.client_id = c.id
      LEFT JOIN services s ON b.service_id = s.id
      LEFT JOIN users t ON b.therapist_id = t.id
      LEFT JOIN users d ON b.driver_id = d.id
      ORDER BY b.created_at DESC
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب قائمة الموظفين (معالجات وسائقين)
app.get('/api/admin/staff', async (req, res) => {
  try {
    const result = await pool.query("SELECT id, full_name, role FROM users WHERE role IN ('therapist', 'driver')");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// تعيين المعالجة والسائق للحجز وتحديث الحالة بأمان
app.put('/api/admin/bookings/:id/assign', async (req, res) => {
  const { id } = req.params;
  const { therapist_id, driver_id, status } = req.body;

  try {
    // 1. التحقق من وجود الحجز المسبق
    const currentBooking = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
    if (currentBooking.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'الحجز غير موجود' });
    }

    const existing = currentBooking.rows[0];

    // 2. تحديث الحقول فقط في حال تمرير قيم جديدة صحيحة
    const finalTherapistId = (therapist_id && therapist_id !== 'undefined' && therapist_id !== 'null') 
      ? therapist_id 
      : existing.therapist_id;

    const finalDriverId = (driver_id && driver_id !== 'undefined' && driver_id !== 'null') 
      ? driver_id 
      : existing.driver_id;

    const finalStatus = status || existing.status;

    // 3. تنفيذ التحديث على قاعدة البيانات
    const updated = await pool.query(
      `UPDATE bookings 
       SET therapist_id = $1, driver_id = $2, status = $3 
       WHERE id = $4 RETURNING *`,
      [finalTherapistId, finalDriverId, finalStatus, id]
    );

    res.json({ success: true, booking: updated.rows[0] });
  } catch (err) {
    console.error('Error updating booking:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// تشغيل السيرفر
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل الآن على المنفذ: http://localhost:${PORT}`);
});
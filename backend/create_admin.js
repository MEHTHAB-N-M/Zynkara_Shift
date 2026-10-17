const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./database');

async function setupAccounts() {
  await db.initializeDatabase();

  // 1. Delete all demo / seeded accounts
  const demoResult = await db.query("DELETE FROM users WHERE email LIKE '%@sovereign.local'");
  console.log(`[CLEANUP] Deleted ${demoResult.rowCount} demo account(s).`);

  // 2. Clean up any leftover test accounts if desired
  await db.query("DELETE FROM users WHERE email IN ('testdev1788405549001@gmail.com', 'testgoogle@gmail.com', 'employee@example.com')");

  // 3. Create or update the real admin account
  const email = 'mehthab077@gmail.com';
  const rawPassword = 'M@25&F@22';
  const hashedPassword = await bcrypt.hash(rawPassword, 10);

  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  let userId;
  if (existing.rows.length === 0) {
    userId = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (id, email, hashed_password, subscription_status, access_status, is_admin, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, email, hashedPassword, 'premium', 'approved', true, true]
    );
    console.log(`[ADMIN] Created real admin account for ${email} (ID: ${userId})`);
  } else {
    userId = existing.rows[0].id;
    await db.query(
      `UPDATE users 
       SET hashed_password = $1, subscription_status = $2, access_status = $3, is_admin = $4, is_verified = $5 
       WHERE id = $6`,
      [hashedPassword, 'premium', 'approved', true, true, userId]
    );
    console.log(`[ADMIN] Updated real admin account for ${email} (ID: ${userId})`);
  }

  // 4. Verification test
  const verifyRes = await db.query('SELECT id, email, hashed_password, subscription_status, access_status, is_admin, is_verified FROM users WHERE email = $1', [email]);
  const user = verifyRes.rows[0];
  const isMatch = await bcrypt.compare(rawPassword, user.hashed_password);
  console.log(`[VERIFY] Password verification test passed: ${isMatch}`);
  console.log(`[VERIFY] User Record:`, {
    id: user.id,
    email: user.email,
    subscription_status: user.subscription_status,
    access_status: user.access_status,
    is_admin: user.is_admin,
    is_verified: user.is_verified,
    bcrypt_hash: user.hashed_password
  });

  const remainingUsers = await db.query('SELECT id, email, access_status, is_admin, subscription_status FROM users');
  console.log(`[USERS] Current users in DB:`, remainingUsers.rows);
}

if (require.main === module) {
  setupAccounts()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Setup failed:", err);
      process.exit(1);
    });
}

module.exports = { setupAccounts };

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./database');

async function seedDatabase() {
  // Ensure tables exist
  await db.initializeDatabase();
  // Demo accounts permanently removed / seeding disabled
  console.log("Demo account seeding is permanently disabled.");
}

if (require.main === module) {
  seedDatabase()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error("Seeding failed:", err);
      process.exit(1);
    });
}

module.exports = { seedDatabase };

const axios = require('axios');
const http = require('http');
const db = require('./database');
const bcrypt = require('bcryptjs');

// We will launch server in-process on an ephemeral port or test via supertest / direct http request
const express = require('express');

async function testPhase1() {
  console.log("=== STARTING PHASE 1 & 1.5 INTEGRATION TESTS ===");
  
  // Require our configured server (or import app)
  // Let's spawn or require the server on port 8009 for testing
  process.env.PORT = '8009';
  process.env.JWT_SECRET = 'test_jwt_secret_key_12345';
  
  // Clean up any test users
  await db.query("DELETE FROM users WHERE email LIKE '%@testdomain.com'");
  await db.query("DELETE FROM pending_registrations WHERE email LIKE '%@testdomain.com'");

  const app = require('./server');
  // wait 1.5s for db connection & listen
  await new Promise(r => setTimeout(r, 2000));

  const client = axios.create({
    baseURL: 'http://localhost:8009',
    validateStatus: () => true // don't throw on non-2xx
  });

  // Test 1: Admin login with Mehthab's account
  console.log("\n[TEST 1] Admin login with Mehthab's credentials...");
  const adminLoginRes = await client.post('/api/auth/login', {
    email: 'mehthab077@gmail.com',
    password: 'M@25&F@22'
  });
  console.log("Admin Login Status:", adminLoginRes.status);
  if (adminLoginRes.status !== 200 || !adminLoginRes.data.access_token) {
    throw new Error("Admin login failed: " + JSON.stringify(adminLoginRes.data));
  }
  const adminToken = adminLoginRes.data.access_token;
  console.log("Admin token obtained. User admin status:", adminLoginRes.data.user?.is_admin);

  // Test 2: Verify /api/auth/me returns admin status
  console.log("\n[TEST 2] Verifying /api/auth/me for admin...");
  const adminMeRes = await client.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  console.log("/api/auth/me status:", adminMeRes.status, "is_admin:", adminMeRes.data.is_admin, "access_status:", adminMeRes.data.access_status);
  if (adminMeRes.data.is_admin !== true || adminMeRes.data.access_status !== 'approved') {
    throw new Error("Admin profile incorrect: " + JSON.stringify(adminMeRes.data));
  }

  // Test 3: Register a new user
  console.log("\n[TEST 3] Registering a new candidate user...");
  const testUserEmail = 'candidate@gmail.com';
  // clean up first
  await db.query("DELETE FROM users WHERE email = $1", [testUserEmail]);
  await db.query("DELETE FROM pending_registrations WHERE email = $1", [testUserEmail]);

  const regRes = await client.post('/api/auth/register', {
    email: testUserEmail,
    password: 'Password123!'
  });
  console.log("Register response:", regRes.status, regRes.data);
  const devCode = regRes.data.dev_code;
  if (!devCode) throw new Error("No dev_code received from register");

  // Verify email
  console.log("\n[TEST 4] Verifying email for candidate user...");
  const verifyRes = await client.post('/api/auth/verify', {
    email: testUserEmail,
    code: devCode
  });
  console.log("Verify status:", verifyRes.status, verifyRes.data);
  if (verifyRes.status !== 403 || verifyRes.data.access_status !== 'pending') {
    throw new Error("Expected 403 pending approval on verify, got: " + JSON.stringify(verifyRes.data));
  }

  // Test 5: Candidate user attempts login while pending
  console.log("\n[TEST 5] Candidate attempts login while pending...");
  const pendingLoginRes = await client.post('/api/auth/login', {
    email: testUserEmail,
    password: 'Password123!'
  });
  console.log("Pending Login Status:", pendingLoginRes.status, pendingLoginRes.data);
  if (pendingLoginRes.status !== 403 || pendingLoginRes.data.detail !== "Your access request is pending approval.") {
    throw new Error("Pending login did not return expected 403: " + JSON.stringify(pendingLoginRes.data));
  }

  // Test 6: Admin queries pending access requests
  console.log("\n[TEST 6] Admin listing access requests...");
  const accessRequestsRes = await client.get('/api/admin/access-requests', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  console.log("Access requests count:", accessRequestsRes.data.length);
  const candidateReq = accessRequestsRes.data.find(u => u.email === testUserEmail);
  if (!candidateReq) {
    throw new Error("Candidate user not found in admin access-requests list");
  }
  console.log("Candidate found in pending list: ID =", candidateReq.id);

  // Test 7: Admin approves candidate user
  console.log("\n[TEST 7] Admin approving candidate user...");
  const approveRes = await client.post(`/api/admin/access-requests/${candidateReq.id}/approve`, {}, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  console.log("Approve response status:", approveRes.status, approveRes.data);
  if (approveRes.status !== 200 || approveRes.data.user.access_status !== 'approved' || approveRes.data.user.subscription_status !== 'premium') {
    throw new Error("Approval failed: " + JSON.stringify(approveRes.data));
  }

  // Test 8: Candidate user logs in after approval
  console.log("\n[TEST 8] Candidate logs in after approval...");
  const candidateLoginRes = await client.post('/api/auth/login', {
    email: testUserEmail,
    password: 'Password123!'
  });
  console.log("Candidate Login Status:", candidateLoginRes.status, "Subscription:", candidateLoginRes.data.user?.subscription_status);
  if (candidateLoginRes.status !== 200 || !candidateLoginRes.data.access_token) {
    throw new Error("Approved candidate login failed: " + JSON.stringify(candidateLoginRes.data));
  }
  const candidateToken = candidateLoginRes.data.access_token;

  // Test 9: Candidate (non-admin) tries to call admin endpoints
  console.log("\n[TEST 9] Non-admin tries to access admin endpoint...");
  const unauthorizedAdminCall = await client.get('/api/admin/access-requests', {
    headers: { Authorization: `Bearer ${candidateToken}` }
  });
  console.log("Non-admin call status:", unauthorizedAdminCall.status, unauthorizedAdminCall.data);
  if (unauthorizedAdminCall.status !== 403) {
    throw new Error("Non-admin was not blocked with 403 from admin endpoint!");
  }

  // Test 10: Admin declines candidate user
  console.log("\n[TEST 10] Admin declines candidate user...");
  const declineRes = await client.post(`/api/admin/access-requests/${candidateReq.id}/decline`, {}, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  console.log("Decline status:", declineRes.status, declineRes.data);
  if (declineRes.status !== 200 || declineRes.data.user.access_status !== 'declined') {
    throw new Error("Decline failed: " + JSON.stringify(declineRes.data));
  }

  // Test 11: Declined candidate attempts login
  console.log("\n[TEST 11] Declined candidate attempts login...");
  const declinedLoginRes = await client.post('/api/auth/login', {
    email: testUserEmail,
    password: 'Password123!'
  });
  console.log("Declined Login Status:", declinedLoginRes.status, declinedLoginRes.data);
  if (declinedLoginRes.status !== 403 || declinedLoginRes.data.detail !== "Access request was declined.") {
    throw new Error("Declined user login not properly blocked with 403!");
  }

  // Clean up candidate test user
  await db.query("DELETE FROM users WHERE email = $1", [testUserEmail]);

  console.log("\n>>> ALL PHASE 1 & 1.5 TESTS PASSED SUCCESSFULLY! <<<\n");
  process.exit(0);
}

testPhase1().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const AdmZip = require('adm-zip');
const tar = require('tar-fs');

const db = require('./database');
const OrchestrationService = require('./orchestration');
const { parseChatbotIntent } = require('./chat');
const { detectFramework, synthesizeDockerfile } = require('./buildpacks');
const dns = require('dns').promises;
const { sendVerificationEmail, isSmtpConfigured } = require('./mailer');
const disposableDomainsSet = new Set(require('disposable-email-domains'));
const stripeSecret = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecret ? require('stripe')(stripeSecret) : null;


const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 8000;
const SECRET_KEY = process.env.JWT_SECRET || 'zynkara_secure_jwt_secret_key_default';
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || 'zynkarashift.me';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';

const orchestration = new OrchestrationService();

// Trust reverse proxy (Traefik) for accurate client IP detection & rate limiting
app.set('trust proxy', 1);

// Security Headers via Helmet
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: false, // Don't force HTTPS HSTS headers until SSL certificates are provisioned
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://checkout.stripe.com", "https://checkout.razorpay.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      connectSrc: ["'self'", "https:", "http:", "ws:", "wss:"],
      frameSrc: ["'self'", "https://checkout.stripe.com", "https://api.razorpay.com"],
      upgradeInsecureRequests: null
    }
  }
}));

// Rate Limiters for DDoS & Brute-Force Protection
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each IP to 300 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { detail: "Too many requests from this IP. Please try again after 15 minutes." }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // 60 attempts per 15 mins per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { detail: "Too many authentication attempts. Please try again after 15 minutes." }
});

const deployLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // Limit deployments to 30 per hour per IP to prevent container resource exhaustion
  standardHeaders: true,
  legacyHeaders: false,
  message: { detail: "Deployment rate limit reached. Please wait before deploying again." }
});

// Apply general rate limiter across all API routes
app.use('/api/', generalLimiter);

// Strict CORS Policy - Locked to actual domain & local dev origins (No Wildcard)
const allowedOrigins = [
  `https://${PLATFORM_DOMAIN}`,
  `http://${PLATFORM_DOMAIN}`,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS policy blocked access from origin: ${origin}`));
  },
  credentials: true
}));

// Stripe Webhook needs the raw body, so define this BEFORE express.json()
app.post('/api/subscription/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    return res.status(500).send("Stripe is not configured");
  }
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata && session.metadata.userId;

    if (userId) {
      try {
        await db.query(
          'UPDATE users SET subscription_status = $1 WHERE id = $2',
          ['premium', userId]
        );
        console.log(`User ${userId} successfully upgraded to premium via Stripe Webhook`);
      } catch (err) {
        console.error(`Failed to update subscription status in db for user ${userId}:`, err);
        return res.status(500).json({ error: 'Database update failed' });
      }
    } else {
      console.warn('Stripe Webhook received checkout.session.completed but userId was missing in metadata');
    }
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

// Cookie security helper
function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('zynkara_token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax', // 'strict' in production, 'lax' for local dev compatibility
    maxAge: 2 * 60 * 60 * 1000 // 2 hours
  });
}

function clearAuthCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('zynkara_token', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax'
  });
}

// Load current user from JWT token (Header or httpOnly Cookie)
async function loadCurrentUser(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer <token>
  if (!token && req.cookies && req.cookies.zynkara_token) {
    token = req.cookies.zynkara_token;
  }

  if (!token) {
    return res.status(401).json({ detail: "Authentication credentials not provided or invalid" });
  }

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    const userQuery = await db.query('SELECT * FROM users WHERE email = $1', [decoded.sub]);
    if (userQuery.rows.length === 0) {
      return res.status(401).json({ detail: "Could not validate credentials" });
    }
    const user = userQuery.rows[0];

    // Gate access: Reject non-approved accounts
    if (user.access_status === 'pending') {
      return res.status(403).json({
        detail: "Your access request is pending approval.",
        access_status: "pending"
      });
    }
    if (user.access_status === 'declined') {
      return res.status(403).json({
        detail: "Access request was declined.",
        access_status: "declined"
      });
    }

    req.currentUser = user;
    next();
  } catch (err) {
    return res.status(401).json({ detail: "Could not validate credentials" });
  }
}

// Require Admin Middleware
function requireAdmin(req, res, next) {
  if (!req.currentUser || req.currentUser.is_admin !== true) {
    return res.status(403).json({ detail: "Administrator privileges required." });
  }
  next();
}

// Helper to sanitize project names (Security Check)
function validateProjectName(name) {
  if (!name || typeof name !== 'string' || name.length > 63) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}

// Helper to sanitize subdomain (Security Check)
function validateSubdomain(subdomain) {
  if (!subdomain || typeof subdomain !== 'string' || subdomain.length > 63) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain);
}

// Helper to validate Docker images (Prohibits shell metacharacters and command injection)
function validateDockerImage(image) {
  if (!image || typeof image !== 'string' || image.length > 255) return false;
  if (/[\s;$`&|><(){}[\]\\!^~*?'"]/.test(image)) return false;
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[a-zA-Z0-9_.-]+)?(?:@sha256:[a-f0-9]{64})?$/i.test(image);
}

// Helper to validate GitHub repositories (owner/repo)
function validateGitHubRepo(repo) {
  if (!repo || typeof repo !== 'string' || repo.length > 200) return false;
  let clean = repo.trim();
  if (clean.startsWith('https://github.com/')) clean = clean.replace('https://github.com/', '');
  if (clean.endsWith('.git')) clean = clean.substring(0, clean.length - 4);
  if (/[\s;$`&|><(){}[\]\\!^~*?'"]/.test(clean)) return false;
  if (clean.includes('..') || clean.startsWith('/') || clean.endsWith('/')) return false;
  const parts = clean.split('/');
  if (parts.length !== 2) return false;
  return /^[a-zA-Z0-9_.-]+$/.test(parts[0]) && /^[a-zA-Z0-9_.-]+$/.test(parts[1]);
}

// Helper to validate Git branch names
function validateGitHubBranch(branch) {
  if (!branch || typeof branch !== 'string' || branch.length > 100) return false;
  if (/[\s;$`&|><(){}[\]\\!^~*?':"]/.test(branch)) return false;
  if (branch.includes('..') || branch.includes('//') || branch.includes('@{')) return false;
  if (branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.lock') || branch.startsWith('.')) return false;
  return /^[a-zA-Z0-9_./-]+$/.test(branch);
}

// Helper to validate environment variables
function validateEnvVars(envVars) {
  if (envVars === null || envVars === undefined) return { valid: true, sanitized: {} };
  if (typeof envVars !== 'object' || Array.isArray(envVars)) {
    return { valid: false, detail: "Environment variables must be a JSON object mapping keys to values." };
  }
  const entries = Object.entries(envVars);
  if (entries.length > 200) return { valid: false, detail: "Too many environment variables (maximum 200 allowed)." };

  const sanitized = {};
  for (const [key, value] of entries) {
    if (!key || typeof key !== 'string' || key.length > 128) {
      return { valid: false, detail: `Invalid environment variable key '${key}'. Keys must be strings up to 128 characters.` };
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      return { valid: false, detail: `Environment variable key '${key}' contains invalid characters. Only alphanumeric characters and underscores are allowed.` };
    }
    if (['LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'SHELLOPTS'].includes(key.toUpperCase())) {
      return { valid: false, detail: `Environment variable key '${key}' is restricted for security.` };
    }
    const strVal = String(value);
    if (strVal.length > 8192) {
      return { valid: false, detail: `Environment variable value for '${key}' exceeds maximum permitted size (8KB).` };
    }
    if (strVal.includes('\0')) {
      return { valid: false, detail: `Environment variable value for '${key}' contains forbidden null bytes.` };
    }
    sanitized[key] = strVal;
  }
  return { valid: true, sanitized };
}

// Helper to validate email domains & resolve MX records
async function validateEmailDomain(email) {
  if (!email || typeof email !== 'string') return { valid: false, detail: "Invalid email input" };
  const parts = email.split('@');
  if (parts.length !== 2) return { valid: false, detail: "Invalid email address format" };

  const domain = parts[1].trim().toLowerCase();

  // Specific check for local test domains (e.g. unit/integration testing)
  const isLocalDomain = domain === 'localhost' || domain === 'zynkara.local' || domain.endsWith('.local') || domain.endsWith('.localhost');
  if (isLocalDomain) {
    return { valid: true };
  }

  // Reject disposable / temporary email domains immediately
  if (disposableDomainsSet.has(domain)) {
    return {
      valid: false,
      detail: "Disposable/temporary email addresses are not allowed. Please use a real email address."
    };
  }

  // Whitelisted common domains
  const whitelistedDomains = [
    'gmail.com', 'googlemail.com',
    'github.com', 'users.noreply.github.com',
    'outlook.com', 'hotmail.com', 'live.com',
    'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com',
    'example.com'
  ];

  const isWhitelisted = whitelistedDomains.includes(domain) || whitelistedDomains.some(d => domain.endsWith('.' + d));

  // If directly whitelisted, accept immediately
  if (isWhitelisted) {
    return { valid: true };
  }

  // DNS MX resolution to verify the domain has a real mail server
  try {
    const mxRecords = await dns.resolveMx(domain);
    if (!mxRecords || mxRecords.length === 0) {
      return { valid: false, detail: `Email domain '${domain}' has no active mail server (no MX records).` };
    }
  } catch (err) {
    console.warn(`MX record check failed for domain ${domain}:`, err.message);
    return { valid: false, detail: `Email domain '${domain}' could not be verified (DNS resolve failed).` };
  }

  return { valid: true };
}

// Background deployment pipeline
async function executeDeploymentPipeline(project, appImage, appPort, envVars) {
  const deploymentId = crypto.randomUUID();

  try {
    // Create deployment record
    await db.query(
      'INSERT INTO deployments (id, project_id, status, app_image, env_vars, logs) VALUES ($1, $2, $3, $4, $5, $6)',
      [deploymentId, project.id, 'building', appImage, JSON.stringify(envVars), 'Initializing deployment pipeline...\n']
    );

    const appendLogs = async (text) => {
      console.log(`[Deploy ${project.id}]: ${text}`);
      await db.query(
        'UPDATE deployments SET logs = COALESCE(logs, \'\') || $1 WHERE id = $2',
        [text + '\n', deploymentId]
      );
    };

    let finalAppImage = appImage;

    // Check for Github repository build source
    if (project.github_repo) {
      await appendLogs(`Cloning GitHub repository: '${project.github_repo}' (branch: '${project.github_branch || 'main'}')...`);

      let repoClean = project.github_repo.trim();
      if (repoClean.startsWith('https://github.com/')) {
        repoClean = repoClean.replace('https://github.com/', '');
      }
      if (repoClean.endsWith('.git')) {
        repoClean = repoClean.substring(0, repoClean.length - 4);
      }

      const parts = repoClean.split('/').filter(Boolean);
      if (parts.length < 2) {
        throw new Error(`Invalid GitHub repository identifier: ${project.github_repo}`);
      }
      const owner = parts[parts.length - 2];
      const repo = parts[parts.length - 1];
      const branchName = project.github_branch || 'main';

      const zipballUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${branchName}`;
      await appendLogs(`Downloading zipball from GitHub repository...`);

      const headers = { 'User-Agent': 'ZynkaraShift-PaaS' };
      if (project.github_token) {
        headers['Authorization'] = `token ${project.github_token}`;
      }

      const response = await axios({
        url: zipballUrl,
        method: 'GET',
        responseType: 'arraybuffer',
        headers: headers
      });

      await appendLogs('Repository downloaded. Extracting zipball...');

      const buildDir = path.join(__dirname, 'build-temp', crypto.randomUUID());
      const resolvedBuildDir = path.resolve(buildDir);
      fs.mkdirSync(resolvedBuildDir, { recursive: true });

      try {
        const zip = new AdmZip(Buffer.from(response.data));
        const entries = zip.getEntries();

        // Security check: Zip-slip prevention
        for (const entry of entries) {
          const entryPath = path.resolve(resolvedBuildDir, entry.entryName);
          if (!entryPath.startsWith(resolvedBuildDir + path.sep) && entryPath !== resolvedBuildDir) {
            throw new Error(`Security violation: Malicious zip entry detected (path traversal attempt): ${entry.entryName}`);
          }
        }

        zip.extractAllTo(resolvedBuildDir, true);

        // Find root folder in extraction directory
        const dirs = fs.readdirSync(resolvedBuildDir).filter(f => fs.statSync(path.join(resolvedBuildDir, f)).isDirectory());
        if (dirs.length === 0) {
          throw new Error('Extracted zipball is empty');
        }
        const repoRoot = path.join(resolvedBuildDir, dirs[0]);

        // Validate or synthesize Dockerfile via Zero-Config Buildpack Engine
        const dockerfilePath = path.join(repoRoot, 'Dockerfile');
        if (!fs.existsSync(dockerfilePath)) {
          await appendLogs('🔍 [BUILDPACK] No Dockerfile detected in repository root. Activating Zero-Config Buildpack Engine...');
          const frameworkInfo = detectFramework(repoRoot);
          if (!frameworkInfo) {
            throw new Error('Dockerfile not found and no recognized project manifests (package.json, requirements.txt, go.mod, Cargo.toml) were detected.');
          }

          await appendLogs(`⚡ [BUILDPACK] Auto-detected framework/runtime: ${frameworkInfo.name}`);
          const synth = synthesizeDockerfile(repoRoot, frameworkInfo);
          if (!synth.synthesized) {
            throw new Error(`Failed to synthesize Dockerfile: ${synth.reason}`);
          }
          await appendLogs('⚡ [BUILDPACK] Successfully synthesized optimized multi-stage production Dockerfile.');

          // Adjust service port if user kept default 80 but framework targets another default
          if (project.app_port === 80 && frameworkInfo.defaultPort !== 80) {
            project.app_port = frameworkInfo.defaultPort;
            await db.query('UPDATE projects SET app_port = $1 WHERE id = $2', [project.app_port, project.id]);
            await appendLogs(`⚡ [BUILDPACK] Auto-configured container port to ${project.app_port}/tcp.`);
          }
        } else {
          await appendLogs('Dockerfile found. Commencing docker image build...');
        }

        const imageTag = `zynkara-local-${project.id.replace(/-/g, '')}:latest`;

        // Pack into tar stream for Docker daemon
        const pack = tar.pack(repoRoot);

        await appendLogs(`Building Docker image with tag '${imageTag}' (Timeout: 10 minutes)...`);

        await new Promise((resolve, reject) => {
          let isComplete = false;
          // Build timeout: 10 minutes max to prevent runaway builds
          const buildTimeout = setTimeout(() => {
            if (!isComplete) {
              isComplete = true;
              try { pack.destroy(); } catch (e) {}
              reject(new Error("Build timed out after 10 minutes. Execution aborted for security."));
            }
          }, 10 * 60 * 1000);

          orchestration.docker.buildImage(pack, { t: imageTag, rm: true }, (err, stream) => {
            if (err) {
              clearTimeout(buildTimeout);
              isComplete = true;
              return reject(err);
            }

            orchestration.docker.modem.followProgress(stream, onFinished, onProgress);

            function onFinished(err, output) {
              clearTimeout(buildTimeout);
              if (isComplete) return;
              isComplete = true;
              if (err) return reject(err);
              resolve(output);
            }

            async function onProgress(event) {
              if (isComplete) return;
              if (event.stream) {
                appendLogs(event.stream.trim());
              } else if (event.status) {
                appendLogs(event.status.trim());
              }
            }
          });
        });

        await appendLogs(`Docker image built successfully with tag '${imageTag}'.`);
        finalAppImage = imageTag;

        // Update database with built image tag
        await db.query('UPDATE deployments SET app_image = $1 WHERE id = $2', [imageTag, deploymentId]);

      } finally {
        // Cleanup build directory
        try {
          fs.rmSync(buildDir, { recursive: true, force: true });
        } catch (e) { }
      }
    }

    await appendLogs('Checking network config...');
    // Create network
    await orchestration._getOrCreateNetwork(`zynkara-project-${project.id}`);

    // Provision Database if requested
    let dbConn = null;
    if (project.db_type) {
      await appendLogs(`Provisioning database microservice of type ${project.db_type}...`);
      const dbResult = await orchestration.provisionDatabase(
        project.owner_id,
        project.id,
        project.db_type
      );
      dbConn = dbResult.connectionInfo;
      await appendLogs('Database microservice provisioned. Connection string injected.');
    }

    // Deploy App Container with Self-Healing Post-Boot Watchdog
    await appendLogs(`Deploying app container ${finalAppImage} listening on port ${project.app_port}...`);
    await orchestration.deployApp(
      project.owner_id,
      project.id,
      project.subdomain,
      finalAppImage,
      project.app_port,
      envVars,
      dbConn,
      {
        probeUrl: `http://${project.subdomain}.localhost`,
        timeoutSeconds: 30,
        onProgress: async (msg) => {
          await appendLogs(msg);
        }
      }
    );

    // Update DB status to active
    await db.query('UPDATE projects SET status = $1 WHERE id = $2', ['active', project.id]);
    await db.query('UPDATE deployments SET status = $1, logs = COALESCE(logs, \'\') || $2 WHERE id = $3', ['running', 'Success! Application routed via Traefik reverse proxy.\n', deploymentId]);

  } catch (err) {
    console.error('Deployment pipeline error:', err);
    try {
      await db.query(
        'UPDATE deployments SET status = $1, logs = COALESCE(logs, \'\') || $2 WHERE id = $3',
        ['failed', `Error during deployment pipeline: ${err.message}\n`, deploymentId]
      );
      await db.query('UPDATE projects SET status = $1 WHERE id = $2', ['stopped', project.id]);
    } catch (dbErr) {
      console.error('Failed to log error to database:', dbErr);
    }
  }
}

// --- AUTH ENDPOINTS ---

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ detail: "Email and password are required" });
  }

  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName || cleanName.length < 2 || cleanName.length > 100) {
    return res.status(400).json({ detail: "Name is required (between 2 and 100 characters)." });
  }

  const cleanEmail = email.trim().toLowerCase();

  // Validate email domain & MX records (and reject disposable emails)
  const domainValidation = await validateEmailDomain(cleanEmail);
  if (!domainValidation.valid) {
    return res.status(400).json({ detail: domainValidation.detail });
  }

  // Fail closed if SMTP is not configured
  if (!isSmtpConfigured()) {
    return res.status(503).json({
      detail: "Email verification is not currently configured. Please contact the administrator."
    });
  }

  try {
    // 1. Check if email is already in the main users table
    const existingUser = await db.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ detail: "Email already registered" });
    }

    // 2. Generate a 6-digit verification code
    const verificationCode = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3. Save to pending_registrations with name (insert or update on conflict)
    await db.query(
      `INSERT INTO pending_registrations (email, name, hashed_password, verification_token, verification_expires) 
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) 
       DO UPDATE SET name = $2, hashed_password = $3, verification_token = $4, verification_expires = $5`,
      [cleanEmail, cleanName, hashedPassword, verificationCode, expiresAt]
    );

    // 4. Send verification email via SMTP (fails closed if delivery fails)
    try {
      await sendVerificationEmail(cleanEmail, verificationCode);
    } catch (mailErr) {
      await db.query('DELETE FROM pending_registrations WHERE email = $1', [cleanEmail]);
      return res.status(500).json({
        detail: mailErr.message || "Failed to send verification email. Please try again later."
      });
    }

    res.json({
      email: cleanEmail,
      requires_verification: true,
      message: "Verification code sent to your email address."
    });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ detail: "Internal database error" });
  }
});

app.post('/api/auth/verify', authLimiter, async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ detail: "Email and verification code are required" });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanCode = code.trim();

  try {
    // 1. Fetch pending registration record
    const pendingRes = await db.query('SELECT * FROM pending_registrations WHERE email = $1', [cleanEmail]);
    if (pendingRes.rows.length === 0) {
      return res.status(400).json({ detail: "No pending registration found for this email." });
    }

    const record = pendingRes.rows[0];

    // 2. Verify code and expiration
    if (record.verification_token !== cleanCode) {
      return res.status(400).json({ detail: "Incorrect verification code." });
    }

    if (new Date() > new Date(record.verification_expires)) {
      return res.status(400).json({ detail: "Verification code has expired. Please request a new code." });
    }

    // 3. Move user to active users table with pending access status, carrying over name
    const userId = crypto.randomUUID();
    const userName = record.name || cleanEmail.split('@')[0];
    await db.query(
      `INSERT INTO users (id, name, email, hashed_password, subscription_status, access_status, is_admin, is_verified) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, userName, cleanEmail, record.hashed_password, 'free', 'pending', false, true]
    );

    // 4. Delete from pending registrations
    await db.query('DELETE FROM pending_registrations WHERE email = $1', [cleanEmail]);

    // 5. Block token issuance for pending users
    return res.status(403).json({
      detail: "Your access request is pending approval.",
      access_status: "pending",
      user: {
        id: userId,
        name: userName,
        email: cleanEmail,
        access_status: "pending"
      }
    });
  } catch (err) {
    console.error("Verification error:", err);
    res.status(500).json({ detail: "Failed to verify email. Internal server error." });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ detail: "Email and password are required" });
  }

  const cleanEmail = email.trim().toLowerCase();

  try {
    const userRes = await db.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    if (userRes.rows.length === 0) {
      // Check if they are in pending_registrations
      const pendingRes = await db.query('SELECT * FROM pending_registrations WHERE email = $1', [cleanEmail]);
      if (pendingRes.rows.length > 0) {
        return res.status(403).json({
          detail: "Please verify your email address before logging in.",
          unverified: true
        });
      }
      return res.status(401).json({ detail: "Incorrect email or password" });
    }

    const user = userRes.rows[0];
    const isMatch = await bcrypt.compare(password, user.hashed_password);
    if (!isMatch) {
      return res.status(401).json({ detail: "Incorrect email or password" });
    }

    if (!user.is_verified) {
      return res.status(403).json({
        detail: "Please verify your email address before logging in.",
        unverified: true
      });
    }

    // Gate access: check access_status
    if (user.access_status === 'pending') {
      return res.status(403).json({
        detail: "Your access request is pending approval.",
        access_status: "pending"
      });
    }

    if (user.access_status === 'declined') {
      return res.status(403).json({
        detail: "Access request was declined.",
        access_status: "declined"
      });
    }

    const token = jwt.sign({ sub: user.email }, SECRET_KEY, { expiresIn: '2h' });
    setAuthCookie(res, token);
    res.json({
      access_token: token,
      token_type: "bearer",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        subscription_status: user.subscription_status,
        access_status: user.access_status,
        is_admin: user.is_admin
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.get('/api/auth/me', loadCurrentUser, (req, res) => {
  res.json({
    id: req.currentUser.id,
    name: req.currentUser.name,
    email: req.currentUser.email,
    subscription_status: req.currentUser.subscription_status,
    access_status: req.currentUser.access_status,
    is_admin: req.currentUser.is_admin,
    created_at: req.currentUser.created_at
  });
});

app.post('/api/auth/refresh', loadCurrentUser, (req, res) => {
  const token = jwt.sign({ sub: req.currentUser.email }, SECRET_KEY, { expiresIn: '2h' });
  setAuthCookie(res, token);
  res.json({
    access_token: token,
    token_type: "bearer",
    user: {
      id: req.currentUser.id,
      name: req.currentUser.name,
      email: req.currentUser.email,
      subscription_status: req.currentUser.subscription_status,
      access_status: req.currentUser.access_status,
      is_admin: req.currentUser.is_admin
    }
  });
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ detail: "Logged out successfully" });
});

// --- ADMIN ACCESS GATE ENDPOINTS ---

app.get('/api/admin/access-requests', loadCurrentUser, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, email, subscription_status, access_status, is_admin, oauth_provider, created_at 
       FROM users 
       WHERE access_status = 'pending' 
       ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching access requests:", err);
    res.status(500).json({ detail: "Database error fetching access requests." });
  }
});

app.post('/api/admin/access-requests/:id/approve', loadCurrentUser, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `UPDATE users 
       SET access_status = 'approved', subscription_status = 'premium' 
       WHERE id = $1 
       RETURNING id, name, email, subscription_status, access_status, is_admin`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ detail: "User not found." });
    }

    res.json({
      message: "Access request approved. User upgraded to premium.",
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Error approving access request:", err);
    res.status(500).json({ detail: "Database error approving access request." });
  }
});

app.post('/api/admin/access-requests/:id/decline', loadCurrentUser, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `UPDATE users 
       SET access_status = 'declined' 
       WHERE id = $1 
       RETURNING id, name, email, subscription_status, access_status, is_admin`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ detail: "User not found." });
    }

    res.json({
      message: "Access request declined.",
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Error declining access request:", err);
    res.status(500).json({ detail: "Database error declining access request." });
  }
});

// --- UNIFIED OAUTH ENDPOINTS ---

function getOAuthRedirectUri(provider, req) {
  const host = req.get('host') || 'localhost:8000';
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';

  // Google Cloud Console strictly authorizes 127.0.0.1:8000 or zynkarashift.duckdns.org
  if (provider === 'google') {
    if (host.includes('localhost') || host.includes('127.0.0.1')) {
      return 'http://127.0.0.1:8000/api/auth/oauth/google/callback';
    }
    return `http://${PLATFORM_DOMAIN}/api/auth/oauth/google/callback`;
  }

  return `${protocol}://${host}/api/auth/oauth/${provider}/callback`;
}

// Redirect to provider Authorize URL
app.get('/api/auth/oauth/:provider', (req, res) => {
  const provider = req.params.provider.toLowerCase();
  const host = req.get('host') || 'localhost:8000';
  const redirectUri = getOAuthRedirectUri(provider, req);

  // Capture where the user originated from so we redirect back to that exact port (e.g. 5173)
  const frontendOrigin = req.query.origin || (req.headers.referer ? new URL(req.headers.referer).origin : 'http://localhost:5173');
  const statePayload = Buffer.from(JSON.stringify({ origin: frontendOrigin })).toString('base64');

  let clientId = '';
  let authUrl = '';

  if (provider === 'github') {
    clientId = GITHUB_CLIENT_ID;
    authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user:email&state=${encodeURIComponent(statePayload)}`;
  } else if (provider === 'google') {
    clientId = process.env.GOOGLE_CLIENT_ID;
    authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20email%20profile&state=${encodeURIComponent(statePayload)}`;
  } else {
    return res.status(400).send("Unsupported OAuth provider");
  }

  if (!clientId) {
    return res.status(400).send(`OAuth Client ID for ${provider} is not configured in backend/.env`);
  }

  res.redirect(authUrl);
});

// OAuth Callback Receiver
app.get('/api/auth/oauth/:provider/callback', authLimiter, async (req, res) => {
  const provider = req.params.provider.toLowerCase();
  const { code, state } = req.query;

  let frontendOrigin = 'http://localhost:5173';
  let isAccountLink = false;
  let linkUserId = null;

  if (state) {
    // Check if state is a JWT token (from GitHub account connect flow)
    try {
      const decoded = jwt.verify(state, SECRET_KEY);
      const userQuery = await db.query('SELECT * FROM users WHERE email = $1', [decoded.sub]);
      if (userQuery.rows.length > 0) {
        linkUserId = userQuery.rows[0].id;
        isAccountLink = true;
      }
    } catch (e) {
      // Otherwise, parse encoded JSON state payload
      try {
        const parsed = JSON.parse(Buffer.from(state, 'base64').toString());
        if (parsed.origin) frontendOrigin = parsed.origin;
      } catch (jsonErr) {}
    }
  }

  if (frontendOrigin === 'http://localhost:5173' && req.headers.referer) {
    try {
      frontendOrigin = new URL(req.headers.referer).origin;
    } catch (e) {}
  }

  if (!code) {
    return res.redirect(`${frontendOrigin}/?oauth_error=${encodeURIComponent("OAuth authorization code was not received.")}`);
  }

  // Handle GitHub Account connection flow if state (JWT token) was verified
  if (provider === 'github' && isAccountLink) {
    try {
      const tokenResponse = await axios.post(
        'https://github.com/login/oauth/access_token',
        {
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code: code
        },
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ZynkaraShift-PaaS'
          }
        }
      );

      const accessToken = tokenResponse.data.access_token;
      if (!accessToken) {
        console.error("OAuth access token response:", tokenResponse.data);
        return res.redirect(`${frontendOrigin}/?oauth_error=${encodeURIComponent(`Failed to retrieve GitHub access token: ${tokenResponse.data.error_description || tokenResponse.data.error || 'Unknown error'}`)}`);
      }

      const userResponse = await axios.get('https://api.github.com/user', {
        headers: {
          'Authorization': `token ${accessToken}`,
          'User-Agent': 'ZynkaraShift-PaaS'
        }
      });

      const username = userResponse.data.login;
      const ghName = (userResponse.data.name || username || '').slice(0, 100);
      if (!username) {
        return res.redirect(`${frontendOrigin}/?oauth_error=${encodeURIComponent("Failed to retrieve username from GitHub profile.")}`);
      }

      await db.query(
        'UPDATE users SET github_token = $1, github_username = $2, name = COALESCE(name, $3) WHERE id = $4',
        [accessToken, username, ghName, linkUserId]
      );

      return res.redirect(`${frontendOrigin}/?github_connected=true`);
    } catch (err) {
      console.error("GitHub OAuth Callback error:", err.response?.data || err.message);
      return res.redirect(`${frontendOrigin}/?oauth_error=${encodeURIComponent(`GitHub authentication error: ${err.message}`)}`);
    }
  }

  let email = '';
  let oauthId = '';
  let displayName = '';

  try {
    if (provider === 'github') {
      const tokenResponse = await axios.post(
        'https://github.com/login/oauth/access_token',
        { client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code: code },
        { headers: { 'Accept': 'application/json', 'User-Agent': 'ZynkaraShift-PaaS' } }
      );
      const accessToken = tokenResponse.data.access_token;
      if (!accessToken) throw new Error(tokenResponse.data.error_description || "Failed to exchange GitHub access token");

      const userResponse = await axios.get('https://api.github.com/user', {
        headers: { 'Authorization': `token ${accessToken}`, 'User-Agent': 'ZynkaraShift-PaaS' }
      });
      oauthId = String(userResponse.data.id);
      displayName = userResponse.data.name || userResponse.data.login || '';

      const emailsResponse = await axios.get('https://api.github.com/user/emails', {
        headers: { 'Authorization': `token ${accessToken}`, 'User-Agent': 'ZynkaraShift-PaaS' }
      });
      const primaryEmailObj = emailsResponse.data.find(e => e.primary && e.verified) || emailsResponse.data[0];
      email = primaryEmailObj ? primaryEmailObj.email.toLowerCase() : userResponse.data.email?.toLowerCase();
      if (!email) email = `${userResponse.data.login}@users.noreply.github.com`.toLowerCase();
    } else if (provider === 'google') {
      const redirectUri = getOAuthRedirectUri('google', req);
      const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      });
      const idToken = tokenResponse.data.id_token;
      if (!idToken) throw new Error("ID Token missing from Google response");
      const decoded = jwt.decode(idToken);
      email = decoded.email.toLowerCase();
      oauthId = decoded.sub;
      displayName = decoded.name || '';
    } else {
      return res.status(400).send("Unsupported OAuth provider callback");
    }
  } catch (err) {
    console.error(`OAuth callback error for provider ${provider}:`, err.response?.data || err.message);
    const desc = err.response?.data?.error_description || err.response?.data?.error || err.message;
    return res.redirect(`${frontendOrigin}/?oauth_error=${encodeURIComponent(`Authentication failed with ${provider}: ${desc}`)}`);
  }

  if (!email) {
    return res.redirect(`${frontendOrigin}/?oauth_error=${encodeURIComponent("Could not retrieve email from OAuth profile.")}`);
  }

  // Validate email domain compatibility
  const domainValidation = await validateEmailDomain(email);
  if (!domainValidation.valid) {
    return res.redirect(`${frontendOrigin}/?oauth_error=${encodeURIComponent(`OAuth registration denied: ${domainValidation.detail}`)}`);
  }

  try {
    let userQuery = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    let userId;

    const resolvedName = (displayName || email.split('@')[0] || 'User').slice(0, 100);

    if (userQuery.rows.length === 0) {
      userId = crypto.randomUUID();
      const mockPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      // New users default to access_status = 'pending'
      await db.query(
        `INSERT INTO users (id, name, email, hashed_password, subscription_status, access_status, is_admin, is_verified, oauth_provider, oauth_id) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [userId, resolvedName, email, mockPasswordHash, 'free', 'pending', false, true, provider, oauthId]
      );
    } else {
      const user = userQuery.rows[0];
      userId = user.id;
      await db.query(
        'UPDATE users SET oauth_provider = COALESCE(oauth_provider, $1), oauth_id = COALESCE(oauth_id, $2), is_verified = TRUE, name = COALESCE(name, $3) WHERE id = $4',
        [provider, oauthId, resolvedName, userId]
      );
    }

    // Clean up pending registrations
    await db.query('DELETE FROM pending_registrations WHERE email = $1', [email]);

    // Check user's access status
    const verifiedUser = (await db.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];

    if (verifiedUser.access_status === 'pending') {
      return res.redirect(`${frontendOrigin}/?access_status=pending&error=${encodeURIComponent("Your access request is pending approval.")}`);
    }

    if (verifiedUser.access_status === 'declined') {
      return res.redirect(`${frontendOrigin}/?access_status=declined&error=${encodeURIComponent("Access request was declined.")}`);
    }

    // Only issue token if approved
    const token = jwt.sign({ sub: email }, SECRET_KEY, { expiresIn: '2h' });
    setAuthCookie(res, token);

    // Redirect back to frontend dashboard with token
    res.redirect(`${frontendOrigin}/?oauth_token=${token}`);
  } catch (err) {
    console.error("OAuth database resolution error:", err);
    res.status(500).send("Database error during OAuth user resolution.");
  }
});

// --- SUBSCRIPTION ENDPOINTS ---

app.post('/api/subscription/create-checkout-session', loadCurrentUser, async (req, res) => {
  const origin = req.headers.referer || req.headers.origin || 'http://localhost:5173';

  if (!stripe) {
    // If Stripe is not configured, perform an instant upgrade for testing
    try {
      await db.query(
        'UPDATE users SET subscription_status = $1 WHERE id = $2',
        ['premium', req.currentUser.id]
      );
      return res.json({ url: `${origin}?upgrade_success=true` });
    } catch (err) {
      console.error("Mock upgrade failed:", err);
      return res.status(500).json({ detail: "Mock upgrade failed due to a database error." });
    }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${origin}?upgrade_success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}`,
      metadata: {
        userId: req.currentUser.id.toString(),
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe session creation error:", err);
    res.status(500).json({ detail: "Failed to create Stripe checkout session: " + err.message });
  }
});

// --- PROJECT ENDPOINTS ---

app.post('/api/projects', deployLimiter, loadCurrentUser, async (req, res) => {
  const { name, app_image, db_type, github_repo, github_branch, github_token, env_vars, app_port } = req.body;

  // Security checks on input parameters
  if (!validateProjectName(name)) {
    return res.status(400).json({ detail: "Invalid project name. Only lowercase alphanumeric and hyphens allowed (max 63 chars)." });
  }

  if (db_type && !['postgres', 'mysql', 'mongodb', 'redis'].includes(db_type)) {
    return res.status(400).json({ detail: "Unsupported database type." });
  }

  if (!app_image && !github_repo) {
    return res.status(400).json({ detail: "Either app_image or github_repo must be provided." });
  }

  if (app_image && !validateDockerImage(app_image)) {
    return res.status(400).json({ detail: "Invalid Docker image name format or prohibited characters detected." });
  }

  if (github_repo && !validateGitHubRepo(github_repo)) {
    return res.status(400).json({ detail: "Invalid GitHub repository identifier format. Expected 'owner/repo'." });
  }

  if (github_branch && !validateGitHubBranch(github_branch)) {
    return res.status(400).json({ detail: "Invalid Git branch format or prohibited characters detected." });
  }

  if (github_token && (!/^[a-zA-Z0-9_.-]+$/.test(github_token) || github_token.length > 255)) {
    return res.status(400).json({ detail: "Invalid GitHub token format." });
  }

  const envValidation = validateEnvVars(env_vars);
  if (!envValidation.valid) {
    return res.status(400).json({ detail: envValidation.detail });
  }
  const sanitizedEnvVars = envValidation.sanitized;

  const port = parseInt(app_port || 80, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    return res.status(400).json({ detail: "Invalid target port specification." });
  }

  try {
    // 1. Check Subscription limit (Security limit gate)
    const activeProjectsRes = await db.query(
      'SELECT COUNT(*) FROM projects WHERE owner_id = $1 AND status = $2',
      [req.currentUser.id, 'active']
    );
    const activeCount = parseInt(activeProjectsRes.rows[0].count, 10);

    if (activeCount >= 3 && req.currentUser.subscription_status !== 'premium') {
      return res.status(403).json({
        error: "Subscription required",
        message: "You have reached the maximum limit of 3 free deployed projects. Please upgrade to a premium tier to unlock unlimited deployments."
      });
    }

    // 2. Generate unique subdomain
    let baseSubdomain = name.toLowerCase().replace(/[^a-z0-9\-]/g, '');
    if (!baseSubdomain) baseSubdomain = `app-${crypto.randomBytes(3).toString('hex')}`;

    let subdomain = baseSubdomain;
    let counter = 1;
    while (true) {
      const subRes = await db.query('SELECT * FROM projects WHERE subdomain = $1', [subdomain]);
      if (subRes.rows.length === 0) break;
      subdomain = `${baseSubdomain}-${counter}`;
      counter++;
    }

    // 3. Create project record
    const projectId = crypto.randomUUID();
    const tokenToUse = github_token || req.currentUser.github_token || null;
    const newProject = {
      id: projectId,
      name,
      subdomain,
      owner_id: req.currentUser.id,
      db_type: db_type || null,
      github_repo: github_repo || null,
      github_branch: github_branch || 'main',
      github_token: tokenToUse,
      app_port: port,
      status: 'active',
      created_at: new Date().toISOString()
    };

    await db.query(
      `INSERT INTO projects (id, name, subdomain, owner_id, db_type, github_repo, github_branch, github_token, app_port, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        newProject.id, newProject.name, newProject.subdomain, newProject.owner_id,
        newProject.db_type, newProject.github_repo, newProject.github_branch,
        newProject.github_token, newProject.app_port, newProject.status
      ]
    );

    // 4. Asynchronously launch deployment pipeline background task (FastAPI equivalent)
    const targetImage = app_image || `github/${github_repo.toLowerCase()}`;
    setImmediate(() => {
      executeDeploymentPipeline(newProject, targetImage, port, sanitizedEnvVars);
    });

    const { github_token, ...returnedProject } = newProject;
    res.json(returnedProject);

  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: "Internal database query error" });
  }
});

app.get('/api/projects', loadCurrentUser, async (req, res) => {
  try {
    const projectsRes = await db.query('SELECT * FROM projects WHERE owner_id = $1', [req.currentUser.id]);
    const projects = projectsRes.rows.map(row => {
      const { github_token, ...rest } = row;
      return rest;
    });

    // Dynamically poll Docker state for current statuses (FastAPI equivalent)
    for (const project of projects) {
      const dockerStatus = await orchestration.getContainerStatus(project.id);

      let mappedStatus = project.status;
      if (dockerStatus === 'running') {
        mappedStatus = 'active';
      } else if (dockerStatus === 'offline' || dockerStatus === 'exited') {
        mappedStatus = 'stopped';
      }

      if (mappedStatus !== project.status) {
        project.status = mappedStatus;
        await db.query('UPDATE projects SET status = $1 WHERE id = $2', [mappedStatus, project.id]);
      }
    }

    res.json(projects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: "Failed to load projects" });
  }
});

app.get('/api/projects/:project_id', loadCurrentUser, async (req, res) => {
  try {
    const projRes = await db.query(
      'SELECT * FROM projects WHERE id = $1 AND owner_id = $2',
      [req.params.project_id, req.currentUser.id]
    );

    if (projRes.rows.length === 0) {
      return res.status(404).json({ detail: "Project not found" });
    }

    const { github_token, ...rest } = projRes.rows[0];
    res.json(rest);
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: "Database fetch failed" });
  }
});

app.get('/api/projects/:project_id/deployments', loadCurrentUser, async (req, res) => {
  try {
    // Owner authorization check
    const projRes = await db.query(
      'SELECT id FROM projects WHERE id = $1 AND owner_id = $2',
      [req.params.project_id, req.currentUser.id]
    );
    if (projRes.rows.length === 0) {
      return res.status(404).json({ detail: "Project not found" });
    }

    const deployRes = await db.query(
      'SELECT * FROM deployments WHERE project_id = $1 ORDER BY created_at DESC',
      [req.params.project_id]
    );

    res.json(deployRes.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: "Failed to fetch deployment records" });
  }
});

app.get('/api/projects/:project_id/logs', loadCurrentUser, async (req, res) => {
  try {
    // Owner validation
    const projRes = await db.query(
      'SELECT db_type FROM projects WHERE id = $1 AND owner_id = $2',
      [req.params.project_id, req.currentUser.id]
    );
    if (projRes.rows.length === 0) {
      return res.status(404).json({ detail: "Project not found" });
    }

    // Fetch build logs from database
    const latestDeployRes = await db.query(
      'SELECT logs FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.params.project_id]
    );
    const build_logs = latestDeployRes.rows.length > 0 ? latestDeployRes.rows[0].logs : "";

    // Fetch container runtime logs dynamically
    const runtime_logs = await orchestration.getContainerLogs(req.params.project_id);

    res.json({ build_logs, runtime_logs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: "Failed to get logs" });
  }
});

app.post('/api/projects/:project_id/stop', loadCurrentUser, async (req, res) => {
  try {
    const projRes = await db.query(
      'SELECT * FROM projects WHERE id = $1 AND owner_id = $2',
      [req.params.project_id, req.currentUser.id]
    );
    if (projRes.rows.length === 0) {
      return res.status(404).json({ detail: "Project not found" });
    }

    const project = projRes.rows[0];

    if (orchestration.docker) {
      try {
        const container = orchestration.docker.getContainer(`zynkara-app-${project.id}`);
        await container.stop();
      } catch (e) { }

      if (project.db_type) {
        try {
          const dbContainer = orchestration.docker.getContainer(`zynkara-db-${project.id}`);
          await dbContainer.stop();
        } catch (e) { }
      }
    }

    await db.query('UPDATE projects SET status = $1 WHERE id = $2', ['stopped', project.id]);
    res.json({ message: "Project stopped successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: "Failed to stop service containers" });
  }
});

app.post('/api/projects/:project_id/start', loadCurrentUser, async (req, res) => {
  try {
    const projRes = await db.query(
      'SELECT * FROM projects WHERE id = $1 AND owner_id = $2',
      [req.params.project_id, req.currentUser.id]
    );
    if (projRes.rows.length === 0) {
      return res.status(404).json({ detail: "Project not found" });
    }

    const project = projRes.rows[0];

    if (orchestration.docker) {
      if (project.db_type) {
        try {
          const dbContainer = orchestration.docker.getContainer(`zynkara-db-${project.id}`);
          await dbContainer.start();
        } catch (e) {
          return res.status(500).json({ detail: `Failed to start database container: ${e.message}` });
        }
      }
      try {
        const container = orchestration.docker.getContainer(`zynkara-app-${project.id}`);
        await container.start();
      } catch (e) {
        return res.status(500).json({ detail: `Failed to start application container: ${e.message}` });
      }
    }

    await db.query('UPDATE projects SET status = $1 WHERE id = $2', ['active', project.id]);
    res.json({ message: "Project started successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: "Failed to start service containers" });
  }
});

app.delete('/api/projects/:project_id', loadCurrentUser, async (req, res) => {
  try {
    const projRes = await db.query(
      'SELECT * FROM projects WHERE id = $1 AND owner_id = $2',
      [req.params.project_id, req.currentUser.id]
    );
    if (projRes.rows.length === 0) {
      return res.status(404).json({ detail: "Project not found" });
    }

    // Stop and remove docker resources
    await orchestration.stopAndRemoveProjectContainers(req.params.project_id);

    // Delete database records
    await db.query('DELETE FROM projects WHERE id = $1', [req.params.project_id]);

    res.json({ message: "Project deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ detail: "Failed to destroy project resources" });
  }
});

// --- GITHUB INTEGRATION ENDPOINTS ---

// Check GitHub connection status
app.get('/api/github/status', loadCurrentUser, async (req, res) => {
  res.json({
    connected: !!req.currentUser.github_token,
    username: req.currentUser.github_username || null
  });
});

// Connect via Personal Access Token
app.post('/api/github/connect-token', loadCurrentUser, async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ detail: "GitHub personal access token is required" });
  }

  try {
    // Validate token by fetching the user profile
    const userResponse = await axios.get('https://api.github.com/user', {
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'ZynkaraShift-PaaS'
      }
    });

    const username = userResponse.data.login;
    if (!username) {
      return res.status(400).json({ detail: "Failed to retrieve GitHub username from token" });
    }

    // Save to database
    await db.query(
      'UPDATE users SET github_token = $1, github_username = $2 WHERE id = $3',
      [token, username, req.currentUser.id]
    );

    res.json({
      detail: "GitHub account connected successfully",
      username: username
    });
  } catch (err) {
    console.error("Error validating GitHub token:", err.response?.data || err.message);
    const msg = err.response?.data?.message || err.message;
    res.status(400).json({ detail: `Invalid GitHub token: ${msg}` });
  }
});

// Disconnect GitHub
app.delete('/api/github/disconnect', loadCurrentUser, async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET github_token = NULL, github_username = NULL WHERE id = $1',
      [req.currentUser.id]
    );
    res.json({ detail: "GitHub account disconnected successfully" });
  } catch (err) {
    console.error("Error disconnecting GitHub:", err);
    res.status(500).json({ detail: "Failed to disconnect GitHub account" });
  }
});

// Get GitHub OAuth URL
app.get('/api/github/oauth/url', loadCurrentUser, (req, res) => {
  const host = req.get('host');
  const isDefaultKey = GITHUB_CLIENT_ID === 'Ov23li0R90HCA9WIdJmD';
  const isLocalHost = host.includes('localhost') || host.includes('127.0.0.1') || host.includes('.local') || host.includes('github.dev');
  const bypassMock = process.env.BYPASS_MOCK_AUTH === 'true';

  if (!GITHUB_CLIENT_ID || (isDefaultKey && isLocalHost && !bypassMock)) {
    return res.json({ url: null, reason: "OAuth is not configured or using default developer keys on local environment." });
  }

  // Construct redirect URL dynamically using request host
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const redirectUri = `${protocol}://${host}/api/auth/oauth/github/callback`;

  // Encode the JWT token as state so we can identify the user on callback
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  const oauthUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=repo,user&state=${token}`;
  res.json({ url: oauthUrl });
});

// GitHub OAuth callback
app.get('/api/github/oauth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).send("Callback parameters 'code' and 'state' are required.");
  }

  let userId;
  try {
    // Authenticate the user using the state parameter containing the JWT token
    const decoded = jwt.verify(state, SECRET_KEY);
    const userQuery = await db.query('SELECT * FROM users WHERE email = $1', [decoded.sub]);
    if (userQuery.rows.length === 0) {
      return res.status(401).send("OAuth authentication failed: user not found.");
    }
    userId = userQuery.rows[0].id;
  } catch (err) {
    console.error("OAuth callback JWT verification failed:", err);
    return res.status(401).send("OAuth state verification failed. Session may have expired.");
  }

  try {
    // Exchange code for token
    const tokenResponse = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code: code
      },
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'ZynkaraShift-PaaS'
        }
      }
    );

    const accessToken = tokenResponse.data.access_token;
    if (!accessToken) {
      console.error("OAuth access token response:", tokenResponse.data);
      return res.status(400).send(`Failed to retrieve access token: ${tokenResponse.data.error_description || tokenResponse.data.error || 'Unknown error'}`);
    }

    // Retrieve GitHub user profile
    const userResponse = await axios.get('https://api.github.com/user', {
      headers: {
        'Authorization': `token ${accessToken}`,
        'User-Agent': 'ZynkaraShift-PaaS'
      }
    });

    const username = userResponse.data.login;
    if (!username) {
      return res.status(400).send("Failed to retrieve username from GitHub profile.");
    }

    // Save to user
    await db.query(
      'UPDATE users SET github_token = $1, github_username = $2 WHERE id = $3',
      [accessToken, username, userId]
    );

    // Redirect back to dashboard
    res.redirect('/?github_connected=true');
  } catch (err) {
    console.error("GitHub OAuth Callback error:", err.response?.data || err.message);
    res.status(500).send(`GitHub authentication error: ${err.message}`);
  }
});

// Fetch user's GitHub repositories
app.get('/api/github/repos', loadCurrentUser, async (req, res) => {
  const token = req.currentUser.github_token;
  if (!token) {
    return res.status(400).json({ detail: "GitHub account not connected" });
  }

  try {
    // List user repositories (public & private)
    const reposResponse = await axios.get(
      'https://api.github.com/user/repos?per_page=100&sort=updated',
      {
        headers: {
          'Authorization': `token ${token}`,
          'User-Agent': 'ZynkaraShift-PaaS'
        }
      }
    );

    const repos = reposResponse.data.map(repo => ({
      name: repo.full_name,
      private: repo.private,
      default_branch: repo.default_branch
    }));

    res.json(repos);
  } catch (err) {
    console.error("Error fetching GitHub repos:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      detail: `Failed to load GitHub repositories: ${err.response?.data?.message || err.message}`
    });
  }
});

// Fetch branches for a specific repository
app.get('/api/github/repos/:owner/:repo/branches', loadCurrentUser, async (req, res) => {
  const token = req.currentUser.github_token;
  if (!token) {
    return res.status(400).json({ detail: "GitHub account not connected" });
  }

  const { owner, repo } = req.params;

  try {
    const branchesResponse = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`,
      {
        headers: {
          'Authorization': `token ${token}`,
          'User-Agent': 'ZynkaraShift-PaaS'
        }
      }
    );

    const branches = branchesResponse.data.map(b => b.name);
    res.json(branches);
  } catch (err) {
    console.error(`Error fetching branches for ${owner}/${repo}:`, err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      detail: `Failed to load branches: ${err.response?.data?.message || err.message}`
    });
  }
});

// --- REAL-TIME TELEMETRY & RUNTIME STATS ---

app.get('/api/projects/:project_id/telemetry', loadCurrentUser, async (req, res) => {
  try {
    const projRes = await db.query(
      'SELECT id, name, subdomain, app_port, status FROM projects WHERE id = $1 AND owner_id = $2',
      [req.params.project_id, req.currentUser.id]
    );
    if (projRes.rows.length === 0) {
      return res.status(404).json({ detail: "Project not found" });
    }
    const telemetry = await orchestration.getContainerTelemetry(req.params.project_id);
    res.json(telemetry);
  } catch (err) {
    console.error("Telemetry error:", err);
    res.status(500).json({ detail: "Failed to query container telemetry" });
  }
});

// --- NATURAL LANGUAGE SECRET & ENV INJECTION ROUTE ---

app.post('/api/projects/:project_id/env', loadCurrentUser, async (req, res) => {
  const { project_id } = req.params;
  if (!project_id || !/^[0-9a-f-]{36}$/i.test(project_id)) {
    return res.status(400).json({ detail: "Invalid project ID format." });
  }

  const { env_vars, app_port } = req.body;

  const envValidation = validateEnvVars(env_vars);
  if (!envValidation.valid) {
    return res.status(400).json({ detail: envValidation.detail });
  }
  const sanitizedInputEnvs = envValidation.sanitized;

  if (app_port) {
    const p = parseInt(app_port, 10);
    if (isNaN(p) || p <= 0 || p > 65535) {
      return res.status(400).json({ detail: "Invalid port specification." });
    }
  }

  try {
    const projRes = await db.query(
      'SELECT * FROM projects WHERE id = $1 AND owner_id = $2',
      [project_id, req.currentUser.id]
    );
    if (projRes.rows.length === 0) {
      return res.status(404).json({ detail: "Project not found" });
    }
    const project = projRes.rows[0];

    // Update app port if specified
    if (app_port && parseInt(app_port, 10) !== project.app_port) {
      project.app_port = parseInt(app_port, 10);
      await db.query('UPDATE projects SET app_port = $1 WHERE id = $2', [project.app_port, project.id]);
    }

    // Retrieve latest deployment to get app image and existing envs
    const depRes = await db.query(
      'SELECT * FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
      [project.id]
    );
    const latestDeploy = depRes.rows[0];
    const currentImage = latestDeploy ? latestDeploy.app_image : (project.github_repo ? `zynkara-local-${project.id.replace(/-/g, '')}:latest` : 'nginx:alpine');
    const existingEnvs = (latestDeploy && latestDeploy.env_vars) ? latestDeploy.env_vars : {};
    const mergedEnvs = { ...existingEnvs, ...(sanitizedInputEnvs || {}) };

    // Update deployment record with merged environment map
    if (latestDeploy) {
      await db.query('UPDATE deployments SET env_vars = $1 WHERE id = $2', [JSON.stringify(mergedEnvs), latestDeploy.id]);
    }

    // Zero-downtime rolling restart with newly injected environment variables
    await orchestration.deployApp(
      project.owner_id,
      project.id,
      project.subdomain,
      currentImage,
      project.app_port,
      mergedEnvs,
      {},
      {
        probeUrl: `http://${project.subdomain}.localhost`,
        timeoutSeconds: 15,
        onProgress: console.log
      }
    );

    res.json({
      message: "Variables injected and container gracefully restarted",
      env_vars: mergedEnvs,
      app_port: project.app_port
    });
  } catch (err) {
    console.error("Environment injection error:", err);
    res.status(500).json({ detail: `Failed to inject environment variables: ${err.message}` });
  }
});

// --- CHATBOT ASSISTANT ---

app.post('/api/chat', loadCurrentUser, async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ detail: "Message text is required" });
  }

  // Retrieve user projects to provide contextual intent matching
  let userProjects = [];
  try {
    const projQuery = await db.query(
      'SELECT id, name, subdomain, app_port, status, github_repo FROM projects WHERE owner_id = $1 ORDER BY created_at DESC',
      [req.currentUser.id]
    );
    userProjects = projQuery.rows;
  } catch (e) {
    console.warn("Failed to load user projects for chat context:", e);
  }

  const { reply, actionPayload } = await parseChatbotIntent(message, {
    projects: userProjects,
    telemetryService: orchestration
  });

  res.json({ reply, action_payload: actionPayload });
});

// --- PLATFORM CONFIG ---

app.get('/api/config', (req, res) => {
  res.json({ platform_domain: PLATFORM_DOMAIN });
});

// --- FRONTEND STATIC MOUNTING ---
const frontendDistPath = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send('Control Plane API running. React Frontend needs to be built with npm run build.');
  });
}

// Start Server
db.initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`ZynkaraShift Control Plane API listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database on startup:", err);
  });

# ☁️ ZynkaraShift: Self-Hosted PaaS Platform

A production-ready, self-hosted, multi-tenant Platform-as-a-Service. Deploy applications and isolated databases from Docker images or Git repositories, obtain automatic subdomains with SSL, and keep every tenant workload strictly isolated.

<p align="center">
  <img src="docs/zynkarashift_demo.webp" alt="ZynkaraShift Platform Demo" width="100%" />
</p>

ZynkaraShift runs on any Linux or Windows host using Docker Desktop or Docker Engine. It unites **Traefik** (dynamic subdomain routing and automatic Let's Encrypt TLS), **Docker container orchestration** with kernel-level resource hard caps, a **Zero-Config Buildpack Engine**, a **Self-Healing Watchdog**, and a **Subscription & Access Control Gate**.

---

## ✨ Key Features

- 🚀 **Deploy from Docker Images or Git Repositories:** Deploy pre-built Docker Hub images or connect a Git repository.
- 📦 **Zero-Config Buildpack Engine:** Auto-detects frameworks (Next.js, React SPA, Vite, Vue/Nuxt, Python, Go, Rust, Static HTML) and synthesizes multi-stage production Dockerfiles on the fly.
- 🤖 **AI Deployment Copilot:** Natural language orchestration assistant (e.g., *"Deploy image nginx:alpine name app-1 with postgres"*).
- 🌐 **Automatic Subdomains & TLS:** Dynamic reverse proxying via Traefik without downtime or reloads. Automatic Let's Encrypt SSL/TLS certificates and HTTPS redirection.
- 🔒 **Dual-Network Container Isolation:** Application containers communicate across private per-project bridge networks (`zynkara-project-{id}`). Database containers have zero exposed host ports.
- 🗄️ **One-Click Managed Databases:** Provision isolated PostgreSQL, MySQL, MongoDB, and Redis instances with host-persisted volumes.
- 📏 **Hard Resource Caps & Sandboxing:** Containers are enforced with 512 MB RAM (+ 512 MB swap), 0.5 CPU core quota, 100–150 PID limit, dropped capabilities (`ALL`), and `no-new-privileges:true`.
- ⏱️ **Self-Healing Post-Boot Watchdog:** 30-second post-boot telemetry monitor that detects crash loops or non-zero exit codes and automatically triggers rollbacks to previous stable builds.
- 🔐 **Enterprise Auth & Security Suite:** Email verification with SMTP, Disposable Email Domain blocking (Abstract API + static blocklist), Google & GitHub OAuth, rate-limiting, and RBAC admin approval workflows.
- 💳 **Tiered Project Limits:** Free tier enforcement (3 active projects limit) with simulated or Stripe-backed subscription upgrades.

---

## 🧱 Tech Stack

| Layer | Technology |
|---|---|
| **Control Plane API** | Node.js, Express, Dockerode, PG |
| **Relational Database** | PostgreSQL 15 (Control plane state & metadata) |
| **Reverse Proxy & Ingress** | Traefik v2.11 (Docker provider, ACME Let's Encrypt) |
| **Container Engine** | Docker, Docker Compose |
| **Frontend Dashboard** | React 19, Vite, Vanilla CSS |
| **Buildpacks Engine** | Built-in multi-stage Dockerfile synthesizer |
| **Deployment Targets** | Localhost (Docker Desktop) & Azure Linux VMs |

---

## 📸 Screenshots

| **Dashboard & AI Deployment Copilot** |
|:---:|
| ![ZynkaraShift Dashboard](docs/dashboard_main.png) |

| **Project Deployment Modal** |
|:---:|
| ![Deploy Project Modal](docs/deploy_modal.png) |

---

## 1. System Architecture & Topology

Secure traffic routing from public web clients to isolated containerized services:

```
┌────────────────────────────────────────────────────────┐
│                   Public Web Client                    │
└───────────────────────────┬────────────────────────────┘
                            │
                            │ HTTP / HTTPS (*.zynkarashift.me / *.localhost)
                            ▼
┌────────────────────────────────────────────────────────┐
│                 Traefik Reverse Proxy                  │
│             (Let's Encrypt ACME TLS / Port 80, 443)    │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────┴────────────────────────────┐
│ Traefik Network: zynkara-traefik-net                   │
└──────────────┬─────────────────────────────────────────┘
               │
               ▼
┌────────────────────────────────────────────────────────┐
│ Project Isolated Network: zynkara-project-{project_id} │
│                                                        │
│  ┌───────────────────────┐       ┌──────────────────┐  │
│  │     App Container     │◄─────►│   DB Container   │  │
│  │ (zynkara-app-{id})    │       │ (zynkara-db-{id})│  │
│  │  Labels: traefik.     │       │  Postgres/MySQL/ │  │
│  │  enable=true;         │       │  MongoDB/Redis   │  │
│  │  mem_limit=512m;      │       │ (Volume mapped,  │  │
│  │  nano_cpus=0.5 CPU    │       │  No exposed ports│  │
│  └───────────────────────┘       └──────────────────┘  │
│                                                        │
└────────────────────────────────────────────────────────┘
```

---

## 2. Infrastructure & Orchestration Highlights

### Dual-Network Isolation & Reverse Proxy Routing
- **Dynamic Traefik Discovery:** Traefik listens on `/var/run/docker.sock` to detect application containers dynamically without requiring restarts.
- **Dual-Network Attachment:**
  - The application container (`zynkara-app-{project_id}`) attaches to `zynkara-traefik-net` (for incoming HTTP/HTTPS proxying) and `zynkara-project-{project_id}` (for database communication).
  - The database container (`zynkara-db-{project_id}`) attaches **only** to `zynkara-project-{project_id}`.
- **Zero Exposed Database Ports:** Databases are never bound to the host network interface or the public internet. Application containers communicate internally using Docker's embedded DNS (`db-service`).

### Resource Caps & Hardening
- **Resource Limits:** Docker SDK sets `Memory: 512MB`, `MemorySwap: 1GB`, `NanoCpus: 500000000` (0.5 CPU core quota).
- **Process & Privilege Security:** Containers run with `SecurityOpt: ['no-new-privileges:true']`, `PidsLimit: 100`, and `CapDrop: ['ALL']` to prevent privilege escalations and fork bombs.
- **Persistent Storage:** Databases bind-mount state to `/var/zynkara/volumes/{owner_id}/{project_id}/{db_type}`.

### Zero-Config Buildpack Engine
- When deploying from source or Git repositories, `buildpacks.js` inspects repository manifests (`package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, etc.).
- Automatically creates lean, multi-stage production Docker images and exposes the designated application ports (e.g., 3000 for Next.js, 80 for static/SPA).

### Self-Healing Post-Boot Watchdog
- `watchdog.js` conducts a 30-second post-boot telemetry check on newly deployed containers.
- If a container enters a crash loop or exits prematurely, the engine automatically rolls back the deployment to the previous known stable image and generates diagnostics in the deployment log.

### Access Control & The 3-Project Free Limit
- **Admin Access Gating:** New users register with `access_status: 'pending'`. The platform administrator approves or declines account requests via the Admin Console.
- **Subscription Limit Guard:** Free users can deploy up to **3 active projects**. Deploying a 4th project triggers an HTTP `403 Forbidden` response:
  ```json
  {
    "error": "Subscription required",
    "message": "You have reached the maximum limit of 3 free deployed projects. Please upgrade to a premium tier to unlock unlimited deployments."
  }
  ```
- **Stripe & Simulated Upgrade:** Users can upgrade directly via the UI modal to unlock unlimited deployments.

---

## 3. Getting Started

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows / macOS) or [Docker Engine](https://docs.docker.com/engine/) with Docker Compose v2 (Linux).

### Quickstart

1. **Clone the repository:**
   ```bash
   git clone https://github.com/MEHTHAB-N-M/Zynkara_Shift.git
   cd Zynkara_Shift
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.production.example .env
   ```
   *Edit `.env` to set your PostgreSQL credentials and domain (default: `PLATFORM_DOMAIN=zynkarashift.me` or `localhost`).*

3. **Start the platform:**
   ```bash
   docker compose up -d
   ```

4. **Initialize the administrator account:**
   ```bash
   docker compose exec control-plane-api node create_admin.js
   ```
   *(Or run `node create_admin.js` directly within the `backend/` directory).*

5. **Open the dashboard:**
   - Local: [http://localhost:8000](http://localhost:8000) or [http://zynkara.localhost](http://zynkara.localhost)
   - Public domain: `https://your-domain.com` (if configured with DNS and SSL)

---

## 4. Verification Workflow

1. **Sign Up & Approve Account:**
   - Open the web dashboard, click **Sign Up**, and create an account with a valid email.
   - Run `node create_admin.js` or log in as the administrator to approve the pending access request.

2. **Deploy Applications:**
   - Deploy an image (e.g. `nginx:alpine` or `redis:alpine`) or use the AI Copilot:
     ```
     Deploy image nginx:alpine name web-preview port 80
     ```
   - Watch build logs stream in real time. Once active, test your new subdomain: `http://web-preview.localhost` (or `https://web-preview.your-domain.com`).

3. **Verify Isolated Databases:**
   - Deploy an application with a database attached (e.g. PostgreSQL).
   - Inspect the database container:
     ```bash
     docker inspect zynkara-db-<project_id>
     ```
   - Verify that **no host ports are published** and it is only connected to `zynkara-project-<project_id>`.

4. **Verify the 3-Project Limit & Upgrade:**
   - Deploy 3 test applications under a free account.
   - Attempt a 4th deployment; verify that the platform returns a `403 Subscription required` notification and presents the upgrade overlay.
   - Complete the upgrade flow to confirm unlimited deployments are unlocked.

---

## 5. Cloud & Production Deployment

For deploying ZynkaraShift to an Azure Virtual Machine or custom Linux VPS with automatic Let's Encrypt SSL and firewall rules, refer to:
- [AZURE_DEPLOYMENT.md](AZURE_DEPLOYMENT.md)
- [deploy-azure.sh](deploy-azure.sh)

---

## ⚠️ Security Notes

- The control plane and Traefik containers require read/write access to `/var/run/docker.sock` to orchestrate dynamic containers and networks. Run ZynkaraShift in a trusted or dedicated host environment.
- Always generate a strong, random `JWT_SECRET` and secure database passwords before hosting publicly.

---

## 👤 Author

**Mehthab N M**  
[Portfolio](https://mehthab-n-m.github.io/) · [LinkedIn](https://www.linkedin.com/in/mehthab-n-m-637611344) · [GitHub](https://github.com/MEHTHAB-N-M)

# ☁️ ZynkaraShift: Self-Hosted PaaS Platform

A zero-cost, self-hosted, multi-tenant Platform-as-a-Service. Deploy apps and databases from Docker images, get a public subdomain automatically, and keep every project isolated.

<p align="center">
  <img src="docs/zynkarashift_demo.webp" alt="ZynkaraShift Platform Demo" width="100%" />
</p>

ZynkaraShift runs on a local Linux or Windows host using Docker Desktop. It combines Traefik (dynamic subdomain routing via Docker labels), Docker container orchestration with memory/CPU hard caps, and a subscription gateway that limits free users to 3 active projects.

## ✨ Key Features

- 🚀 **One-click deployment** of apps from Docker images
- 🤖 **AI deployment assistant** (e.g. "Deploy image nginx:alpine name app-1")
- 🌐 **Automatic subdomain** per project via Traefik, with no restarts
- 🔒 **Isolated container networking** with strict per-project private bridge networks
- 🗄️ **Isolated databases** per project (Postgres, MySQL, MongoDB, Redis)
- 📏 **Hard resource caps:** 512 MB RAM and 0.5 CPU per container
- 💳 **Free tier (3 projects)** with a simulated Stripe upgrade flow

## 🧱 Tech Stack

| Layer | Technology |
|---|---|
| **Control plane API** | Python, FastAPI, Docker SDK |
| **Database** | PostgreSQL |
| **Reverse proxy** | Traefik |
| **Containers** | Docker, Docker Compose |
| **Frontend** | JavaScript (React, Vite) |
| **CI/CD** | GitHub Actions |

## 📸 Screenshots

| **Dashboard & AI Deployment Copilot** |
|:---:|
| ![ZynkaraShift Dashboard](docs/dashboard_main.png) |

| **Project Deployment Modal** |
|:---:|
| ![Deploy Project Modal](docs/deploy_modal.png) |

## 1. System Topology Diagram

Secure traffic routing from public clients to isolated containerized services:

```
┌──────────────────────────────┐
│      Public Web Client       │
└──────────────┬───────────────┘
               │
               │ HTTP (Wildcard: *.zynkarashift.duckdns.org / localhost)
               ▼
┌──────────────────────────────┐
│    Traefik Reverse Proxy     │
│  (Host Header: app.your...)  │
└──────────────┬───────────────┘
               │
┌──────────────┴──────────────────────────┐
│ Traefik Net: zynkarashift-traefik-net   │
└──────────────┬──────────────────────────┘
               │
               ▼
┌────────────────────────────────────────────────────────┐
│ Project Isolated Network: zynkarashift-net-{project_id}│
│                                                        │
│  ┌───────────────────────┐       ┌──────────────────┐  │
│  │     App Container     │◄─────►│   DB Container   │  │
│  │ (Labels: traefik.     │       │ (Postgres/MySQL/ │  │
│  │  enable=true;         │       │  MongoDB/Redis)  │  │
│  │  mem_limit=512m;      │       │ (Volume mapped,  │  │
│  │  nano_cpus=0.5 CPU)   │       │  No exposed ports│  │
│  └───────────────────────┘       └──────────────────┘  │
│                                                        │
└────────────────────────────────────────────────────────┘
```

## 2. Infrastructure Design Highlights

### Networking & Reverse Proxy Hardening
- **Dynamic Traefik Subdomains:** Traefik listens on `/var/run/docker.sock` and automatically discovers newly created application containers. Based on labels injected by the orchestration service (e.g. `traefik.http.routers.zynkarashift-router-{id}.rule=Host(...)`), Traefik maps the custom subdomain without restarting.
- **Container Isolation (Dual-Network Architecture):**
  - The application container is attached to both `zynkarashift-traefik-net` (so Traefik can proxy HTTP traffic to it) and `zynkarashift-net-{project_id}` (so it can query its database).
  - The database container (Postgres, MySQL, MongoDB, or Redis) is **only** attached to the isolated project network `zynkarashift-net-{project_id}`.
  - **Zero exposed ports for databases:** database ports are not published to the host or the public internet. Communication happens over the private bridge network via Docker's internal DNS (`db-service`).

### Dynamic Orchestration Service
- **Volume persistence:** Maps host volumes to prevent data loss during container restarts (bind-mapped at `/var/zynkarashift/volumes/{tenant_id}/{project_id}/{db_type}`).
- **Hard resource caps:** Containers are limited to 512 MB RAM and 0.5 CPU cores using the Docker SDK:
  - `mem_limit="512m"`
  - `nano_cpus=500000000` (half a core)

### Relational Database Schema
The control plane uses PostgreSQL to manage state:
- **`User`:** accounts and `subscription_status` (`'free'` or `'premium'`)
- **`Project`:** workspaces, subdomains, database types, and statuses
- **`Deployment`:** image tags, injected environment variables, and build/stdout logs

### The 3-Free-Projects Subscription Gate
- **FastAPI dependency guardrail:** On project creation, the user's active project count is checked. If they have 3 active projects and are not premium, the request returns HTTP `403 Forbidden`:
  ```json
  {
    "detail": {
      "error": "Subscription required",
      "message": "You have reached the maximum limit of 3 free deployed projects. Please upgrade to a premium tier to unlock unlimited deployments."
    }
  }
  ```
- **Stripe checkout modal:** The UI catches the 403, locks the deploy form, and shows a card-checkout modal that simulates an upgrade (no real payments are processed).

---

### ⚠️ Security Notes
Traefik and the orchestration service access `/var/run/docker.sock`, which grants broad control over the host's Docker daemon. This design is intended for a trusted, self-hosted environment.

The seeded demo credentials below are for local testing only. Change or remove them before exposing the platform publicly.

---

## 3. Getting Started

### Prerequisites
- Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) on Windows or Linux.

### Startup Instructions
1. **Clone the repository:**
   ```bash
   git clone https://github.com/MEHTHAB-N-M/Zynkara_Shift.git
   cd Zynkara_Shift
   ```

2. **Start the control plane:**
   ```bash
   docker compose up -d
   ```

3. Open `http://localhost:8000` or `http://zynkarashift.localhost` to access the dashboard.

### Demo Credentials (Seeded, local testing only)

| Account | Email | Password |
|---|---|---|
| **Free** | `free@sovereign.local` | `password123` |
| **Premium** | `premium@sovereign.local` | `password123` |

---

## 4. Verification Workflow

1. **Verify the 3-project limit (free user):**
   - Log in as `free@sovereign.local`.
   - Deploy 3 test apps (via quick deploy or the AI assistant, e.g. `"Deploy image nginx:alpine name app-1"`).
   - Try to deploy a 4th app.
   - **Expected:** The backend returns `403 Forbidden`, and the dashboard locks the deploy form and opens the checkout overlay.

2. **Upgrade to Premium:**
   - Complete the card form and click **Pay $15** (simulated).
   - **Expected:** A `POST` to `/api/subscription/upgrade` updates the database, the badge changes to `PREMIUM`, and the 4th deployment completes.

3. **Verify isolated databases:**
   - Run `docker inspect zynkarashift-db-<project_id>` and confirm no ports are published and it is only on `zynkarashift-net-{project_id}`.
   - Run `docker inspect zynkarashift-app-<project_id>` and confirm it is on both `zynkarashift-traefik-net` and `zynkarashift-net-{project_id}`.

---

## 👤 Author

**Mehthab N M**  
[Portfolio](https://mehthab-n-m.github.io/My_portfolio/) · [LinkedIn](https://www.linkedin.com/in/mehthab-n-m-637611344) · [GitHub](https://github.com/MEHTHAB-N-M)

# ZynkaraShift — Azure Student Deployment Guide

Complete step-by-step guide to deploy ZynkaraShift PaaS on an **Azure for Students** free VM (Standard_B2s: 2 vCPU, 4 GB RAM).

---

## Prerequisites

- A school/university email (`.edu` or institutional email)
- A GitHub account with your code pushed to a repository

---

## Step 1: Sign Up for Azure for Students (Free, No Credit Card)

1. Go to: **https://azure.microsoft.com/en-us/free/students/**
2. Click **"Start for free"**
3. Sign in with your **Microsoft account** (or create one)
4. Verify your student status using your **school email**
5. You'll receive **$100 in Azure credits** — no credit card needed

> **Tip:** The B2s VM (~$30/month) will last ~3 months on your $100 credit. You can also stop the VM when not needed to save credits.

---

## Step 2: Create the Azure VM

### Option A: Azure Portal (GUI — Easiest)

1. Go to **https://portal.azure.com**
2. Click **"Create a resource"** → **"Virtual Machine"**
3. Fill in:

| Setting | Value |
|---|---|
| **Subscription** | Azure for Students |
| **Resource group** | Create new → `rg-zynkarashift` |
| **VM name** | `zynkarashift-vm` |
| **Region** | Pick closest to you (e.g., East US, West Europe, Southeast Asia) |
| **Image** | Ubuntu Server 24.04 LTS - x64 Gen2 |
| **Size** | Standard_B2s (2 vCPU, 4 GiB RAM) |
| **Authentication** | SSH public key |
| **Username** | `azureuser` |
| **SSH key** | Generate new key pair (download the `.pem` file!) |

4. **Networking tab** → Under "Select inbound ports", check:
   - SSH (22)
   - HTTP (80)
   - HTTPS (443)

5. Click **"Review + create"** → **"Create"**
6. **Download the SSH private key** when prompted (save it safely!)
7. Wait ~2 minutes for deployment to complete
8. Go to your VM → **Copy the Public IP address**

### Option B: Azure CLI (Script)

If you have Azure CLI installed:

```bash
# Login
az login

# Run the provisioning script
chmod +x azure/provision-vm.sh
./azure/provision-vm.sh
```

---

## Step 3: Connect to Your VM via SSH

```bash
# On Windows (PowerShell) — use the .pem key you downloaded
ssh -i ~/Downloads/zynkarashift-vm_key.pem azureuser@<YOUR_VM_PUBLIC_IP>

# On Mac/Linux
chmod 400 ~/Downloads/zynkarashift-vm_key.pem
ssh -i ~/Downloads/zynkarashift-vm_key.pem azureuser@<YOUR_VM_PUBLIC_IP>
```

Replace `<YOUR_VM_PUBLIC_IP>` with the actual IP from Azure Portal (e.g., `20.85.123.45`).

---

## Step 4: Clone Your Repository

```bash
# On the Azure VM (after SSH-ing in)
git clone https://github.com/YOUR_USERNAME/Vaporup.git
cd Vaporup
```

---

## Step 5: Configure Environment Variables

```bash
# Copy the production templates
cp .env.production.example .env
cp backend/.env.production.example backend/.env

# Edit root .env
nano .env
```

Set these values in `.env`:
```
POSTGRES_DB=VaporupDeploy
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<generate-a-strong-password>
PLATFORM_DOMAIN=zynkarashift.duckdns.org
```

Then edit `backend/.env`:
```bash
nano backend/.env
```

Key values to set:
```
JWT_SECRET=<run: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
POSTGRES_PASSWORD=<same-as-root-.env>
DATABASE_URL=postgresql://postgres:<same-password>@postgres-control:5432/VaporupDeploy
SEED_ADMIN_PASSWORD=<your-admin-password>
```

**Important:** The `DATABASE_URL` in `backend/.env` must use `postgres-control` as the host (not `localhost`), because inside Docker Compose the containers communicate via service names.

---

## Step 6: Run the Deployment Script

```bash
sudo chmod +x deploy-azure.sh
sudo ./deploy-azure.sh
```

This script will:
1. Install Docker Engine & Docker Compose
2. Install Node.js 20 LTS
3. Create `/var/zynkara/volumes` for tenant database persistence
4. Build the React frontend → `frontend/dist/`
5. Pull all Docker images
6. Start all 3 services (PostgreSQL, API, Traefik)
7. Wait for PostgreSQL health check

---

## Step 7: Verify Everything is Running

```bash
# Check all containers are running
docker compose ps

# Expected output:
# NAME                          STATUS
# zynkara-postgres-control      Up (healthy)
# zynkara-control-plane-api     Up
# zynkara-traefik               Up

# View logs
docker compose logs -f control-plane-api
```

Access your platform at: **http://YOUR_VM_PUBLIC_IP:8000**

---

## Step 8: Set Up a Free Domain (DuckDNS)

1. Go to **https://www.duckdns.org/**
2. Sign in with GitHub/Google
3. Create a subdomain (e.g., `zynkarashift`) → point it to your **Azure VM Public IP**
4. Update your `.env`:
   ```
   PLATFORM_DOMAIN=zynkarashift.duckdns.org
   ```
5. Restart:
   ```bash
   docker compose down && docker compose up -d
   ```

Now your platform is accessible at: **http://zynkarashift.duckdns.org**

---

## Step 9: Set Up GitHub Actions CI/CD (Optional)

To enable automatic deployment when you push to `main`:

1. Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. Add these **Repository Secrets**:

| Secret Name | Value |
|---|---|
| `AZURE_VM_HOST` | Your VM's public IP (e.g., `20.85.123.45`) |
| `AZURE_VM_USER` | `azureuser` |
| `AZURE_VM_SSH_KEY` | Contents of your `.pem` private key file |

3. Push to `main` — the workflow will automatically build the frontend, SSH into your VM, pull the latest code, and restart Docker Compose.

---

## Useful Commands (SSH into VM)

```bash
# View all container logs
docker compose logs -f

# View only backend logs
docker compose logs -f control-plane-api

# Restart everything
docker compose restart

# Full rebuild
docker compose down && docker compose up -d --build

# Check resource usage (important with 4GB RAM!)
docker stats --no-stream

# Seed the database with default accounts
docker compose exec control-plane-api node seed.js
```

---

## Cost Management Tips

| Action | Savings |
|---|---|
| **Stop VM when not using** | $0/hour while stopped (only storage cost) |
| **Set auto-shutdown** | Azure Portal → VM → Auto-shutdown → Set time |
| **Monitor credits** | Portal → Cost Management → Credit balance |

To set auto-shutdown:
1. Azure Portal → Your VM → **Auto-shutdown**
2. Enable → Set time (e.g., 2:00 AM your timezone)
3. Save

**Warning:** When the VM is stopped, your platform goes offline. Start it from Azure Portal when needed. All data persists in Docker volumes.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Can't SSH into VM | Check NSG rules allow port 22. Check your `.pem` key path |
| `docker: permission denied` | Run `sudo usermod -aG docker $USER` then logout/login |
| PostgreSQL won't start | Check `docker compose logs postgres-control` for password errors |
| Frontend shows blank page | Ensure `frontend/dist/` exists. Run `npm run build` in frontend/ |
| Out of RAM | Run `docker stats`. Stop unused tenant containers |
| API returns CORS error | Check `PLATFORM_DOMAIN` in `.env` matches your actual domain |
| Credits running low | Stop VM when not in use via Azure Portal |

---

## Architecture on Azure

```
        Internet
           |
           | http://zynkarashift.duckdns.org
           v
   +-------------------------------------------+
   |  Azure VM (Standard_B2s - 4 GB RAM)       |
   |                                           |
   |   Traefik (:80) --> Control Plane (:8000) |
   |                          |                |
   |                     PostgreSQL (:5432)     |
   |                          |                |
   |              +-----------+-----------+    |
   |              v                       v    |
   |        User App #1             User App #2|
   |        (512MB cap)             (512MB cap) |
   |             |                       |     |
   |        User DB #1             User DB #2  |
   |       (Isolated Net)         (Isolated Net)|
   +-------------------------------------------+
```

---

## Future: Migrating to Oracle Cloud

When you get a credit card later:
1. Sign up at **https://cloud.oracle.com/** (they won't charge you)
2. Create an **Always Free** Ampere A1 VM (4 OCPUs, 24 GB RAM)
3. SSH in, clone repo, run `sudo ./deploy-azure.sh` — the same script works on any Ubuntu VM
4. Point your DuckDNS domain to the new IP
5. Delete the Azure VM to stop credit consumption

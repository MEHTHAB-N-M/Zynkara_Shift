#!/usr/bin/env bash
# =============================================================================
# ZynkaraShift — Production Deployment Script (Ubuntu / Debian / Azure VM)
# =============================================================================
set -euo pipefail

echo ""
echo "=============================================="
echo "  ZynkaraShift — Production Deployment"
echo "=============================================="
echo ""

# Ensure script is run with root / sudo privileges
if [ "$EUID" -ne 0 ]; then
  echo "❌ Error: Please run this script as root: sudo ./deploy-azure.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1. Check environment configuration
if [ ! -f ".env" ]; then
  if [ -f ".env.production.example" ]; then
    echo "⚠️  Root .env not found. Copying .env.production.example to .env..."
    cp .env.production.example .env
    echo "⚠️  Please check and update .env if needed before continuing."
  fi
fi

if [ ! -f "backend/.env" ]; then
  if [ -f "backend/.env.production.example" ]; then
    echo "⚠️  backend/.env not found. Copying backend/.env.production.example to backend/.env..."
    cp backend/.env.production.example backend/.env
  fi
fi

# 2. System dependencies
echo "[1/6] Installing system prerequisites..."
apt-get update -y
apt-get install -y curl ca-certificates gnupg git

# 3. Install Docker Engine if missing
if ! command -v docker &> /dev/null; then
  echo "[2/6] Installing Docker Engine & Docker Compose plugin..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  echo "[2/6] Docker is already installed: $(docker --version)"
fi

# 4. Install Node.js 20 LTS if missing
if ! command -v node &> /dev/null; then
  echo "[3/6] Installing Node.js 20 LTS for frontend build..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "[3/6] Node.js is already installed: $(node -v)"
fi

# 5. Create volume mount directories
echo "[4/6] Creating host storage directory for tenant volumes..."
mkdir -p /var/zynkara/volumes
chmod 755 /var/zynkara/volumes

# 6. Build Frontend
echo "[5/6] Building production React frontend..."
cd frontend
npm ci --legacy-peer-deps || npm install --legacy-peer-deps
npm run build
cd ..

# 7. Start Docker Compose services
echo "[6/6] Pulling images and starting ZynkaraShift containers..."
docker compose pull || true
docker compose up -d

echo ""
echo "=============================================="
echo "  ZynkaraShift Deployed Successfully!         "
echo "=============================================="
echo ""
echo "Check container status:"
echo "  docker compose ps"
echo ""
echo "Stream control plane logs:"
echo "  docker compose logs -f control-plane-api"
echo ""
echo "Stream Traefik proxy logs:"
echo "  docker compose logs -f traefik"
echo "=============================================="

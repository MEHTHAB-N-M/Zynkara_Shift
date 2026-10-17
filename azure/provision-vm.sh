#!/usr/bin/env bash
# =============================================================================
# ZynkaraShift — Azure Student VM Provisioning Script
# =============================================================================
# Prerequisites:
#   1. Azure CLI installed: https://aka.ms/installazurecli
#   2. Logged in: az login
#   3. Student subscription active
#
# Usage:
#   chmod +x azure/provision-vm.sh
#   ./azure/provision-vm.sh
# =============================================================================

set -euo pipefail

# ── Configuration (customize these) ──────────────────────────────────────────
RESOURCE_GROUP="rg-zynkarashift"
LOCATION="centralindia"                 # Allowed region (centralindia, indiasouthcentral, koreacentral, eastasia)
VM_NAME="zynkarashift-vm"
VM_SIZE="Standard_B2s"               # 2 vCPU, 4 GB RAM — fits Azure Student free tier
VM_IMAGE="Canonical:ubuntu-24_04-lts:server:latest"
ADMIN_USER="azureuser"
NSG_NAME="nsg-zynkarashift"

echo ""
echo "=============================================="
echo "  ZynkaraShift — Azure VM Provisioning"
echo "=============================================="
echo ""

# ── Step 1: Create Resource Group ────────────────────────────────────────────
echo "[1/5] Creating resource group: $RESOURCE_GROUP in $LOCATION..."
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --output none

# ── Step 2: Create Network Security Group ────────────────────────────────────
echo "[2/5] Creating network security group with firewall rules..."
az network nsg create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$NSG_NAME" \
  --output none

# Allow SSH (port 22)
az network nsg rule create \
  --resource-group "$RESOURCE_GROUP" \
  --nsg-name "$NSG_NAME" \
  --name AllowSSH \
  --priority 1000 \
  --destination-port-ranges 22 \
  --protocol Tcp \
  --access Allow \
  --output none

# Allow HTTP (port 80) — Traefik
az network nsg rule create \
  --resource-group "$RESOURCE_GROUP" \
  --nsg-name "$NSG_NAME" \
  --name AllowHTTP \
  --priority 1010 \
  --destination-port-ranges 80 \
  --protocol Tcp \
  --access Allow \
  --output none

# Allow HTTPS (port 443) — for future Let's Encrypt
az network nsg rule create \
  --resource-group "$RESOURCE_GROUP" \
  --nsg-name "$NSG_NAME" \
  --name AllowHTTPS \
  --priority 1020 \
  --destination-port-ranges 443 \
  --protocol Tcp \
  --access Allow \
  --output none

# Allow Control Plane API (port 8000) — direct access fallback
az network nsg rule create \
  --resource-group "$RESOURCE_GROUP" \
  --nsg-name "$NSG_NAME" \
  --name AllowAPI \
  --priority 1030 \
  --destination-port-ranges 8000 \
  --protocol Tcp \
  --access Allow \
  --output none

# ── Step 3: Create the VM ───────────────────────────────────────────────────
echo "[3/5] Creating VM: $VM_NAME ($VM_SIZE)..."
az vm create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --image "$VM_IMAGE" \
  --size "$VM_SIZE" \
  --admin-username "$ADMIN_USER" \
  --generate-ssh-keys \
  --nsg "$NSG_NAME" \
  --public-ip-sku Standard \
  --os-disk-size-gb 30 \
  --output json

# ── Step 4: Get the Public IP ───────────────────────────────────────────────
echo "[4/5] Retrieving public IP address..."
PUBLIC_IP=$(az vm show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --show-details \
  --query publicIps \
  --output tsv)

# ── Step 5: Print connection info ───────────────────────────────────────────
echo "[5/5] Done!"
echo ""
echo "=============================================="
echo "  VM Created Successfully!"
echo "=============================================="
echo ""
echo "  Public IP:  $PUBLIC_IP"
echo "  SSH:        ssh ${ADMIN_USER}@${PUBLIC_IP}"
echo ""
echo "  Next steps:"
echo "  1. SSH into the VM:"
echo "     ssh ${ADMIN_USER}@${PUBLIC_IP}"
echo ""
echo "  2. Clone your repository:"
echo "     git clone https://github.com/YOUR_USER/Vaporup.git"
echo "     cd Vaporup"
echo ""
echo "  3. Configure environment files:"
echo "     cp .env.production.example .env"
echo "     cp backend/.env.production.example backend/.env"
echo "     nano .env          # Set POSTGRES_PASSWORD, PLATFORM_DOMAIN"
echo "     nano backend/.env  # Set JWT_SECRET, DATABASE_URL password"
echo ""
echo "  4. Run the deployment script:"
echo "     sudo chmod +x deploy-azure.sh"
echo "     sudo ./deploy-azure.sh"
echo ""
echo "  5. Access your platform:"
echo "     http://${PUBLIC_IP}:8000"
echo ""
echo "=============================================="

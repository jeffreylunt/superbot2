#!/bin/bash
# Uninstall the superbot2 heartbeat background service (cross-platform).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# shellcheck source=service-helper.sh
source "$REPO_DIR/scripts/service-helper.sh"

service_uninstall heartbeat
echo "Heartbeat uninstalled."

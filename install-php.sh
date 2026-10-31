#!/usr/bin/env bash
# Installs the static PHP 8.3 CLI (static-php-cli build: curl, openssl, pcntl, mbstring, sockets...)
# and composer.phar into ./.runtimes/bin — used by the platform when no system PHP exists.
# The platform also does this automatically on boot if PHP is missing.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH=$(uname -m); [ "$ARCH" = "arm64" ] && ARCH=aarch64
BASE=https://dl.static-php.dev/static-php-cli/common/
FILE=$(curl -fsSL "$BASE" | grep -oE "php-8\.3\.[0-9]+-cli-linux-${ARCH}\.tar\.gz" | sort -uV | tail -1)
mkdir -p .runtimes/bin
curl -fsSL "$BASE$FILE" | tar -xz -C .runtimes/bin php
chmod +x .runtimes/bin/php
curl -fsSL https://getcomposer.org/download/latest-stable/composer.phar -o .runtimes/bin/composer.phar
.runtimes/bin/php -v | head -1

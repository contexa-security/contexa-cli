#!/bin/sh
set -e

REPO="contexa-security/contexa-cli"
INSTALL_DIR="/usr/local/bin"
BIN="contexa"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

printf "${CYAN}"
printf "  ██████╗ ██████╗ ███╗   ██╗████████╗███████╗██╗  ██╗ █████╗ \n"
printf " ██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔════╝╚██╗██╔╝██╔══██╗\n"
printf " ██║     ██║   ██║██╔██╗ ██║   ██║   █████╗   ╚███╔╝ ███████║\n"
printf " ██║     ██║   ██║██║╚██╗██║   ██║   ██╔══╝   ██╔██╗ ██╔══██║\n"
printf " ╚██████╗╚██████╔╝██║ ╚████║   ██║   ███████╗██╔╝ ██╗██║  ██║\n"
printf "  ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝\n"
printf "${NC}"
printf "  AI-Native Zero Trust Security for Spring\n\n"

# Fetch latest version
VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

if [ -z "$VERSION" ]; then
  printf "  ${RED}Error: Could not fetch latest version${NC}\n"
  exit 1
fi

# Detect OS / ARCH
OS=$(uname -s); ARCH=$(uname -m)

case "$OS" in
  Linux*)
    case "$ARCH" in
      x86_64)  FILE="contexa-linux-x64" ;;
      aarch64) FILE="contexa-linux-arm64" ;;
      *) printf "  ${RED}Unsupported: $ARCH${NC}\n"; exit 1 ;;
    esac ;;
  Darwin*)
    case "$ARCH" in
      x86_64) FILE="contexa-macos-x64" ;;
      arm64)  FILE="contexa-macos-arm64" ;;
      *) printf "  ${RED}Unsupported: $ARCH${NC}\n"; exit 1 ;;
    esac ;;
  MINGW*|MSYS*|CYGWIN*)
    FILE="contexa-win-x64.exe"; BIN="contexa.exe"
    INSTALL_DIR="$HOME/.local/bin" ;;
  *) printf "  ${RED}Unsupported OS: $OS${NC}\n"; exit 1 ;;
esac

URL="https://github.com/${REPO}/releases/download/${VERSION}/${FILE}"

printf "  Version  : ${YELLOW}${VERSION}${NC}\n"
printf "  Platform : ${OS} ${ARCH}\n\n"
printf "  Downloading... "

mkdir -p "$INSTALL_DIR"
curl -fsSL "$URL" -o "${INSTALL_DIR}/${BIN}"
chmod +x "${INSTALL_DIR}/${BIN}"

printf "${GREEN}done${NC}\n\n"
printf "  ${GREEN}Contexa ${VERSION} installed!${NC}\n\n"
printf "  Get started:\n"
printf "    cd your-spring-project\n"
printf "    ${CYAN}contexa init${NC}\n\n"

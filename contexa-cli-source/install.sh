#!/bin/sh
set -e

REPO="contexa-security/contexa-cli"
INSTALL_DIR="/usr/local/bin"
BIN="contexa"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

printf "${CYAN}"
echo "  ██████╗ ██████╗ ███╗   ██╗████████╗███████╗██╗  ██╗ █████╗ "
echo " ██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔════╝╚██╗██╔╝██╔══██╗"
echo " ██║     ██║   ██║██╔██╗ ██║   ██║   █████╗   ╚███╔╝ ███████║"
echo " ██║     ██║   ██║██║╚██╗██║   ██║   ██╔══╝   ██╔██╗ ██╔══██║"
echo " ╚██████╗╚██████╔╝██║ ╚████║   ██║   ███████╗██╔╝ ██╗██║  ██║"
echo "  ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝"
printf "${NC}"
echo "  AI-Native Zero Trust Security for Spring"
echo ""

# 최신 버전 가져오기
VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

if [ -z "$VERSION" ]; then
  echo "${RED}Error: Could not fetch latest version${NC}"
  exit 1
fi

# OS / ARCH 감지
OS=$(uname -s); ARCH=$(uname -m)

case "$OS" in
  Linux*)
    case "$ARCH" in
      x86_64)  FILE="contexa-linux-x64" ;;
      aarch64) FILE="contexa-linux-arm64" ;;
      *) echo "${RED}Unsupported: $ARCH${NC}"; exit 1 ;;
    esac ;;
  Darwin*)
    case "$ARCH" in
      x86_64) FILE="contexa-macos-x64" ;;
      arm64)  FILE="contexa-macos-arm64" ;;
      *) echo "${RED}Unsupported: $ARCH${NC}"; exit 1 ;;
    esac ;;
  MINGW*|MSYS*|CYGWIN*)
    FILE="contexa-win-x64.exe"; BIN="contexa.exe"
    INSTALL_DIR="$HOME/.local/bin" ;;
  *) echo "${RED}Unsupported OS: $OS${NC}"; exit 1 ;;
esac

URL="https://github.com/${REPO}/releases/download/${VERSION}/${FILE}"

echo "  Version : ${YELLOW}${VERSION}${NC}"
echo "  Platform: ${OS} ${ARCH}"
echo ""

printf "  Downloading... "
mkdir -p "$INSTALL_DIR"
curl -fsSL "$URL" -o "${INSTALL_DIR}/${BIN}"
chmod +x "${INSTALL_DIR}/${BIN}"
echo "${GREEN}done${NC}"

echo ""
echo "${GREEN}  ✅ Contexa ${VERSION} installed!${NC}"
echo ""
echo "  Get started:"
echo "    cd your-spring-project"
echo "    ${CYAN}contexa init${NC}"
echo ""

#!/bin/sh
set -e

REPO="contexa-security/contexa-cli"
INSTALL_DIR="/usr/local/bin"
BIN="contexa"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'
YELLOW='\033[1;33m'; DIM='\033[2m'; BOLD='\033[1m'; NC='\033[0m'

# Box drawing characters
H='─'; V='│'; TL='╭'; TR='╮'; BL='╰'; BR='╯'

printf "\n"
printf "${CYAN}${BOLD}"
printf "  ░█████╗░░█████╗░███╗░░██╗████████╗███████╗██╗░░██╗░█████╗░\n"
printf "  ██╔══██╗██╔══██╗████╗░██║╚══██╔══╝██╔════╝╚██╗██╔╝██╔══██╗\n"
printf "  ██║░░╚═╝██║░░██║██╔██╗██║░░░██║░░░█████╗░░░╚███╔╝░███████║\n"
printf "  ██║░░██╗██║░░██║██║╚████║░░░██║░░░██╔══╝░░░██╔██╗░██╔══██║\n"
printf "  ╚█████╔╝╚█████╔╝██║░╚███║░░░██║░░░███████╗██╔╝░██╗██║░░██║\n"
printf "  ░╚════╝░░╚════╝░╚═╝░░╚══╝░░░╚═╝░░░╚══════╝╚═╝░░╚═╝╚═╝░░╚═╝\n"
printf "${NC}"
printf "  ${DIM}AI-Native Zero Trust Security Platform${NC}  ${CYAN}ctxa.ai${NC}\n"
printf "\n"

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
      x86_64)  FILE="contexa-linux-x64"; PLATFORM="Linux x64" ;;
      aarch64) FILE="contexa-linux-arm64"; PLATFORM="Linux ARM64" ;;
      *) printf "  ${RED}Unsupported: $ARCH${NC}\n"; exit 1 ;;
    esac ;;
  Darwin*)
    case "$ARCH" in
      x86_64) FILE="contexa-macos-x64"; PLATFORM="macOS x64" ;;
      arm64)  FILE="contexa-macos-arm64"; PLATFORM="macOS ARM64 (Apple Silicon)" ;;
      *) printf "  ${RED}Unsupported: $ARCH${NC}\n"; exit 1 ;;
    esac ;;
  MINGW*|MSYS*|CYGWIN*)
    FILE="contexa-win-x64.exe"; BIN="contexa.exe"
    INSTALL_DIR="$HOME/.local/bin"; PLATFORM="Windows x64" ;;
  *) printf "  ${RED}Unsupported OS: $OS${NC}\n"; exit 1 ;;
esac

URL="https://github.com/${REPO}/releases/download/${VERSION}/${FILE}"

# Info box
printf "  ${TL}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${TR}\n"
printf "  ${V}  Version  : ${YELLOW}%-39s${NC}${V}\n" "${VERSION}"
printf "  ${V}  Platform : %-39s${V}\n" "${PLATFORM}"
printf "  ${V}  Target   : ${DIM}%-39s${NC}${V}\n" "${INSTALL_DIR}/${BIN}"
printf "  ${BL}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${BR}\n"
printf "\n"

mkdir -p "$INSTALL_DIR"

# Download with cycling dot animation
curl -fsSL "$URL" -o "${INSTALL_DIR}/${BIN}" &
CURL_PID=$!
while kill -0 $CURL_PID 2>/dev/null; do
  printf "\r  ${DIM}Downloading .  ${NC}" ; sleep 0.3
  kill -0 $CURL_PID 2>/dev/null || break
  printf "\r  ${DIM}Downloading .. ${NC}" ; sleep 0.3
  kill -0 $CURL_PID 2>/dev/null || break
  printf "\r  ${DIM}Downloading ...${NC}" ; sleep 0.3
done
wait $CURL_PID
chmod +x "${INSTALL_DIR}/${BIN}"

printf "\r  ${GREEN}Downloaded successfully.${NC}            \n\n"

# Success box
printf "  ${TL}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${TR}\n"
printf "  ${V}  ${GREEN}${BOLD}Contexa ${VERSION} installed!${NC}                        ${V}\n"
printf "  ${V}                                                  ${V}\n"
printf "  ${V}  Get started:                                    ${V}\n"
printf "  ${V}    ${CYAN}cd${NC} your-spring-project                       ${V}\n"
printf "  ${V}    ${CYAN}contexa init${NC}                                 ${V}\n"
printf "  ${BL}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${H}${BR}\n"
printf "\n"

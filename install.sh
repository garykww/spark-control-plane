#!/bin/bash
#
# Spark Control Plane installer.
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/garykww/spark-control-plane/main/install.sh)"
#
# Clones the repo into ~/.spark-control-plane, installs dependencies, builds the
# UI and drops a `spark-control-plane` launcher on your PATH. Re-running it
# updates an existing install in place.
#
# Nothing needs sudo: if /usr/local/bin isn't writable the launcher goes to
# ~/.local/bin instead, and a missing or too-old Node is fetched into the prefix
# rather than installed system-wide.
#
# Options (flags or environment variables):
#   --prefix DIR      SPARK_PREFIX        where to install (~/.spark-control-plane)
#   --branch NAME     SPARK_BRANCH        branch to track (main)
#   --port N          SPARK_PORT          HTTP port (5555)
#   --bind HOST       SPARK_BIND_HOST     bind address (127.0.0.1)
#   --service         SPARK_SERVICE=1     install and start a background service
#   --no-service      SPARK_SERVICE=0     never ask about the service
#   --uninstall                           remove the service, launcher and prefix
#   --yes             NONINTERACTIVE=1    don't prompt for anything
#
# Environment variables are read first; a flag wins over the variable.

set -u

if [ -z "${BASH_VERSION:-}" ]; then
  echo "This installer needs bash. Run:" >&2
  # shellcheck disable=SC2016  # printed verbatim, not evaluated.
  echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/garykww/spark-control-plane/main/install.sh)"' >&2
  exit 1
fi

REPO_URL="https://github.com/garykww/spark-control-plane.git"
APP_NAME="spark-control-plane"
# Node 22 is what the Docker image runs; package.json's floor is 20.
NODE_DIST="https://nodejs.org/dist/latest-v22.x"
NODE_MIN_MAJOR=20

PREFIX="${SPARK_PREFIX:-$HOME/.$APP_NAME}"
BRANCH="${SPARK_BRANCH:-main}"
PORT="${SPARK_PORT:-5555}"
BIND_HOST="${SPARK_BIND_HOST:-127.0.0.1}"
SERVICE="${SPARK_SERVICE:-ask}"
NONINTERACTIVE="${NONINTERACTIVE:-}"
UNINSTALL=""
PURGE=""

# ---------------------------------------------------------------- output ----

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_blue=$'\033[34m'
  c_red=$'\033[31m'; c_yellow=$'\033[33m'; c_off=$'\033[0m'
else
  c_bold=""; c_dim=""; c_blue=""; c_red=""; c_yellow=""; c_off=""
fi

ohai() { printf "%s==>%s %s%s\n" "$c_blue" "$c_bold" "$*" "$c_off"; }
info() { printf "    %s%s%s\n" "$c_dim" "$*" "$c_off"; }
warn() { printf "%swarning:%s %s\n" "$c_yellow" "$c_off" "$*" >&2; }
abort() { printf "%serror:%s %s\n" "$c_red" "$c_off" "$*" >&2; exit 1; }

# Every external command runs through here, so a failure names the step that
# broke instead of leaving a bare non-zero exit somewhere in the middle.
run() {
  if ! "$@"; then
    abort "failed while running: $*"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# Reads a single line from the terminal. Because the script is fetched with
# $(curl ...) rather than piped into bash, stdin is still the tty, but /dev/tty
# is used anyway so it also works when it is not.
confirm() {
  local prompt="$1" default="$2" reply=""
  if [ -n "$NONINTERACTIVE" ]; then
    [ "$default" = "y" ]
    return
  fi
  if [ -r /dev/tty ]; then
    read -r -p "$prompt " reply </dev/tty || reply=""
  else
    [ "$default" = "y" ]
    return
  fi
  reply="${reply:-$default}"
  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# ------------------------------------------------------------------ args ----

usage() {
  cat <<'EOF'
Spark Control Plane installer.

  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/garykww/spark-control-plane/main/install.sh)"

Options (flag, or the environment variable in the second column):
  --prefix DIR   SPARK_PREFIX      where to install (~/.spark-control-plane)
  --branch NAME  SPARK_BRANCH      branch to track (main)
  --port N       SPARK_PORT        HTTP port (5555)
  --bind HOST    SPARK_BIND_HOST   bind address (127.0.0.1)
  --service      SPARK_SERVICE=1   install and start a background service
  --no-service   SPARK_SERVICE=0   never ask about the service
  --yes          NONINTERACTIVE=1  don't prompt for anything
  --uninstall                      remove the service, launcher and prefix
  --purge                          with --uninstall, delete the prefix unasked
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --prefix=*) PREFIX="${1#*=}"; shift ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --branch=*) BRANCH="${1#*=}"; shift ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --bind) BIND_HOST="${2:-}"; shift 2 ;;
    --bind=*) BIND_HOST="${1#*=}"; shift ;;
    --service) SERVICE=1; shift ;;
    --no-service) SERVICE=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    --yes|-y) NONINTERACTIVE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    "") shift ;;
    *) abort "unknown option: $1 (try --help)" ;;
  esac
done

case "$PORT" in *[!0-9]*|"") abort "--port wants a number, got: $PORT" ;; esac
[ -n "$PREFIX" ] || abort "--prefix needs a directory"
case "$PREFIX" in /*) ;; *) PREFIX="$PWD/$PREFIX" ;; esac

# -------------------------------------------------------------- platform ----

OS="$(uname -s)"
case "$OS" in
  Linux) node_os="linux" ;;
  Darwin) node_os="darwin" ;;
  *) abort "unsupported platform: $OS (Linux and macOS only)" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) node_arch="x64" ;;
  aarch64|arm64) node_arch="arm64" ;;
  *) node_arch="" ;;
esac

# Where the launcher goes. Preferring a writable /usr/local/bin keeps the
# command on PATH for most people without ever asking for sudo.
if [ -n "${SPARK_BIN_DIR:-}" ]; then
  BIN_DIR="$SPARK_BIN_DIR"
elif [ -w /usr/local/bin ] 2>/dev/null; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi

LAUNCHER="$BIN_DIR/$APP_NAME"
# The prefix is the git checkout itself, so a bundled runtime has to be hidden
# and gitignore-proof: a plain `node/` would show up as untracked on every pull.
NODE_HOME="$PREFIX/.node"
ENV_FILE="$PREFIX/$APP_NAME.env"
SYSTEMD_UNIT="$HOME/.config/systemd/user/$APP_NAME.service"
LAUNCHD_LABEL="com.github.garykww.$APP_NAME"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"

# ------------------------------------------------------------- uninstall ----

stop_service() {
  if [ "$node_os" = "linux" ] && [ -f "$SYSTEMD_UNIT" ]; then
    systemctl --user disable --now "$APP_NAME.service" >/dev/null 2>&1
    rm -f "$SYSTEMD_UNIT"
    systemctl --user daemon-reload >/dev/null 2>&1
    info "removed the systemd user unit"
  fi
  if [ "$node_os" = "darwin" ] && [ -f "$LAUNCHD_PLIST" ]; then
    launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1 ||
      launchctl unload "$LAUNCHD_PLIST" >/dev/null 2>&1
    rm -f "$LAUNCHD_PLIST"
    info "removed the launchd agent"
  fi
}

if [ -n "$UNINSTALL" ]; then
  ohai "Uninstalling $APP_NAME"
  stop_service
  if [ -f "$LAUNCHER" ]; then
    rm -f "$LAUNCHER" && info "removed $LAUNCHER"
  fi
  if [ -d "$PREFIX" ]; then
    printf "\n%s holds your node list and encrypted SSH secrets in config/.\n" "$PREFIX"
    if [ -n "$PURGE" ] || confirm "Delete it? [y/N]" "n"; then
      run rm -rf "$PREFIX"
      info "removed $PREFIX"
    else
      info "kept $PREFIX"
    fi
  fi
  ohai "Done"
  exit 0
fi

# ----------------------------------------------------------- preflight -----

for cmd in curl git tar; do
  have "$cmd" || abort "$cmd is required but not installed"
done

if ! have ssh; then
  warn "ssh not found - remote nodes need an OpenSSH client (apt install openssh-client)"
fi

# Picks the newest usable Node: one already on PATH, or one this installer
# fetched previously. Anything older than the engines floor is ignored.
node_major() { "$1" -v 2>/dev/null | sed -e 's/^v//' -e 's/\..*$//'; }

NODE_BIN=""
for candidate in "$NODE_HOME/bin/node" "$(command -v node 2>/dev/null || true)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  major="$(node_major "$candidate")"
  case "$major" in ''|*[!0-9]*) continue ;; esac
  if [ "$major" -ge "$NODE_MIN_MAJOR" ]; then NODE_BIN="$candidate"; break; fi
done

# Downloads an official Node build into the prefix. Self-contained on purpose:
# no package manager, no sudo, and nothing outside $PREFIX changes.
install_node() {
  [ -n "$node_arch" ] || abort "no Node build for $(uname -m); install Node $NODE_MIN_MAJOR+ yourself and re-run"

  local tmp shasums tarball
  tmp="$(mktemp -d)" || abort "could not create a temporary directory"
  # shellcheck disable=SC2064  # $tmp is expanded now, on purpose.
  trap "rm -rf '$tmp'" EXIT

  shasums="$tmp/SHASUMS256.txt"
  run curl -fsSL "$NODE_DIST/SHASUMS256.txt" -o "$shasums"
  tarball="$(grep -o "node-v[0-9.]*-$node_os-$node_arch\.tar\.gz" "$shasums" | head -1)"
  [ -n "$tarball" ] || abort "no Node tarball for $node_os-$node_arch at $NODE_DIST"

  ohai "Downloading ${tarball%.tar.gz}"
  run curl -fL --progress-bar "$NODE_DIST/$tarball" -o "$tmp/$tarball"

  # The checksum tool differs between the two platforms, and -c wants the file
  # in the working directory, so check from inside the temp dir.
  ( cd "$tmp" && grep " $tarball\$" SHASUMS256.txt > expected.txt &&
    if have sha256sum; then sha256sum -c expected.txt >/dev/null
    elif have shasum; then shasum -a 256 -c expected.txt >/dev/null
    else echo "no sha256 tool" >&2; exit 1; fi ) ||
    abort "checksum verification failed for $tarball"

  rm -rf "$NODE_HOME"
  run mkdir -p "$NODE_HOME"
  run tar -xzf "$tmp/$tarball" -C "$NODE_HOME" --strip-components=1
  rm -rf "$tmp"
  trap - EXIT
  NODE_BIN="$NODE_HOME/bin/node"
}

# ------------------------------------------------------------------ plan ----

if [ -d "$PREFIX/.git" ]; then action="Updating"; else action="Installing"; fi

# An env file from an earlier run is the source of truth: the installer never
# overwrites it, so it decides where the server listens.
if [ -f "$ENV_FILE" ]; then
  keep_port="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1)"
  keep_bind="$(sed -n 's/^BIND_HOST=//p' "$ENV_FILE" | tail -1)"
  PORT="${keep_port:-$PORT}"
  BIND_HOST="${keep_bind:-$BIND_HOST}"
fi

echo
ohai "$action Spark Control Plane"
info "prefix:   $PREFIX"
info "launcher: $LAUNCHER"
info "branch:   $BRANCH"
if [ -n "$NODE_BIN" ]; then
  info "node:     $NODE_BIN ($("$NODE_BIN" -v))"
else
  info "node:     none found - fetching a private copy into $NODE_HOME"
fi
info "listen:   http://$BIND_HOST:$PORT"
echo

if [ -z "$NONINTERACTIVE" ] && [ -r /dev/tty ]; then
  printf "Press %sRETURN%s to continue, or ctrl-c to stop.\n" "$c_bold" "$c_off"
  read -r </dev/tty || abort "aborted"
fi

# --------------------------------------------------------------- install ----

if [ -d "$PREFIX/.git" ]; then
  ohai "Updating the checkout"
  if [ -n "$(git -C "$PREFIX" status --porcelain -uno 2>/dev/null)" ]; then
    # Someone edited recipes.yaml or similar in place. Rebuild what is there
    # rather than throwing their work away.
    warn "$PREFIX has local changes - leaving them alone and skipping the pull"
  else
    run git -C "$PREFIX" fetch --depth 1 origin "$BRANCH"
    run git -C "$PREFIX" checkout -B "$BRANCH" FETCH_HEAD
  fi
else
  if [ -d "$PREFIX" ] && [ -n "$(ls -A "$PREFIX" 2>/dev/null)" ]; then
    abort "$PREFIX already exists and is not a $APP_NAME checkout - pass --prefix DIR"
  fi
  ohai "Cloning $REPO_URL"
  run mkdir -p "$(dirname "$PREFIX")"
  run git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$PREFIX"
fi

# After the clone, so the checkout's destination is still empty when git needs
# it to be, and so an interrupted download never leaves a half-installed tree.
[ -n "$NODE_BIN" ] || install_node
NPM_BIN="$(dirname "$NODE_BIN")/npm"
have "$NPM_BIN" || NPM_BIN="$(command -v npm || true)"
[ -n "$NPM_BIN" ] || abort "npm not found next to $NODE_BIN"

ohai "Installing dependencies"
# npm ci needs the dev dependencies: the build is tsc plus vite.
( cd "$PREFIX" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" ci --no-audit --no-fund ) ||
  abort "npm ci failed in $PREFIX"

ohai "Building the UI"
( cd "$PREFIX" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" run build ) ||
  abort "npm run build failed in $PREFIX"

# The app reads plain environment variables, so the launcher sources this file
# before exec'ing the server. Written once and left alone on later runs, so an
# update never overwrites an edited port or bind address.
if [ ! -f "$ENV_FILE" ]; then
  ohai "Writing $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# Spark Control Plane settings, read by the $APP_NAME launcher.
# Every variable in $PREFIX/.env.example works here.

PORT=$PORT

# Loopback by default. The API has no authentication, so only widen this on a
# trusted network - behind Tailscale, a VPN or an authenticating proxy.
BIND_HOST=$BIND_HOST
EOF
else
  info "kept the existing $ENV_FILE"
fi

ohai "Installing the launcher"
run mkdir -p "$BIN_DIR"
cat > "$LAUNCHER.tmp" <<'LAUNCHER_EOF'
#!/bin/bash
# Generated by the Spark Control Plane installer. Re-run the installer to
# refresh it; edit __ENV_FILE__ to change the port or bind address.
set -euo pipefail

APP_DIR="__APP_DIR__"
ENV_FILE="__ENV_FILE__"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

export NODE_ENV="${NODE_ENV:-production}"
exec "__NODE_BIN__" "$APP_DIR/server/index.js" "$@"
LAUNCHER_EOF

sed -e "s|__APP_DIR__|$PREFIX|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$LAUNCHER.tmp" > "$LAUNCHER" || abort "could not write $LAUNCHER"
rm -f "$LAUNCHER.tmp"
run chmod +x "$LAUNCHER"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH - add it with: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# --------------------------------------------------------------- service ----

install_systemd_service() {
  run mkdir -p "$(dirname "$SYSTEMD_UNIT")"
  cat > "$SYSTEMD_UNIT" <<EOF
[Unit]
Description=Spark Control Plane
After=network-online.target

[Service]
Type=simple
ExecStart=$LAUNCHER
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  run systemctl --user daemon-reload
  run systemctl --user enable "$APP_NAME.service"
  # restart, not start: on an update the unit is already running the old build.
  run systemctl --user restart "$APP_NAME.service"
  # Without lingering the unit stops when the last login session ends, which is
  # exactly wrong for a box you monitor over SSH.
  if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q "Linger=yes"; then
    if ! loginctl enable-linger "$USER" >/dev/null 2>&1; then
      warn "run 'sudo loginctl enable-linger $USER' so it keeps running after you log out"
    fi
  fi
}

install_launchd_service() {
  local label="$LAUNCHD_LABEL"
  local domain
  domain="gui/$(id -u)"
  run mkdir -p "$(dirname "$LAUNCHD_PLIST")" "$PREFIX/logs"
  cat > "$LAUNCHD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$LAUNCHER</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PREFIX/logs/$APP_NAME.log</string>
  <key>StandardErrorPath</key><string>$PREFIX/logs/$APP_NAME.log</string>
</dict>
</plist>
EOF
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    # bootout returns before the job is actually gone, and bootstrapping a label
    # that is still in the domain fails with a bare "Input/output error", so
    # wait for it to leave rather than racing it.
    launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      launchctl print "$domain/$label" >/dev/null 2>&1 || break
      sleep 1
    done
  fi
  run launchctl bootstrap "$domain" "$LAUNCHD_PLIST"
}

service_supported=""
if [ "$node_os" = "linux" ] && have systemctl && [ -d /run/systemd/system ]; then
  service_supported="systemd"
elif [ "$node_os" = "darwin" ] && have launchctl; then
  service_supported="launchd"
fi

service_installed=""
service_action="Installing"

# A service already here means this run is an update, and the running process
# is still the previous build - so restart it without asking.
if [ -f "$SYSTEMD_UNIT" ] || [ -f "$LAUNCHD_PLIST" ]; then
  service_action="Restarting"
  [ "$SERVICE" = "ask" ] && SERVICE=1
fi

if [ "$SERVICE" = "ask" ]; then
  if [ -n "$service_supported" ] && [ -z "$NONINTERACTIVE" ]; then
    if confirm "Start it now and on every boot ($service_supported)? [y/N]" "n"; then
      SERVICE=1
    else
      SERVICE=0
    fi
  else
    SERVICE=0
  fi
fi

if [ "$SERVICE" = "1" ]; then
  if [ -z "$service_supported" ]; then
    warn "no systemd or launchd here - start it yourself with $APP_NAME"
  else
    ohai "$service_action the $service_supported service"
    case "$service_supported" in
      systemd) install_systemd_service ;;
      launchd) install_launchd_service ;;
    esac
    service_installed=1
  fi
fi

# ------------------------------------------------------------- all done ----

url="http://$BIND_HOST:$PORT"
case "$BIND_HOST" in 0.0.0.0|::) url="http://127.0.0.1:$PORT" ;; esac

if [ -n "$service_installed" ]; then
  ohai "Waiting for the server"
  ready=""
  for _ in $(seq 1 20); do
    if curl -fsS "$url/api/health" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [ -n "$ready" ] || warn "no answer from $url yet - check the logs below"
fi

echo
ohai "Installed"
if [ -n "$service_installed" ]; then
  printf "    Open %s%s%s\n\n" "$c_bold" "$url" "$c_off"
  if [ "$service_supported" = "systemd" ]; then
    info "logs:  journalctl --user -u $APP_NAME -f"
    info "stop:  systemctl --user stop $APP_NAME"
  else
    info "logs:  tail -f $PREFIX/logs/$APP_NAME.log"
    info "stop:  launchctl bootout gui/$(id -u)/$LAUNCHD_LABEL"
  fi
else
  printf "    Start it with %s%s%s, then open %s%s%s\n\n" \
    "$c_bold" "$APP_NAME" "$c_off" "$c_bold" "$url" "$c_off"
  info "no hardware handy?  DEMO_MODE=1 $APP_NAME"
fi
info "settings:   $ENV_FILE"
info "update:     re-run this installer"
info "uninstall:  bash $PREFIX/install.sh --uninstall"
echo

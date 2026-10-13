#!/bin/sh
set -eu

repo="${GANDALF_REPO:-qyinm/gandalf}"
install_dir="${GANDALF_INSTALL_DIR:-$HOME/.local/bin}"
dry_run="${GANDALF_INSTALL_DRY_RUN:-0}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "gandalf install: missing required command: $1" >&2
    exit 1
  fi
}

detect_os() {
  raw="${GANDALF_INSTALL_OS:-$(uname -s)}"
  case "$raw" in
    Darwin|darwin) echo "darwin" ;;
    Linux|linux)
      echo "gandalf install: Linux builds are not available yet; Gandalf currently supports macOS only" >&2
      exit 1
      ;;
    *)
      echo "gandalf install: unsupported OS: $raw" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  raw="${GANDALF_INSTALL_ARCH:-$(uname -m)}"
  case "$raw" in
    x86_64|amd64) echo "amd64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)
      echo "gandalf install: unsupported architecture: $raw" >&2
      exit 1
      ;;
  esac
}

latest_tag() {
  if [ -n "${GANDALF_INSTALL_TAG:-}" ]; then
    echo "$GANDALF_INSTALL_TAG"
    return
  fi

  need curl
  curl -fsSL "https://api.github.com/repos/$repo/releases/latest" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1
}

verify_checksum() {
  checksum_file="$1"
  archive_name="$2"

  expected="$(grep "  $archive_name\$" "$checksum_file" | awk '{print $1}')"
  if [ -z "$expected" ]; then
    echo "gandalf install: checksum entry not found for $archive_name" >&2
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive_name" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$archive_name" | awk '{print $1}')"
  else
    echo "gandalf install: sha256sum or shasum is required for checksum verification" >&2
    exit 1
  fi

  if [ "$actual" != "$expected" ]; then
    echo "gandalf install: checksum mismatch for $archive_name" >&2
    exit 1
  fi
}

os="$(detect_os)"
arch="$(detect_arch)"
tag="$(latest_tag)"

if [ -z "$tag" ]; then
  echo "gandalf install: could not resolve latest release tag" >&2
  exit 1
fi

version="${tag#v}"
archive_name="gandalf_${version}_${os}_${arch}.tar.gz"
base_url="${GANDALF_INSTALL_BASE_URL:-https://github.com/$repo/releases/download/$tag}"
archive_url="$base_url/$archive_name"
checksum_url="$base_url/checksums.txt"

if [ "$dry_run" = "1" ]; then
  echo "tag=$tag"
  echo "os=$os"
  echo "arch=$arch"
  echo "archive=$archive_name"
  echo "url=$archive_url"
  exit 0
fi

need curl
need tar
need install
need mktemp

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

cd "$tmp"
curl -fsSLO "$archive_url"
curl -fsSLO "$checksum_url"
verify_checksum "checksums.txt" "$archive_name"
tar -xzf "$archive_name"

if [ ! -f "gandalf" ]; then
  echo "gandalf install: archive did not contain gandalf binary" >&2
  exit 1
fi

mkdir -p "$install_dir"
install -m 0755 "gandalf" "$install_dir/gandalf"

echo "gandalf installed to $install_dir/gandalf"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    echo "Add $install_dir to PATH to run gandalf from any shell."
    ;;
esac

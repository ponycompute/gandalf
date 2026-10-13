#!/bin/sh
set -eu

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

check() {
  os="$1"
  arch="$2"
  expected="$3"
  output="$(
    GANDALF_INSTALL_DRY_RUN=1 \
    GANDALF_INSTALL_TAG=v0.0.0 \
    GANDALF_INSTALL_OS="$os" \
    GANDALF_INSTALL_ARCH="$arch" \
    ./install.sh
  )"

  echo "$output" | grep -q "archive=$expected"
}

check Darwin arm64 gandalf_0.0.0_darwin_arm64.tar.gz
check Darwin x86_64 gandalf_0.0.0_darwin_amd64.tar.gz

for unsupported in Linux FreeBSD; do
  if GANDALF_INSTALL_DRY_RUN=1 GANDALF_INSTALL_TAG=v0.0.0 GANDALF_INSTALL_OS="$unsupported" ./install.sh >"$tmp/unsupported.out" 2>"$tmp/unsupported.err"; then
    echo "expected $unsupported to fail" >&2
    exit 1
  fi
done

fixture="$tmp/fixture"
payload="$tmp/payload"
install_dir="$tmp/install"
mkdir -p "$fixture" "$payload" "$install_dir"

cat >"$payload/gandalf" <<'EOF'
#!/bin/sh
case "${1:-}" in
  --help|-h)
    echo "gandalf fixture help"
    ;;
  *)
    echo "gandalf fixture"
    ;;
esac
EOF
chmod +x "$payload/gandalf"

archive_name="gandalf_0.0.0_darwin_arm64.tar.gz"
tar -C "$payload" -czf "$fixture/$archive_name" gandalf
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$fixture" && sha256sum "$archive_name" > checksums.txt)
else
  (cd "$fixture" && shasum -a 256 "$archive_name" > checksums.txt)
fi

GANDALF_INSTALL_TAG=v0.0.0 \
GANDALF_INSTALL_OS=Darwin \
GANDALF_INSTALL_ARCH=arm64 \
GANDALF_INSTALL_BASE_URL="file://$fixture" \
GANDALF_INSTALL_DIR="$install_dir" \
./install.sh >"$tmp/install.out" 2>"$tmp/install.err"

if [ ! -x "$install_dir/gandalf" ]; then
  echo "expected installer to create executable gandalf" >&2
  exit 1
fi

"$install_dir/gandalf" --help | grep -q "gandalf fixture help"

fake_bin="$tmp/fake-bin"
failed_install_dir="$tmp/failed-install"
mkdir -p "$fake_bin" "$failed_install_dir"
cat >"$fake_bin/curl" <<'EOF'
#!/bin/sh
exit 22
EOF
chmod +x "$fake_bin/curl"

if PATH="$fake_bin:$PATH" \
  GANDALF_INSTALL_TAG=v0.0.0 \
  GANDALF_INSTALL_OS=Darwin \
  GANDALF_INSTALL_ARCH=arm64 \
  GANDALF_INSTALL_DIR="$failed_install_dir" \
  ./install.sh >"$tmp/download-failure.out" 2>"$tmp/download-failure.err"; then
  echo "expected failed download to fail" >&2
  exit 1
fi

if [ -e "$failed_install_dir/gandalf" ]; then
  echo "installer left partial binary after failed download" >&2
  exit 1
fi

echo "install.sh smoke passed"

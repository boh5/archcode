#!/bin/sh

set -eu

INSTALLER_VERSION="__ARCHCODE_VERSION__"
RELEASE_BASE_URL_DEFAULT="https://github.com/boh5/archcode/releases/download"

fail() {
  printf 'archcode installer: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install ArchCode from an official GitHub Release.

Usage: install.sh [options]

Options:
  --version <version>  Install a specific release (default: this installer's release)
  --prefix <path>      Install under this prefix (default: $HOME/.local)
  --dry-run            Print the resolved installation without changing files
  -h, --help           Show this help

The executable is installed as <prefix>/bin/archcode. The installer never uses
sudo, edits shell configuration, changes ~/.archcode, or creates a service.
EOF
}

version=$INSTALLER_VERSION
prefix=${HOME:+"$HOME/.local"}
dry_run=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "missing value for --version"
      version=$2
      shift 2
      ;;
    --prefix)
      [ "$#" -ge 2 ] || fail "missing value for --prefix"
      prefix=$2
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[ -n "$prefix" ] || fail "HOME is not set; pass --prefix with an absolute path"
case "$prefix" in
  /*) ;;
  *) fail "--prefix must be an absolute path" ;;
esac

if ! printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'; then
  fail "invalid version: $version"
fi

kernel=$(uname -s)
machine=$(uname -m)

case "$kernel" in
  Darwin)
    platform=macos
    macos_version=$(sw_vers -productVersion 2>/dev/null) ||
      fail "unable to determine the macOS version"
    macos_major=${macos_version%%.*}
    case "$macos_major" in
      ''|*[!0-9]*) fail "unable to parse macOS version: $macos_version" ;;
    esac
    [ "$macos_major" -ge 13 ] ||
      fail "macOS 13 or newer is required (found $macos_version)"
    ;;
  Linux)
    platform=linux
    glibc_version=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{ print $2 }') || true
    [ -n "$glibc_version" ] ||
      fail "a glibc-based Linux distribution is required; musl/Alpine is not supported"
    glibc_major=${glibc_version%%.*}
    glibc_minor=${glibc_version#*.}
    glibc_minor=${glibc_minor%%.*}
    case "$glibc_major:$glibc_minor" in
      *[!0-9:]*|:*|*:) fail "unable to parse glibc version: $glibc_version" ;;
    esac
    if [ "$glibc_major" -lt 2 ] ||
      { [ "$glibc_major" -eq 2 ] && [ "$glibc_minor" -lt 17 ]; }; then
      fail "glibc 2.17 or newer is required (found $glibc_version)"
    fi
    ;;
  *)
    fail "unsupported operating system: $kernel"
    ;;
esac

case "$machine" in
  arm64|aarch64) architecture=arm64 ;;
  x86_64|amd64) architecture=x64 ;;
  *) fail "unsupported architecture: $machine" ;;
esac

asset="archcode-${platform}-${architecture}-v${version}.tar.gz"
destination_dir="$prefix/bin"
destination="$destination_dir/archcode"
release_base_url=${ARCHCODE_RELEASE_BASE_URL:-$RELEASE_BASE_URL_DEFAULT}
asset_url="${release_base_url}/v${version}/${asset}"
checksums_url="${release_base_url}/v${version}/SHA256SUMS"

printf 'ArchCode v%s\n' "$version"
printf '  platform: %s/%s\n' "$platform" "$architecture"
printf '  asset:    %s\n' "$asset"
printf '  install:  %s\n' "$destination"

if [ "$dry_run" -eq 1 ]; then
  exit 0
fi

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v awk >/dev/null 2>&1 || fail "awk is required"
command -v install >/dev/null 2>&1 || fail "install is required"

temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/archcode-install.XXXXXX") ||
  fail "unable to create a temporary directory"
staged_path=
cleanup() {
  [ -z "$staged_path" ] || rm -f "$staged_path"
  rm -rf "$temporary_dir"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

archive_path="$temporary_dir/$asset"
checksums_path="$temporary_dir/SHA256SUMS"

curl -fsSL --retry 3 --proto '=https,file' --proto-redir '=https,file' \
  --output "$archive_path" "$asset_url" ||
  fail "failed to download $asset_url"
curl -fsSL --retry 3 --proto '=https,file' --proto-redir '=https,file' \
  --output "$checksums_path" "$checksums_url" ||
  fail "failed to download $checksums_url"

expected_sha=$(awk -v name="$asset" '$2 == name { print $1 }' "$checksums_path")
case "$expected_sha" in
  '') fail "SHA256SUMS does not contain a checksum for $asset" ;;
  *[!0-9a-fA-F]*) fail "SHA256SUMS contains an invalid checksum for $asset" ;;
esac
[ "${#expected_sha}" -eq 64 ] ||
  fail "SHA256SUMS contains an invalid checksum for $asset"
[ "$(printf '%s\n' "$expected_sha" | wc -l | tr -d ' ')" -eq 1 ] ||
  fail "SHA256SUMS contains duplicate entries for $asset"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha=$(sha256sum "$archive_path" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual_sha=$(shasum -a 256 "$archive_path" | awk '{ print $1 }')
else
  fail "sha256sum or shasum is required"
fi
[ "$actual_sha" = "$expected_sha" ] ||
  fail "checksum verification failed for $asset"

archive_entries=$(tar -tzf "$archive_path") ||
  fail "unable to inspect $asset"
[ "$archive_entries" = "archcode" ] ||
  fail "$asset must contain exactly one entry named archcode"
archive_listing=$(tar -tvzf "$archive_path") ||
  fail "unable to inspect the entry type in $asset"
case "$archive_listing" in
  -*) ;;
  *) fail "$asset must contain archcode as a regular file" ;;
esac

extract_dir="$temporary_dir/extracted"
mkdir "$extract_dir"
tar -xzf "$archive_path" -C "$extract_dir" ||
  fail "unable to extract $asset"
extracted_binary="$extract_dir/archcode"
[ -f "$extracted_binary" ] && [ ! -L "$extracted_binary" ] ||
  fail "$asset did not extract a regular archcode executable"
chmod 755 "$extracted_binary"

reported_version=$("$extracted_binary" --version 2>/dev/null) ||
  fail "the downloaded executable could not report its version"
[ "$reported_version" = "archcode $version" ] ||
  fail "downloaded executable reported an unexpected version: $reported_version"

mkdir -p "$destination_dir"
staged_path=$(mktemp "$destination_dir/.archcode.install.XXXXXX") ||
  fail "unable to create a staging file in $destination_dir"
install -m 755 "$extracted_binary" "$staged_path" ||
  fail "unable to stage the ArchCode executable"
mv -f "$staged_path" "$destination" ||
  fail "unable to atomically install ArchCode at $destination"
staged_path=

printf 'Installed ArchCode v%s at %s\n' "$version" "$destination"
case ":${PATH:-}:" in
  *":$destination_dir:"*) ;;
  *)
    printf 'Add %s to PATH, for example:\n  export PATH="%s:$PATH"\n' \
      "$destination_dir" "$destination_dir"
    ;;
esac

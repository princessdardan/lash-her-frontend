#!/bin/sh
set -eu
umask 022
export LC_ALL=C TZ=UTC
mkdir /node-build /node-rootfs
cd /node-build

python3 - <<'PY'
import hashlib
import json
import subprocess
from pathlib import Path

lock = json.loads(Path('/node-runtime/node-inputs.lock.json').read_text())
version = lock['nodeVersion']
source = f'https://nodejs.org/dist/v{version}/node-v{version}.tar.xz'
subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location', '--retry', '3',
                '--proto', '=https', '--proto-redir', '=https', source, '-o', 'node.tar.xz'], check=True)
with Path('node.tar.xz').open('rb') as archive:
    if hashlib.file_digest(archive, 'sha256').hexdigest() != lock['nodeSourceSha256']:
        raise SystemExit('Unexpected hash for Node release archive')
PY

mkdir source
tar -xJf node.tar.xz -C source --strip-components=1
cd source
python3 - <<'PY'
import hashlib
import json
import subprocess
from pathlib import Path

patch_directory = Path('/node-runtime')
lock = json.loads((patch_directory / 'node-inputs.lock.json').read_text())
for name, metadata in lock['patches'].items():
    patch = patch_directory / name
    if hashlib.sha256(patch.read_bytes()).hexdigest() != metadata['sha256']:
        raise SystemExit(f'Unexpected hash for {name}')
    subprocess.run(['patch', '--batch', '--forward', '--fuzz=0', '--no-backup-if-mismatch',
                    '-p1', '-d', metadata['directory'], '-i', str(patch)], check=True)
for path, digest in lock['patchedSources'].items():
    if hashlib.sha256(Path(path).read_bytes()).hexdigest() != digest:
        raise SystemExit(f'Unexpected patched source hash for {path}')
PY

./configure --prefix=/nodejs --without-npm --without-corepack
make -j4
strip --strip-unneeded out/Release/node
install -D -m 755 out/Release/node /node-rootfs/nodejs/bin/node
install -D -m 644 LICENSE /node-rootfs/nodejs/LICENSE

# Retain the C++ runtime from the official Distroless Node image, with its
# Debian package records and licenses. The final base supplies glibc.
libdir="/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)"
mkdir -p "/node-rootfs$libdir" /node-rootfs/var/lib/dpkg/status.d /node-rootfs/usr/share/doc
cp -a "/distroless$libdir"/libstdc++.so.6* "/distroless$libdir/libgcc_s.so.1" "/node-rootfs$libdir/"
for package in gcc-14-base libgcc-s1 libstdc++6; do
    cp -a "/distroless/var/lib/dpkg/status.d/$package" \
        "/distroless/var/lib/dpkg/status.d/$package.md5sums" /node-rootfs/var/lib/dpkg/status.d/
    cp -a "/distroless/usr/share/doc/$package" /node-rootfs/usr/share/doc/
done

mkdir -p /node-rootfs/usr/share/lash-runtime
python3 - <<'PY'
import hashlib
import json
from pathlib import Path

rootfs = Path('/node-rootfs')
lock = json.loads(Path('/node-runtime/node-inputs.lock.json').read_text())
with (rootfs / 'nodejs/bin/node').open('rb') as binary:
    digest = hashlib.file_digest(binary, 'sha256').hexdigest()
receipt = {'version': 1, 'inputs': lock, 'nodeSha256': digest}
(rootfs / 'usr/share/lash-runtime/node.json').write_text(json.dumps(receipt, sort_keys=True) + '\n')
PY

# Keep the cached image layer limited to the installed runtime and evidence.
cd /
rm -rf /node-build

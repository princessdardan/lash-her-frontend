#!/bin/sh
set -eu
umask 022
export LC_ALL=C TZ=UTC
export SOURCE_DATE_EPOCH=1791061200
mkdir -p /build /out/rootfs /out/evidence
cd /build
python3 - <<'PY'
import hashlib,json,subprocess
from pathlib import Path
lock=json.loads(Path('/runtime/inputs.lock.json').read_text())
for name,entry in lock['inputs'].items():
    subprocess.run(['curl','--fail','--silent','--show-error','--location',entry['url'],'-o',name],check=True)
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==entry['sha256'],name
for name,digest in {**lock['patches'],**lock['implementation']}.items():
    assert hashlib.sha256(Path('/runtime',name).read_bytes()).hexdigest()==digest,name
descriptor=Path('descriptor').read_text()
for name in ['source','packaging']:
    assert lock['inputs'][name]['sha256'] in descriptor,name
PY
mkdir src
tar -xf source -C src --strip-components=1
tar -xf packaging -C src
test ! -s src/debian/patches/series
cd src
export CFLAGS='-O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2 -ffile-prefix-map=/build=.'
export LDFLAGS='-Wl,-z,relro,-z,now'
./configure --prefix=/usr
make -j2
cc $CFLAGS -I. /runtime/failed-write.c libz.a -Wl,--wrap=write -o /build/failed-write-before
python3 - <<'PY'
import subprocess
r=subprocess.run(['/build/failed-write-before'],capture_output=True)
assert r.returncode == -6 and b'state->strm.avail_in == 0' in r.stderr, r.stderr
PY
# Apply only the reviewed adaptation, with no fuzzy context matching.
patch --fuzz=0 -p1 < /runtime/backport.patch
make -j2
make check
cc $CFLAGS -I. /runtime/failed-write.c libz.a -Wl,--wrap=write -o /build/failed-write-after
/build/failed-write-after
# Also exercise the shared object through a real ENOSPC write failure.
cc $CFLAGS -DRUNTIME_SHARED -I. /runtime/failed-write.c -L. -lz -o /build/failed-write-shared
LD_LIBRARY_PATH=. /build/failed-write-shared
triplet=$(dpkg-architecture -qDEB_HOST_MULTIARCH)
architecture=$(dpkg --print-architecture)
mkdir -p /pkg/DEBIAN "/pkg/usr/lib/$triplet" /pkg/usr/share/doc/zlib1g
cp libz.so.1.3.1 "/pkg/usr/lib/$triplet/"
strip --strip-unneeded "/pkg/usr/lib/$triplet/libz.so.1.3.1"
ln -s libz.so.1.3.1 "/pkg/usr/lib/$triplet/libz.so.1"
cp debian/copyright /pkg/usr/share/doc/zlib1g/copyright
depends=$(dpkg-shlibdeps -O -e "/pkg/usr/lib/$triplet/libz.so.1.3.1" | sed -n 's/^shlibs:Depends=//p')
test -n "$depends"
cat > /pkg/DEBIAN/control <<EOF
Package: zlib1g
Source: zlib
Version: 1:1.3.dfsg+really1.3.1-1+lash1
Architecture: $architecture
Maintainer: Lash Her runtime maintainers
Section: libs
Priority: required
Depends: $depends
Description: zlib with the reviewed Lash Her failed-write security backport
EOF
find /pkg -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
dpkg-deb --root-owner-group -Zxz --build /pkg /out/zlib1g.deb
dpkg-deb -x /out/zlib1g.deb /out/rootfs
mkdir -p /out/rootfs/var/lib/dpkg/status.d /out/rootfs/usr/share/lash-runtime /out/rootfs/usr/libexec/lash-her
cp /build/failed-write-shared /out/rootfs/usr/libexec/lash-her/zlib-regression
{ printf 'Status: install ok installed\n'; cat /pkg/DEBIAN/control; } > /out/rootfs/var/lib/dpkg/status.d/zlib1g
python3 - "$triplet" <<'PY'
import hashlib,json,sys
from pathlib import Path
lock=json.loads(Path('/runtime/inputs.lock.json').read_text())
library=f'/usr/lib/{sys.argv[1]}/libz.so.1.3.1'
evidence={'version':1,'inputs':lock,'inputsLockSha256':hashlib.sha256(Path('/runtime/inputs.lock.json').read_bytes()).hexdigest(),
 'packageSha256':hashlib.sha256(Path('/out/zlib1g.deb').read_bytes()).hexdigest(),
 'library':library,'librarySha256':hashlib.sha256(Path('/out/rootfs'+library).read_bytes()).hexdigest(),
 'regressionBinarySha256':hashlib.sha256(Path('/build/failed-write-shared').read_bytes()).hexdigest(),
 'regression':{'unpatched':'EXPECTED_ASSERTION_FAILURE','patched':'PASS','shared':'PASS','upstreamTests':'PASS'}}
Path('/out/rootfs/usr/share/lash-runtime/zlib.json').write_text(json.dumps(evidence,sort_keys=True)+'\n')
Path('/out/evidence/zlib.json').write_text(json.dumps(evidence,sort_keys=True)+'\n')
PY

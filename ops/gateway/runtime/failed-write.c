/* Regression for stale caller input after gz_write encounters EPIPE. */
#include "gzguts.h"
#include <assert.h>
#include <errno.h>
#include <unistd.h>

#ifndef RUNTIME_SHARED
static int fail_fd = -1;
ssize_t __real_write(int, const void *, size_t);
ssize_t __wrap_write(int fd, const void *buf, size_t len) {
    if (fd == fail_fd) { errno = EPIPE; return -1; }
    return __real_write(fd, buf, len);
}
#endif
int main(void) {
    unsigned char input[65536];
    unsigned seed = 123456789;
    for (unsigned i = 0; i < sizeof(input); i++) {
        seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
        input[i] = (unsigned char)seed;
    }
    int fd = open(
#ifdef RUNTIME_SHARED
        "/dev/full",
#else
        "/dev/null",
#endif
        O_WRONLY);
    assert(fd >= 0);
    gzFile file = gzdopen(fd, "wb");
    assert(file && gzbuffer(file, 128) == 0);
#ifndef RUNTIME_SHARED
    fail_fd = fd;
#endif
    assert(gzwrite(file, input, sizeof(input)) == 0);
    int error;
    (void)gzerror(file, &error);
    assert(error == Z_ERRNO);
    gzclearerr(file);
    gz_statep state = (gz_statep)file;
    /* Stop before an unsafe second write on an unpatched library. */
    assert(state->strm.avail_in == 0 && state->strm.next_in == state->in);
#ifndef RUNTIME_SHARED
    fail_fd = -1;
#endif
    assert(gzwrite(file, "next", 4) == 4);
#ifdef RUNTIME_SHARED
    assert(gzclose(file) == Z_ERRNO);
#else
    assert(gzclose(file) == Z_OK);
#endif
    return 0;
}

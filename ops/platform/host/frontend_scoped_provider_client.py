"""Fixed-origin transport for source-owned read-only effect observers.

The classifier is an imported source function, never JSON/caller input. The
parent wraps this client in LockedClient, including expected denial paths.
"""
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request

import vercel

ORIGINS = {
    "square": "https://connect.squareupsandbox.com",
    "resend": "https://api.resend.com",
    "highlevel": "https://services.leadconnectorhq.com",
    "chitchats": "https://staging.chitchats.com",
}


class ScopedProviderReadError(ValueError):
    def __init__(self, code="SCOPED_PROVIDER_READ_UNVERIFIED", http_status=None):
        super().__init__(code)
        self.http_status = http_status


class AuthenticationDenied(ScopedProviderReadError):
    def __init__(self):
        super().__init__("SCOPED_PROVIDER_AUTHENTICATION_DENIED", 401)


class Client:
    def __init__(self, provider, token, reviewed, classifier):
        if provider not in ORIGINS or not isinstance(token, str) or not 0 < len(token) <= 8192 or \
                not all(32 < ord(char) < 127 for char in token) or not isinstance(reviewed, dict) or not callable(classifier):
            raise ScopedProviderReadError("SCOPED_PROVIDER_PRIVATE_CONTEXT_REFUSED")
        self.provider, self._token, self.reviewed, self.classifier = provider, token, reviewed, classifier
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), vercel.NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, method, path, body=None):
        try:
            if not isinstance(path, str) or not path.startswith("/") or path.startswith("//") or len(path) > 8192 or \
                    any(ord(char) <= 32 or ord(char) >= 127 for char in path):
                raise ScopedProviderReadError("SCOPED_PROVIDER_REQUEST_REFUSED")
            parsed = urllib.parse.urlsplit(path)
            if parsed.scheme or parsed.netloc or parsed.fragment or any(value in parsed.path.lower() for value in ("%2f", "%5c", "%2e", "\\", "/../", "/./")):
                raise ScopedProviderReadError("SCOPED_PROVIDER_REQUEST_REFUSED")
            searches = {"square": {"/v2/orders/search"}, "highlevel": {"/contacts/search", "/workflows/search"}}
            if method == "GET":
                if body is not None:
                    raise ScopedProviderReadError("SCOPED_PROVIDER_REQUEST_REFUSED")
            elif method != "POST" or parsed.path not in searches.get(self.provider, set()) or not isinstance(body, dict):
                raise ScopedProviderReadError("SCOPED_PROVIDER_MUTATION_REFUSED")
            if self.classifier(method, path, body, self.reviewed) is not True:
                raise ScopedProviderReadError("SCOPED_PROVIDER_REQUEST_REFUSED")
            encoded = None if body is None else json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
            if encoded is not None and len(encoded) > 2_000_000:
                raise ScopedProviderReadError("SCOPED_PROVIDER_REQUEST_REFUSED")
            headers = {"Authorization": "Bearer " + self._token, "Content-Type": "application/json"}
            if self.provider == "square":
                if self.reviewed.get("environment") != "sandbox" or self.reviewed.get("apiVersion") != "2026-05-20":
                    raise ScopedProviderReadError("SCOPED_SQUARE_SANDBOX_VERSION_REQUIRED")
                headers["Square-Version"] = "2026-05-20"
            elif self.provider == "highlevel":
                if self.reviewed.get("environment") != "staging" or self.reviewed.get("locationId") == "vd09FLBpPLXuHb5Tnhn4":
                    raise ScopedProviderReadError("SCOPED_HIGHLEVEL_STAGING_REQUIRED")
                headers["Version"] = "v3"
            request = urllib.request.Request(ORIGINS[self.provider] + path, method=method, headers=headers, data=encoded)
            with self._opener.open(request, timeout=30) as response:
                raw = response.read(2_000_001)
                if not 200 <= response.status < 300 or len(raw) > 2_000_000:
                    raise ScopedProviderReadError(http_status=response.status)
                try:
                    value = json.loads(raw) if raw else {}
                except (ValueError, UnicodeError):
                    raise ScopedProviderReadError(http_status=response.status) from None
                if not isinstance(value, (dict, list)):
                    raise ScopedProviderReadError(http_status=response.status)
                return value
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()  # Never read or retain provider error bodies.
            if status == 401:
                raise AuthenticationDenied() from None
            raise ScopedProviderReadError(http_status=status) from None
        except ScopedProviderReadError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, TypeError):
            raise ScopedProviderReadError() from None

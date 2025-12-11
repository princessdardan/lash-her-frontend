module.exports = [
"[next]/internal/font/google/geist_a71539c9.module.css [app-rsc] (css module)", ((__turbopack_context__) => {

__turbopack_context__.v({
  "className": "geist_a71539c9-module__T19VSG__className",
  "variable": "geist_a71539c9-module__T19VSG__variable",
});
}),
"[next]/internal/font/google/geist_a71539c9.js [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>__TURBOPACK__default__export__
]);
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$geist_a71539c9$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__ = __turbopack_context__.i("[next]/internal/font/google/geist_a71539c9.module.css [app-rsc] (css module)");
;
const fontData = {
    className: __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$geist_a71539c9$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].className,
    style: {
        fontFamily: "'Geist', 'Geist Fallback'",
        fontStyle: "normal"
    }
};
if (__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$geist_a71539c9$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable != null) {
    fontData.variable = __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$geist_a71539c9$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable;
}
const __TURBOPACK__default__export__ = fontData;
}),
"[next]/internal/font/google/geist_mono_8d43a2aa.module.css [app-rsc] (css module)", ((__turbopack_context__) => {

__turbopack_context__.v({
  "className": "geist_mono_8d43a2aa-module__8Li5zG__className",
  "variable": "geist_mono_8d43a2aa-module__8Li5zG__variable",
});
}),
"[next]/internal/font/google/geist_mono_8d43a2aa.js [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>__TURBOPACK__default__export__
]);
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$geist_mono_8d43a2aa$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__ = __turbopack_context__.i("[next]/internal/font/google/geist_mono_8d43a2aa.module.css [app-rsc] (css module)");
;
const fontData = {
    className: __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$geist_mono_8d43a2aa$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].className,
    style: {
        fontFamily: "'Geist Mono', 'Geist Mono Fallback'",
        fontStyle: "normal"
    }
};
if (__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$geist_mono_8d43a2aa$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable != null) {
    fontData.variable = __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$geist_mono_8d43a2aa$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable;
}
const __TURBOPACK__default__export__ = fontData;
}),
"[project]/src/lib/error-handler.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "handleApiError",
    ()=>handleApiError,
    "validateApiResponse",
    ()=>validateApiResponse
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$api$2f$navigation$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/node_modules/next/dist/api/navigation.react-server.js [app-rsc] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$components$2f$navigation$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/client/components/navigation.react-server.js [app-rsc] (ecmascript)");
;
function handleApiError(data, resourceName) {
    if (!data) {
        throw new Error(`Failed to load ${resourceName || "resource"}`);
    }
    // Handle 404 errors specifically with notFound()
    if (data?.error?.status === 404) {
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$components$2f$navigation$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["notFound"])();
    }
    // Handle all other API errors
    if (!data?.success || !data?.data) {
        const errorMessage = data?.error?.message || `Failed to load ${resourceName || "resource"}`;
        throw new Error(errorMessage);
    }
}
function validateApiResponse(data, resourceName) {
    handleApiError(data, resourceName);
    return data.data;
}
}),
"[project]/src/data/data-api.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "api",
    ()=>api,
    "apiRequest",
    ()=>apiRequest
]);
/**
 * Unified API function with timeout and optional authentication
 *
 * Features:
 * - Supports all HTTP methods (GET, POST, PUT, PATCH, DELETE)
 * - Optional authentication (includes Bearer token when authToken provided)
 * - Timeout protection (8 seconds default)
 * - Consistent error handling and response formatting
 * - Handles DELETE requests without response body parsing
 */ async function apiWithTimeout(input, init = {}, timeoutMs = 8000 // 8 seconds default - good balance between patience and UX
) {
    // Create controller to manage request cancellation
    const controller = new AbortController();
    // Set up automatic cancellation after timeout period
    const timeout = setTimeout(()=>controller.abort(), timeoutMs);
    try {
        const response = await fetch(input, {
            ...init,
            signal: controller.signal
        });
        return response;
    } finally{
        // Always clean up the timeout to prevent memory leaks
        // This runs whether the request succeeds, fails, or times out
        clearTimeout(timeout);
    }
}
async function apiRequest(url, options) {
    const { method, payload, timeoutMs = 8000, authToken } = options;
    // Set up base headers for JSON communication
    const headers = {
        "Content-Type": "application/json"
    };
    // Include Bearer token if provided (public requests when no token, authenticated when token provided)
    if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
    }
    try {
        // Make the actual API request with timeout protection
        const response = await apiWithTimeout(url, {
            method,
            headers,
            // GET and DELETE requests don't have request bodies
            body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(payload ?? {})
        }, timeoutMs);
        // Handle DELETE requests that may not return JSON response body
        if (method === "DELETE") {
            return response.ok ? {
                data: true,
                success: true,
                status: response.status
            } : {
                error: {
                    status: response.status,
                    name: "Error",
                    message: "Failed to delete resource"
                },
                success: false,
                status: response.status
            };
        }
        // Parse the JSON response for all other methods
        const data = await response.json();
        // Handle unsuccessful responses (4xx, 5xx status codes)
        if (!response.ok) {
            console.error(`API ${method} error (${response.status}):`, {
                url,
                status: response.status,
                statusText: response.statusText,
                data,
                hasAuthToken: !!authToken
            });
            // If Strapi returns a structured error, pass it through as-is
            if (data.error) {
                return {
                    error: data.error,
                    success: false,
                    status: response.status
                };
            }
            // Otherwise create a generic error response
            return {
                error: {
                    status: response.status,
                    name: data?.error?.name ?? "Error",
                    message: data?.error?.message ?? (response.statusText || "An error occurred")
                },
                success: false,
                status: response.status
            };
        }
        // Success case - extract Strapi data field to avoid double nesting
        // Strapi returns: { data: {...}, meta: {...} }
        // We want to return: { data: {...}, meta: {...}, success: true, status: 200 }
        const responseData = data.data ? data.data : data;
        const responseMeta = data.meta ? data.meta : undefined;
        return {
            data: responseData,
            meta: responseMeta,
            success: true,
            status: response.status
        };
    } catch (error) {
        // Handle timeout errors specifically (when AbortController cancels the request)
        if (error.name === "AbortError") {
            console.error("Request timed out");
            return {
                error: {
                    status: 408,
                    name: "TimeoutError",
                    message: "The request timed out. Please try again."
                },
                success: false,
                status: 408
            };
        }
        // Handle network errors, JSON parsing errors, and other unexpected issues
        console.error(`Network or unexpected error on ${method} ${url}:`, error);
        return {
            error: {
                status: 500,
                name: "NetworkError",
                message: error instanceof Error ? error.message : "Something went wrong"
            },
            success: false,
            status: 500
        };
    }
}
const api = {
    get: (url, options = {})=>apiRequest(url, {
            method: "GET",
            ...options
        }),
    post: (url, payload, options = {})=>apiRequest(url, {
            method: "POST",
            payload,
            ...options
        }),
    put: (url, payload, options = {})=>apiRequest(url, {
            method: "PUT",
            payload,
            ...options
        }),
    patch: (url, payload, options = {})=>apiRequest(url, {
            method: "PATCH",
            payload,
            ...options
        }),
    delete: (url, options = {})=>apiRequest(url, {
            method: "DELETE",
            ...options
        })
};
}),
"[project]/src/lib/utils.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "cn",
    ()=>cn,
    "getStrapiURL",
    ()=>getStrapiURL
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$clsx$2f$dist$2f$clsx$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/clsx/dist/clsx.mjs [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$tailwind$2d$merge$2f$dist$2f$bundle$2d$mjs$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/tailwind-merge/dist/bundle-mjs.mjs [app-rsc] (ecmascript)");
;
;
function cn(...inputs) {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$tailwind$2d$merge$2f$dist$2f$bundle$2d$mjs$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["twMerge"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$clsx$2f$dist$2f$clsx$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["clsx"])(inputs));
}
function getStrapiURL() {
    return process.env.NEXT_PUBLIC_STRAPI_API_URL || "http://localhost:1337";
}
}),
"[project]/src/data/loaders.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "loaders",
    ()=>loaders
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$qs$2f$lib$2f$index$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/qs/lib/index.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$data$2f$data$2d$api$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/data/data-api.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/utils.ts [app-rsc] (ecmascript)");
;
;
;
const baseUrl = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["getStrapiURL"])();
async function getHomePageData() {
    const query = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$qs$2f$lib$2f$index$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].stringify({
        populate: {
            blocks: {
                on: {
                    "layout.hero-section": {
                        populate: {
                            image: {
                                fields: [
                                    "url",
                                    "alternativeText"
                                ]
                            },
                            link: {
                                populate: true
                            }
                        }
                    },
                    "layout.features-section": {
                        populate: {
                            features: {
                                populate: true
                            }
                        }
                    }
                }
            }
        }
    });
    const url = new URL("/api/home-page", baseUrl);
    url.search = query;
    return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$data$2f$data$2d$api$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["api"].get(url.href);
}
async function getGlobalData() {
    const query = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$qs$2f$lib$2f$index$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].stringify({
        populate: [
            "header.logoText",
            "header.ctaButton",
            "footer.logoText",
            "footer.socialLink"
        ]
    });
    const url = new URL("/api/global", baseUrl);
    url.search = query;
    return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$data$2f$data$2d$api$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["api"].get(url.href);
}
const loaders = {
    getHomePageData,
    getGlobalData
};
}),
"[project]/src/app/layout.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>RootLayout,
    "metadata",
    ()=>metadata
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$geist_a71539c9$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[next]/internal/font/google/geist_a71539c9.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$geist_mono_8d43a2aa$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[next]/internal/font/google/geist_mono_8d43a2aa.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$error$2d$handler$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/error-handler.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$data$2f$loaders$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/data/loaders.ts [app-rsc] (ecmascript)");
;
;
;
;
;
;
const metadata = {
    title: "Create Next App",
    description: "Generated by create next app"
};
async function RootLayout({ children }) {
    const globalDataResponse = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$data$2f$loaders$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["loaders"].getGlobalData();
    const globalData = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$error$2d$handler$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["validateApiResponse"])(globalDataResponse, "global page");
    console.dir(globalData, {
        depth: null
    });
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("html", {
        lang: "en",
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("body", {
            className: `${__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$geist_a71539c9$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].variable} ${__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$geist_mono_8d43a2aa$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].variable} antialiased`,
            children: children
        }, void 0, false, {
            fileName: "[project]/src/app/layout.tsx",
            lineNumber: 33,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/src/app/layout.tsx",
        lineNumber: 32,
        columnNumber: 5
    }, this);
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__ac49c8e2._.js.map
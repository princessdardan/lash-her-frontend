module.exports = [
"[project]/frontend/src/data/data-api.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
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
"[project]/frontend/src/lib/utils.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "cn",
    ()=>cn,
    "getStrapiURL",
    ()=>getStrapiURL
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$clsx$2f$dist$2f$clsx$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/clsx/dist/clsx.mjs [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$tailwind$2d$merge$2f$dist$2f$bundle$2d$mjs$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/tailwind-merge/dist/bundle-mjs.mjs [app-rsc] (ecmascript)");
;
;
function cn(...inputs) {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$tailwind$2d$merge$2f$dist$2f$bundle$2d$mjs$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["twMerge"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$clsx$2f$dist$2f$clsx$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["clsx"])(inputs));
}
function getStrapiURL() {
    return ("TURBOPACK compile-time value", "http://localhost:1337") || "http://localhost:1337";
}
}),
"[project]/frontend/src/data/loaders.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "loaders",
    ()=>loaders
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$qs$2f$lib$2f$index$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/qs/lib/index.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$data$2f$data$2d$api$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/data/data-api.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/lib/utils.ts [app-rsc] (ecmascript)");
;
;
;
const baseUrl = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["getStrapiURL"])();
async function getHomePageData() {
    const query = __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$qs$2f$lib$2f$index$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].stringify({
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
    return __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$data$2f$data$2d$api$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["api"].get(url.href);
}
async function getGlobalData() {
    const query = __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$qs$2f$lib$2f$index$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].stringify({
        populate: [
            "header.logoText",
            "header.ctaButton",
            "footer.logoText",
            "footer.socialLink"
        ]
    });
    const url = new URL("/api/global", baseUrl);
    url.search = query;
    return __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$data$2f$data$2d$api$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["api"].get(url.href);
}
async function getContactPageData() {
    const query = __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$qs$2f$lib$2f$index$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].stringify({
        populate: {
            blocks: {
                on: {
                    "layout.schedule": {
                        populate: {
                            hours: {
                                populate: true
                            }
                        }
                    },
                    "layout.contact-info": {
                        populate: {
                            contact: {
                                populate: true
                            }
                        }
                    },
                    "layout.general-inquiry-labels": {
                        populate: true
                    }
                }
            }
        }
    });
    const url = new URL("/api/contact", baseUrl);
    url.search = query;
    return __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$data$2f$data$2d$api$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["api"].get(url.href);
}
async function getGalleryPageData() {
    const query = __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$qs$2f$lib$2f$index$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].stringify({
        populate: {
            blocks: {
                on: {
                    "layout.photo-gallery": {
                        populate: {
                            image: {
                                populate: true
                            }
                        }
                    }
                }
            }
        }
    });
    const url = new URL("/api/gallery", baseUrl);
    url.search = query;
    return __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$data$2f$data$2d$api$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["api"].get(url.href);
}
async function getTrainingsPageData() {
    const query = __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$qs$2f$lib$2f$index$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].stringify({
        populate: {
            blocks: {
                on: {
                    "layout.cta-features-section": {
                        populate: {
                            features: {
                                populate: {
                                    link: {
                                        populate: true
                                    }
                                }
                            }
                        }
                    },
                    "layout.image-with-text": {
                        populate: {
                            image: {
                                fields: [
                                    "url",
                                    "alternativeText"
                                ]
                            }
                        }
                    }
                }
            }
        }
    });
    const url = new URL("/api/training", baseUrl);
    url.search = query;
    return __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$data$2f$data$2d$api$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["api"].get(url.href);
}
async function getMetaData() {
    const query = __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$qs$2f$lib$2f$index$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].stringify({
        fields: [
            "title",
            "description"
        ]
    });
    const url = new URL("/api/global", baseUrl);
    url.search = query;
    return __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$data$2f$data$2d$api$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["api"].get(url.href);
}
const loaders = {
    getHomePageData,
    getGlobalData,
    getMetaData,
    getTrainingsPageData,
    getContactPageData,
    getGalleryPageData
};
}),
"[project]/frontend/src/lib/error-handler.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "handleApiError",
    ()=>handleApiError,
    "validateApiResponse",
    ()=>validateApiResponse
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$api$2f$navigation$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/api/navigation.react-server.js [app-rsc] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$components$2f$navigation$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/client/components/navigation.react-server.js [app-rsc] (ecmascript)");
;
function handleApiError(data, resourceName) {
    if (!data) {
        throw new Error(`Failed to load ${resourceName || "resource"}`);
    }
    // Handle 404 errors specifically with notFound()
    if (data?.error?.status === 404) {
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$components$2f$navigation$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["notFound"])();
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
"[project]/frontend/src/components/custom/logo.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Logo",
    ()=>Logo
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/client/app-dir/link.react-server.js [app-rsc] (ecmascript)");
;
;
const styles = {
    link: "flex items-center gap-2",
    icon: "h-40 w-auto text-white",
    text: {
        base: "text-lg font-semibold",
        light: "text-slate-900",
        dark: "text-white"
    }
};
function LashHerLogo(props) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
        ...props,
        xmlns: "http://www.w3.org/2000/svg",
        xmlnsXlink: "http://www.w3.org/1999/xlink",
        viewBox: "0 0 736 736",
        fill: "currentColor",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M187.236511,398.394287 C193.115112,394.244415 196.590454,388.464569 200.650253,383.206116 C202.676407,380.581726 204.702393,379.354126 207.238098,382.612549 C212.669312,379.174530 218.609756,377.075348 224.739746,375.419861 C227.307770,374.726379 229.884109,374.017029 232.375931,373.096344 C241.161942,369.850037 241.744354,369.060211 241.650467,359.726349 C241.597321,354.444824 242.413193,349.079773 239.955566,343.997772 C236.421127,336.689087 228.219040,334.444153 222.106079,339.211182 C220.001099,340.852692 218.990585,343.051483 218.460037,345.551575 C218.043472,347.514557 219.913239,349.906616 217.305923,351.464935 C214.001953,353.439636 210.555786,355.163269 206.811600,356.018646 C204.279236,356.597168 203.728119,354.639771 203.728302,352.622650 C203.728806,347.517151 206.009354,343.249786 209.160934,339.517456 C217.232254,329.958801 232.499680,326.612427 243.866974,331.942017 C251.998413,335.754395 256.291595,342.303284 256.335663,351.353912 C256.403015,365.182587 256.412872,379.012695 256.273560,392.840454 C256.229858,397.178467 258.032593,399.424561 262.314880,399.692505 C265.697083,399.904205 267.711731,398.669312 267.765137,394.903046 C267.790527,393.110901 266.807556,390.399200 269.710419,390.003784 C272.254028,389.657288 272.725372,392.276367 273.539246,393.976044 C276.611176,400.391296 280.524750,405.790497 288.247437,406.791901 C294.638031,407.620605 298.121582,405.975800 300.903687,401.065216 C303.794800,395.962250 303.095398,391.106384 299.738007,386.582306 C296.485840,382.199982 291.780518,379.549469 287.233765,376.773499 C282.385834,373.813660 277.633575,370.761658 273.813354,366.465912 C265.548492,357.172241 266.026215,345.599365 275.059662,337.118683 C284.070343,328.659424 294.593689,328.007660 305.796814,331.320709 C309.595123,332.443970 311.459930,335.134949 311.311981,339.216980 C311.191345,342.544891 311.318451,345.881134 311.267395,349.212616 C311.244843,350.684692 311.397186,352.450958 309.507843,352.912262 C307.629395,353.370911 306.865387,351.800629 306.234283,350.453278 C304.526733,346.807648 302.590118,343.307587 299.614624,340.545380 C295.913666,337.109741 290.027100,336.018982 286.160919,338.118927 C281.964569,340.398163 280.045837,344.085358 280.194000,348.848450 C280.322021,352.964050 282.916504,355.632965 285.953491,357.730133 C291.566925,361.606506 297.435425,365.111115 303.108582,368.903900 C308.788177,372.700897 313.371277,377.499115 315.131256,384.316315 C318.592773,397.724731 310.985199,409.461212 297.320190,412.252930 C292.491028,413.239502 287.709167,413.262024 282.988617,412.056610 C279.602783,411.192017 276.473083,409.819550 273.093231,412.388550 C271.391937,413.681732 269.979828,412.437714 269.488861,410.450928 C269.057434,408.704987 268.645996,406.954071 268.091187,404.645660 C264.727692,406.657684 261.689606,408.581055 258.554169,410.329926 C250.585587,414.774475 247.760208,413.912598 243.433304,405.914703 C242.811676,404.765656 242.447540,403.408203 240.991562,402.632538 C237.990631,403.115479 235.716599,405.210693 233.531631,407.128448 C221.018280,418.111511 202.739731,411.903503 201.189545,392.876831 C198.588257,397.826385 196.210678,402.123199 194.058243,406.529938 C192.740585,409.227631 190.956955,410.425781 187.830170,410.414001 C160.838821,410.312103 133.846924,410.363373 106.855309,410.312714 C105.193604,410.309601 102.612602,411.058289 102.520477,408.350616 C102.421364,405.437775 105.082237,405.779297 106.995087,405.777679 C109.875931,405.775208 112.629120,405.310913 115.266350,404.180878 C119.977112,402.162292 122.772301,398.793884 122.770721,393.460602 C122.761787,363.303406 122.802704,333.146057 122.713669,302.989105 C122.696884,297.303894 117.936157,293.783386 109.658722,292.372375 C107.591057,292.019897 103.641693,293.930725 103.908752,289.862030 C104.148346,286.211731 107.889153,287.793304 110.042076,287.773346 C125.869186,287.626648 141.698288,287.692780 157.526764,287.700500 C158.858505,287.701141 160.192505,287.728271 161.521301,287.810303 C162.783646,287.888245 163.849136,288.372894 163.947220,289.807526 C164.065292,291.534576 162.900833,292.214325 161.427963,292.216370 C157.256454,292.222168 153.134247,292.554871 149.031113,293.355591 C142.517227,294.626740 141.245270,295.993103 141.237839,302.631226 C141.204102,332.788635 141.195892,362.946075 141.210861,393.103516 C141.214340,400.108582 142.059021,400.962280 148.917542,400.995514 C158.414383,401.041534 167.911636,401.007324 177.408707,401.005127 C180.782867,401.004364 184.072617,400.661713 187.236511,398.394287 M235.249634,399.808838 C238.108673,398.282501 241.004654,396.427734 241.348892,393.041656 C241.816681,388.440277 241.660294,383.756805 241.498474,379.118042 C241.418503,376.825836 239.908951,375.859589 237.675720,376.904938 C232.115479,379.507690 226.304504,381.722260 221.116165,384.935516 C214.292023,389.161835 214.903519,397.442261 221.921478,401.499939 C226.437561,404.111053 230.558990,402.378326 235.249634,399.808838 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 22,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M474.260742,341.211609 C466.966980,345.745453 463.829803,351.768341 464.221863,360.235474 C464.737793,371.377747 464.317657,382.562469 464.336456,393.728912 C464.348419,400.834259 466.064789,402.968994 472.987610,405.120667 C474.531372,405.600464 476.919769,405.299805 476.856659,408.696899 C463.634338,408.696899 450.439545,408.696899 437.173492,408.696899 C437.016907,405.191833 439.701080,405.583893 441.326538,405.056000 C447.631134,403.008362 449.644043,400.731689 449.652588,394.380035 C449.698975,359.880737 449.611267,325.381073 449.742645,290.882202 C449.763916,285.301788 446.205566,283.961212 442.019409,282.745819 C440.204437,282.218842 437.559357,282.455627 437.356567,279.826050 C437.162323,277.307007 439.701813,276.856842 441.406433,276.011932 C446.779327,273.348938 452.168213,270.709076 457.635071,268.247223 C463.334442,265.680664 464.329620,266.362183 464.336700,272.532898 C464.360260,293.032440 464.341492,313.532043 464.376160,334.031525 C464.380005,336.306274 463.954681,338.712067 465.968140,341.119385 C468.580841,338.842651 471.212433,336.644440 473.738525,334.331024 C482.507019,326.300812 497.263611,327.489716 505.185028,332.160919 C512.560364,336.510193 514.423218,343.982544 515.319153,351.780090 C516.826477,364.898743 515.928040,378.073975 516.080017,391.223450 C516.203003,401.863159 516.102112,401.873962 526.106873,405.438934 C527.373169,405.890106 528.751587,406.118500 528.733337,408.616455 C515.395630,408.616455 502.042633,408.616455 488.644135,408.616455 C488.251556,405.508484 490.654083,405.781158 492.199005,405.296021 C499.730377,402.931152 501.154358,401.504120 501.037018,393.614868 C500.831604,379.803131 501.937927,365.999939 500.804443,352.174561 C499.818634,340.150116 490.877167,334.211517 479.511444,338.623932 C477.811707,339.283813 476.221100,340.224640 474.260742,341.211609 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 23,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M342.267944,325.997559 C342.267761,331.794586 342.267761,337.092377 342.267761,343.775421 C345.416809,340.855560 347.677338,338.835510 349.853149,336.728058 C356.662903,330.132233 364.953278,328.433807 373.904053,330.014862 C386.703369,332.275696 393.040192,340.351929 393.271240,354.530090 C393.480225,367.356689 393.319061,380.189056 393.353973,393.018768 C393.376801,401.415894 394.913361,403.439026 402.736420,406.030518 C404.304230,406.549866 406.585938,406.557281 406.398041,409.753082 C393.018524,409.753082 379.668121,409.753082 366.024597,409.753082 C366.644104,406.158752 369.275635,406.429688 371.117828,405.859436 C376.865967,404.080078 378.738739,401.848572 378.743652,395.830139 C378.755127,381.834137 378.772644,367.837158 378.627838,353.842285 C378.502472,341.725983 369.183228,335.160828 357.846252,339.514374 C348.397522,343.142822 341.374054,347.920135 342.129303,361.387482 C342.753357,372.515869 342.223785,383.707520 342.254395,394.871033 C342.274323,402.138489 343.605408,403.756989 350.450195,405.933228 C352.118500,406.463684 354.696014,406.160614 354.867401,409.727966 C341.437408,409.727966 328.104431,409.727966 314.678253,409.727966 C314.724243,406.198151 317.336975,406.566711 318.995117,406.042999 C325.143860,404.100983 327.568451,401.565704 327.582977,395.439972 C327.664673,360.949585 327.612122,326.458862 327.606750,291.968262 C327.606171,288.185150 326.139862,285.537262 322.141418,284.784058 C321.493011,284.661957 320.818665,284.471161 320.255188,284.142548 C318.496857,283.117157 315.356934,283.712891 315.184570,280.884338 C315.001678,277.882599 318.079102,277.586853 320.046722,276.617004 C325.124207,274.114288 330.271790,271.749603 335.432648,269.421356 C341.353149,266.750458 342.218292,267.325745 342.234253,274.012421 C342.275238,291.174316 342.260559,308.336365 342.267944,325.997559 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 24,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M534.321289,345.430481 C542.375305,332.473297 553.987000,327.618896 568.487976,328.703918 C571.212646,328.907776 573.767517,329.785828 576.036072,331.122253 C586.020691,337.004425 591.461548,346.103577 593.207214,357.296051 C594.154663,363.370575 592.978210,364.251526 586.810425,364.267822 C573.657898,364.302521 560.505188,364.271515 547.352661,364.309540 C541.052979,364.327759 540.011047,365.253693 540.393127,371.632202 C541.086182,383.203552 545.949097,392.607971 556.449890,398.062775 C566.790344,403.434326 576.395569,400.501160 585.470398,394.213135 C587.372131,392.895447 589.452881,388.908661 591.960571,391.863434 C594.313538,394.635895 590.319885,396.331604 588.677856,398.036804 C581.937378,405.036407 573.883606,409.744171 564.156189,411.380127 C552.209595,413.389282 542.703186,408.794525 535.737549,399.647369 C523.826843,384.006561 524.336914,367.002869 531.966614,349.678680 C532.567993,348.313232 533.395081,347.047180 534.321289,345.430481 M546.088379,356.003082 C555.053833,356.026398 564.019836,356.119965 572.984436,356.043457 C577.484741,356.005066 578.598816,354.336395 577.129761,350.065155 C575.693542,345.889221 573.070740,342.473114 569.800049,339.555664 C563.996277,334.378754 557.911011,334.189575 551.838684,339.074677 C547.835571,342.295166 545.436829,346.661133 543.676636,351.377045 C543.013794,353.153076 542.828979,355.039795 546.088379,356.003082 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 25,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M655.629639,335.231079 C657.534668,339.911682 655.353333,343.378815 652.580566,346.238647 C650.129517,348.766754 647.280029,346.651703 644.711548,345.643494 C632.966797,341.033508 623.447937,347.532074 623.362427,360.321350 C623.293335,370.645416 623.334656,380.970306 623.353455,391.294800 C623.369995,400.350006 625.688477,402.957977 634.528320,404.860901 C636.760193,405.341370 640.017517,404.567566 641.223389,408.691681 C625.983459,408.691681 611.166077,408.691681 596.278687,408.691681 C596.395203,405.323761 598.752014,405.711884 600.307922,405.241241 C607.367493,403.105682 608.791077,401.323364 608.805969,393.846161 C608.832520,380.524292 608.663513,367.200104 608.872131,353.881500 C608.953979,348.652496 607.143494,345.691711 601.773926,344.987793 C599.924133,344.745300 597.398987,344.585022 597.009033,342.109161 C596.553955,339.219757 599.307129,338.698517 601.140503,337.874939 C608.045532,334.773285 614.591064,330.787964 622.195923,328.608124 C624.640686,333.789124 622.248962,339.145416 624.098328,344.356415 C629.349792,338.954285 632.429810,331.106506 640.440674,330.166656 C645.708069,329.548676 650.810303,332.046051 655.629639,335.231079 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 26,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M371.428772,444.405334 C360.073090,452.893005 351.388947,463.516785 341.990082,473.845673 C346.323364,465.414032 346.825165,456.032257 349.404388,446.864380 C343.512939,452.933868 337.736053,459.120209 331.699249,465.041534 C325.062317,471.551575 317.219299,475.611328 307.645844,475.390472 C301.197876,475.241699 298.210602,470.635345 300.292267,464.493744 C302.411530,458.241241 306.657227,454.083191 312.582764,451.510956 C314.473236,450.690277 316.175873,449.949799 316.438385,447.491852 C317.016937,442.074432 320.605713,438.802490 325.201111,436.853088 C337.537201,431.620117 349.843964,432.753448 361.990631,437.751770 C362.438660,437.936096 362.830536,438.295471 363.194275,438.631958 C363.419189,438.839996 363.541321,439.159149 363.821503,439.607452 C356.008148,442.624115 354.225189,449.540344 351.994934,457.525208 C356.616882,454.851135 358.981934,451.373779 361.924774,448.571075 C367.164825,443.580505 372.827667,439.286407 379.739014,436.908600 C385.174255,435.038605 388.176880,436.212921 390.427277,441.527893 C383.285736,438.192902 377.320831,440.181427 371.428772,444.405334 M355.200500,439.537750 C355.865753,438.581451 355.433685,437.882965 354.508057,437.663269 C348.299591,436.189514 341.988617,435.602783 335.727539,436.949585 C330.711121,438.028595 325.557892,439.119171 321.746979,443.062775 C320.444733,444.410339 319.303406,446.038574 319.709564,447.948669 C320.200104,450.255798 322.317596,449.392303 323.869415,449.574005 C328.600281,450.127930 330.550934,452.827454 329.024353,457.343140 C327.436737,454.022461 325.520447,450.869507 321.664093,451.646088 C313.677612,453.254456 307.032654,457.086365 303.175568,464.713562 C302.115570,466.809601 301.939240,468.937317 303.282593,470.868652 C304.740417,472.964539 306.952240,473.573669 309.452698,473.230408 C314.192780,472.579712 318.337616,470.586182 322.165894,467.783142 C328.362122,463.246216 334.162811,458.257782 339.572693,452.811096 C344.269379,448.082458 349.018219,443.416168 355.200500,439.537750 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 27,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M180.092285,480.230774 C184.457520,481.302002 188.280548,480.238953 192.208206,478.993164 C192.696945,480.813690 191.552139,481.344543 190.602921,481.794556 C184.184799,484.837341 176.147415,482.794556 171.951874,476.912109 C170.699371,475.156067 169.523346,473.858704 167.167801,474.043793 C165.704208,474.158813 164.123917,474.110443 163.602951,472.282532 C163.881042,470.687836 165.201157,470.539337 166.272903,470.338501 C168.890335,469.847992 169.561096,468.352661 169.702362,465.780731 C170.868713,444.546600 192.010696,429.678406 212.332535,436.151581 C216.181580,437.377625 218.842239,433.898956 223.209183,435.543884 C218.094894,437.656982 217.188934,440.746277 218.202271,445.478058 C218.922760,448.842285 215.900665,451.510590 212.871429,453.259613 C211.300171,454.166809 209.635910,454.912933 208.029663,455.723724 C213.195816,468.236725 203.533295,474.152161 190.625198,475.361786 C185.036453,475.885529 179.497314,474.792297 173.516830,474.058655 C174.756516,477.492828 177.160919,478.872498 180.092285,480.230774 M211.493958,438.809143 C202.936218,434.014252 195.239349,437.580841 188.158997,441.968994 C179.181747,447.532776 173.086151,455.478271 172.110611,466.505798 C171.810669,469.896271 173.031326,471.048706 176.547379,469.909668 C180.303986,468.692657 183.400604,466.586060 186.329712,464.095581 C195.334335,456.439362 202.264862,446.664642 211.493958,438.809143 M191.953217,472.626129 C198.007660,471.861755 202.514664,468.872437 205.069916,463.264099 C206.135544,460.925232 205.779968,458.662201 203.680725,456.990173 C202.255966,455.855408 200.898056,456.318542 199.741180,457.595551 C194.084366,463.839783 187.616592,468.972015 178.405746,471.999725 C183.512344,472.522308 187.280716,473.110443 191.953217,472.626129 M214.628036,442.822601 C211.204834,443.472290 206.654312,448.146179 204.852859,452.862793 C210.179077,452.810150 212.673386,450.420532 214.628036,442.822601 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 28,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M244.974930,457.968842 C247.595825,457.669495 249.467896,455.075623 252.285553,455.394653 C252.497162,455.838470 252.822266,456.286194 252.740067,456.381104 C242.769394,467.891663 233.952972,480.669464 219.061020,486.752197 C214.257645,488.714172 209.298538,489.057831 204.358490,488.128937 C200.494431,487.402374 197.294266,485.403046 197.200958,480.757782 C198.873184,480.009033 199.117310,481.281281 199.707428,481.967682 C203.045959,485.850403 207.081116,487.317871 212.179749,485.988800 C218.158676,484.430206 223.113266,481.225006 227.576218,477.105804 C228.694550,476.073608 230.017212,474.947083 229.143127,473.289307 C226.923248,469.079132 229.505096,466.324890 231.931503,463.560089 C234.247055,460.921509 236.919556,458.637756 239.952560,456.857147 C241.608170,455.885162 243.481888,454.576019 244.656754,457.733826 C241.175369,459.989105 238.985779,462.727905 237.074234,465.737091 C240.441544,463.877930 243.648346,461.865356 244.974930,457.968842 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 29,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M384.715057,455.411621 C389.009277,452.646149 392.994751,454.623596 397.725311,454.874725 C394.622711,459.191742 390.407928,461.762970 388.125244,466.174500 C390.862366,465.857574 391.959564,462.626892 394.781982,463.064392 C392.921661,468.580170 386.326019,472.475555 381.251892,470.875244 C379.754852,470.403107 378.672180,470.887543 377.452606,471.347076 C376.022827,471.885773 374.519470,472.512146 373.290253,471.136627 C372.010651,469.704742 372.410004,467.998596 373.063904,466.426453 C375.247772,461.175720 379.623077,458.179871 384.715057,455.411621 M382.835876,464.331787 C384.252747,462.641998 386.468353,461.553284 387.043640,458.517242 C382.638397,460.935547 379.396301,463.774048 377.775391,468.347137 C379.291901,467.156189 380.808380,465.965240 382.835876,464.331787 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 30,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M460.805573,463.102783 C463.408936,462.678955 463.569550,464.038452 462.128235,465.052399 C457.973328,467.975311 455.013031,474.137421 448.197510,470.664368 C447.634277,470.377380 446.607300,470.874756 445.840637,471.138245 C444.119232,471.729797 442.337158,472.756134 440.821991,470.916351 C439.232208,468.986023 440.426270,467.106537 441.324371,465.367889 C445.605347,457.080353 454.231964,453.248444 464.703766,455.253510 C462.599030,459.613922 457.720825,461.612885 455.633575,466.130249 C458.116821,465.989441 459.019012,464.130768 460.805573,463.102783 M450.796509,464.217590 C452.810699,461.937592 454.824890,459.657623 456.839081,457.377655 C452.670166,459.970825 448.192322,462.175446 446.533020,467.483124 C447.792786,466.548676 449.052521,465.614258 450.796509,464.217590 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 31,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M592.498535,455.627716 C589.384094,459.526703 586.207214,463.062836 582.363831,467.340790 C586.225098,466.483856 587.678528,463.107452 591.006653,462.971802 C588.108276,469.133453 582.898560,471.739075 576.692322,470.335022 C575.563171,470.079590 574.804199,470.733551 573.909241,471.103455 C572.368530,471.740295 570.681458,472.656586 569.354004,470.993958 C568.069275,469.384827 568.643616,467.563629 569.407715,465.822327 C572.923950,457.810059 582.869446,453.238678 592.498535,455.627716 M577.301270,465.630035 C580.207336,463.189819 582.939758,460.596588 586.045044,456.458405 C578.846924,460.470612 575.517761,463.699829 573.318359,468.533783 C574.712280,467.519714 575.743591,466.769409 577.301270,465.630035 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 32,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M489.123657,467.180664 C486.907501,468.694244 485.029449,470.069885 483.045715,471.270935 C481.596375,472.148499 479.943451,472.815704 478.494598,471.288239 C476.966339,469.677032 477.453400,467.919769 478.506805,466.270935 C479.220673,465.153564 479.958405,464.032074 480.827484,463.036407 C486.738251,456.264618 493.134125,449.971497 500.240814,444.472229 C502.747620,442.532379 505.348572,440.154663 510.171417,441.122040 C500.034821,449.567291 490.260651,457.323883 482.299286,467.971649 C486.437866,467.454773 487.962891,463.645721 491.459320,463.035980 C492.198212,465.214813 490.510834,465.947540 489.123657,467.180664 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 33,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M436.148743,445.557190 C436.055145,448.909332 432.654358,449.202301 430.857117,451.116852 C429.278900,452.798126 426.894562,453.888824 428.902405,456.862335 C421.677368,457.687439 418.792511,463.102386 414.252930,468.540894 C419.131897,467.645416 421.032654,463.552124 426.085388,462.751129 C422.582611,467.639587 419.016388,470.646912 414.430450,471.919556 C410.984955,472.875763 409.432587,470.038574 410.831177,467.511566 C413.374634,462.916046 415.561462,457.912842 420.455780,454.910034 C423.108215,453.282623 425.201813,450.771759 427.714142,448.880829 C430.099792,447.085236 432.680084,445.523224 436.148743,445.557190 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 34,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M541.886841,459.906708 C545.000671,457.354736 547.874146,455.086945 551.471985,454.051331 C552.950073,453.625885 554.512451,453.404907 555.373169,455.130310 C556.099304,456.585999 555.179443,457.681152 554.250610,458.649445 C552.364014,460.615997 550.100769,461.941376 547.373230,462.358734 C544.005920,462.873932 542.587463,465.160187 541.155518,468.483459 C546.684387,468.580963 549.010193,464.028717 553.093323,462.498138 C551.986450,466.811371 543.781494,472.781097 540.059448,472.177063 C537.155457,471.705841 536.201599,469.751801 536.957397,467.058014 C537.737610,464.277161 539.352051,461.972076 541.886841,459.906708 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 35,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M511.137939,462.215302 C514.829712,458.846588 517.582703,454.638550 524.333740,454.044556 C520.513550,459.863556 515.050964,462.646027 512.366577,467.958496 C516.137695,467.482941 517.932190,463.559387 521.531006,462.723358 C520.632080,466.436401 513.386169,472.235657 509.995819,472.061951 C507.668304,471.942657 506.754242,470.582672 507.273407,468.354614 C507.819550,466.010956 509.312103,464.208801 511.137939,462.215302 z"
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 36,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/frontend/src/components/custom/logo.tsx",
        lineNumber: 15,
        columnNumber: 5
    }, this);
}
function Logo({ text, dark = false }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"], {
        className: styles.link,
        href: "/",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(LashHerLogo, {
                className: styles.icon
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 49,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: `${styles.text.base} ${dark ? styles.text.dark : styles.text.light}`,
                children: text
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/logo.tsx",
                lineNumber: 50,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/frontend/src/components/custom/logo.tsx",
        lineNumber: 48,
        columnNumber: 5
    }, this);
}
}),
"[project]/frontend/src/components/custom/navigation.tsx [app-rsc] (client reference proxy) <module evaluation>", ((__turbopack_context__) => {
"use strict";

// This file is generated by next-core EcmascriptClientReferenceModule.
__turbopack_context__.s([
    "Navigation",
    ()=>Navigation
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-server-dom-turbopack-server.js [app-rsc] (ecmascript)");
;
const Navigation = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["registerClientReference"])(function() {
    throw new Error("Attempted to call Navigation() from the server but Navigation is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.");
}, "[project]/frontend/src/components/custom/navigation.tsx <module evaluation>", "Navigation");
}),
"[project]/frontend/src/components/custom/navigation.tsx [app-rsc] (client reference proxy)", ((__turbopack_context__) => {
"use strict";

// This file is generated by next-core EcmascriptClientReferenceModule.
__turbopack_context__.s([
    "Navigation",
    ()=>Navigation
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-server-dom-turbopack-server.js [app-rsc] (ecmascript)");
;
const Navigation = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["registerClientReference"])(function() {
    throw new Error("Attempted to call Navigation() from the server but Navigation is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.");
}, "[project]/frontend/src/components/custom/navigation.tsx", "Navigation");
}),
"[project]/frontend/src/components/custom/navigation.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$navigation$2e$tsx__$5b$app$2d$rsc$5d$__$28$client__reference__proxy$29$__$3c$module__evaluation$3e$__ = __turbopack_context__.i("[project]/frontend/src/components/custom/navigation.tsx [app-rsc] (client reference proxy) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$navigation$2e$tsx__$5b$app$2d$rsc$5d$__$28$client__reference__proxy$29$__ = __turbopack_context__.i("[project]/frontend/src/components/custom/navigation.tsx [app-rsc] (client reference proxy)");
;
__turbopack_context__.n(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$navigation$2e$tsx__$5b$app$2d$rsc$5d$__$28$client__reference__proxy$29$__);
}),
"[project]/frontend/src/components/ui/button.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Button",
    ()=>Button,
    "buttonVariants",
    ()=>buttonVariants
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$slot$2f$dist$2f$index$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@radix-ui/react-slot/dist/index.mjs [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$class$2d$variance$2d$authority$2f$dist$2f$index$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/class-variance-authority/dist/index.mjs [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/lib/utils.ts [app-rsc] (ecmascript)");
;
;
;
;
const buttonVariants = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$class$2d$variance$2d$authority$2f$dist$2f$index$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["cva"])("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive", {
    variants: {
        variant: {
            default: "bg-primary text-primary-foreground hover:bg-primary/90",
            destructive: "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
            outline: "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
            secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
            ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
            link: "text-primary underline-offset-4 hover:underline"
        },
        size: {
            default: "h-9 px-4 py-2 has-[>svg]:px-3",
            sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
            lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
            icon: "size-9",
            "icon-sm": "size-8",
            "icon-lg": "size-10"
        }
    },
    defaultVariants: {
        variant: "default",
        size: "default"
    }
});
function Button({ className, variant, size, asChild = false, ...props }) {
    const Comp = asChild ? __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$slot$2f$dist$2f$index$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["Slot"] : "button";
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Comp, {
        "data-slot": "button",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["cn"])(buttonVariants({
            variant,
            size,
            className
        })),
        ...props
    }, void 0, false, {
        fileName: "[project]/frontend/src/components/ui/button.tsx",
        lineNumber: 52,
        columnNumber: 5
    }, this);
}
;
}),
"[project]/frontend/src/components/custom/header.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Header",
    ()=>Header
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/client/app-dir/link.react-server.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$logo$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/custom/logo.tsx [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$navigation$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/custom/navigation.tsx [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$ui$2f$button$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/ui/button.tsx [app-rsc] (ecmascript)");
;
;
;
;
;
async function Header({ data }) {
    if (!data) return null;
    const { logoText, ctaButton } = data;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "flex items-center justify-between px-4 bg-black text-white shadow-md dark:bg-gray-800",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$logo$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["Logo"], {
                text: logoText.label
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/header.tsx",
                lineNumber: 19,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "flex items-center gap-4",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$navigation$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["Navigation"], {}, void 0, false, {
                        fileName: "[project]/frontend/src/components/custom/header.tsx",
                        lineNumber: 21,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"], {
                        href: ctaButton.href,
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$ui$2f$button$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["Button"], {
                            children: ctaButton.label
                        }, void 0, false, {
                            fileName: "[project]/frontend/src/components/custom/header.tsx",
                            lineNumber: 23,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/frontend/src/components/custom/header.tsx",
                        lineNumber: 22,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/frontend/src/components/custom/header.tsx",
                lineNumber: 20,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/frontend/src/components/custom/header.tsx",
        lineNumber: 18,
        columnNumber: 5
    }, this);
}
}),
"[project]/frontend/src/components/custom/footer.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Footer",
    ()=>Footer
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/client/app-dir/link.react-server.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$logo$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/custom/logo.tsx [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f40$icons$2d$pack$2f$react$2d$simple$2d$icons$2f$icons$2f$SiInstagram$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__SiInstagram$3e$__ = __turbopack_context__.i("[project]/frontend/node_modules/@icons-pack/react-simple-icons/icons/SiInstagram.mjs [app-rsc] (ecmascript) <export default as SiInstagram>");
;
;
;
;
const styles = {
    footer: "dark bg-gray-900 text-white py-8",
    container: "container mx-auto px-4 md:px-6 flex flex-col md:flex-row items-center justify-between",
    text: "mt-4 md:mt-0 text-sm text-gray-300",
    socialContainer: "flex items-center space-x-4",
    socialLink: "text-white hover:text-gray-300",
    icon: "h-6 w-6",
    srOnly: "sr-only"
};
function selectSocialIcon(url) {
    if (url.includes("instagram")) return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f40$icons$2d$pack$2f$react$2d$simple$2d$icons$2f$icons$2f$SiInstagram$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__SiInstagram$3e$__["SiInstagram"], {
        className: styles.icon
    }, void 0, false, {
        fileName: "[project]/frontend/src/components/custom/footer.tsx",
        lineNumber: 19,
        columnNumber: 41
    }, this);
    return null;
}
function Footer({ data }) {
    if (!data) return null;
    const { logoText, socialLink, text } = data;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: styles.footer,
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: styles.container,
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$logo$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["Logo"], {
                    dark: true,
                    text: logoText.label
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/custom/footer.tsx",
                    lineNumber: 33,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                    className: styles.text,
                    children: text
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/custom/footer.tsx",
                    lineNumber: 34,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: styles.socialContainer,
                    children: socialLink.map((link)=>{
                        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"], {
                            className: styles.socialLink,
                            href: link.href,
                            children: [
                                selectSocialIcon(link.href),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                    className: styles.srOnly,
                                    children: [
                                        "Visit us at ",
                                        link.label
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/frontend/src/components/custom/footer.tsx",
                                    lineNumber: 44,
                                    columnNumber: 17
                                }, this)
                            ]
                        }, link.id, true, {
                            fileName: "[project]/frontend/src/components/custom/footer.tsx",
                            lineNumber: 38,
                            columnNumber: 15
                        }, this);
                    })
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/custom/footer.tsx",
                    lineNumber: 35,
                    columnNumber: 9
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/frontend/src/components/custom/footer.tsx",
            lineNumber: 32,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/frontend/src/components/custom/footer.tsx",
        lineNumber: 31,
        columnNumber: 5
    }, this);
}
}),
"[next]/internal/font/google/luxurious_script_75dfedb7.module.css [app-rsc] (css module)", ((__turbopack_context__) => {

__turbopack_context__.v({
  "className": "luxurious_script_75dfedb7-module__oOuAXa__className",
  "variable": "luxurious_script_75dfedb7-module__oOuAXa__variable",
});
}),
"[next]/internal/font/google/luxurious_script_75dfedb7.js [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>__TURBOPACK__default__export__
]);
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$luxurious_script_75dfedb7$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__ = __turbopack_context__.i("[next]/internal/font/google/luxurious_script_75dfedb7.module.css [app-rsc] (css module)");
;
const fontData = {
    className: __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$luxurious_script_75dfedb7$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].className,
    style: {
        fontFamily: "'Luxurious Script', 'Luxurious Script Fallback'",
        fontWeight: 400,
        fontStyle: "normal"
    }
};
if (__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$luxurious_script_75dfedb7$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable != null) {
    fontData.variable = __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$luxurious_script_75dfedb7$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable;
}
const __TURBOPACK__default__export__ = fontData;
}),
"[next]/internal/font/google/cormorant_garamond_f0154786.module.css [app-rsc] (css module)", ((__turbopack_context__) => {

__turbopack_context__.v({
  "className": "cormorant_garamond_f0154786-module__qWVebq__className",
  "variable": "cormorant_garamond_f0154786-module__qWVebq__variable",
});
}),
"[next]/internal/font/google/cormorant_garamond_f0154786.js [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>__TURBOPACK__default__export__
]);
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$cormorant_garamond_f0154786$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__ = __turbopack_context__.i("[next]/internal/font/google/cormorant_garamond_f0154786.module.css [app-rsc] (css module)");
;
const fontData = {
    className: __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$cormorant_garamond_f0154786$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].className,
    style: {
        fontFamily: "'Cormorant Garamond', 'Cormorant Garamond Fallback'",
        fontStyle: "normal"
    }
};
if (__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$cormorant_garamond_f0154786$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable != null) {
    fontData.variable = __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$cormorant_garamond_f0154786$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable;
}
const __TURBOPACK__default__export__ = fontData;
}),
"[next]/internal/font/google/playfair_display_f246dc54.module.css [app-rsc] (css module)", ((__turbopack_context__) => {

__turbopack_context__.v({
  "className": "playfair_display_f246dc54-module__-PPIOG__className",
  "variable": "playfair_display_f246dc54-module__-PPIOG__variable",
});
}),
"[next]/internal/font/google/playfair_display_f246dc54.js [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>__TURBOPACK__default__export__
]);
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$playfair_display_f246dc54$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__ = __turbopack_context__.i("[next]/internal/font/google/playfair_display_f246dc54.module.css [app-rsc] (css module)");
;
const fontData = {
    className: __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$playfair_display_f246dc54$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].className,
    style: {
        fontFamily: "'Playfair Display', 'Playfair Display Fallback'",
        fontStyle: "normal"
    }
};
if (__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$playfair_display_f246dc54$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable != null) {
    fontData.variable = __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$playfair_display_f246dc54$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable;
}
const __TURBOPACK__default__export__ = fontData;
}),
"[next]/internal/font/google/poppins_402b5cd.module.css [app-rsc] (css module)", ((__turbopack_context__) => {

__turbopack_context__.v({
  "className": "poppins_402b5cd-module__yrpiSG__className",
  "variable": "poppins_402b5cd-module__yrpiSG__variable",
});
}),
"[next]/internal/font/google/poppins_402b5cd.js [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>__TURBOPACK__default__export__
]);
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$poppins_402b5cd$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__ = __turbopack_context__.i("[next]/internal/font/google/poppins_402b5cd.module.css [app-rsc] (css module)");
;
const fontData = {
    className: __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$poppins_402b5cd$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].className,
    style: {
        fontFamily: "'Poppins', 'Poppins Fallback'",
        fontStyle: "normal"
    }
};
if (__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$poppins_402b5cd$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable != null) {
    fontData.variable = __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$poppins_402b5cd$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable;
}
const __TURBOPACK__default__export__ = fontData;
}),
"[next]/internal/font/google/montserrat_ae4835d8.module.css [app-rsc] (css module)", ((__turbopack_context__) => {

__turbopack_context__.v({
  "className": "montserrat_ae4835d8-module__LXpBCa__className",
  "variable": "montserrat_ae4835d8-module__LXpBCa__variable",
});
}),
"[next]/internal/font/google/montserrat_ae4835d8.js [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>__TURBOPACK__default__export__
]);
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$montserrat_ae4835d8$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__ = __turbopack_context__.i("[next]/internal/font/google/montserrat_ae4835d8.module.css [app-rsc] (css module)");
;
const fontData = {
    className: __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$montserrat_ae4835d8$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].className,
    style: {
        fontFamily: "'Montserrat', 'Montserrat Fallback'",
        fontStyle: "normal"
    }
};
if (__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$montserrat_ae4835d8$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable != null) {
    fontData.variable = __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$montserrat_ae4835d8$2e$module$2e$css__$5b$app$2d$rsc$5d$__$28$css__module$29$__["default"].variable;
}
const __TURBOPACK__default__export__ = fontData;
}),
"[project]/frontend/src/app/layout.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>RootLayout,
    "generateMetadata",
    ()=>generateMetadata
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$data$2f$loaders$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/data/loaders.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$error$2d$handler$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/lib/error-handler.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$header$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/custom/header.tsx [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$footer$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/custom/footer.tsx [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$luxurious_script_75dfedb7$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[next]/internal/font/google/luxurious_script_75dfedb7.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$cormorant_garamond_f0154786$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[next]/internal/font/google/cormorant_garamond_f0154786.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$playfair_display_f246dc54$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[next]/internal/font/google/playfair_display_f246dc54.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$poppins_402b5cd$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[next]/internal/font/google/poppins_402b5cd.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$montserrat_ae4835d8$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[next]/internal/font/google/montserrat_ae4835d8.js [app-rsc] (ecmascript)");
;
;
;
;
;
;
;
;
;
;
;
async function generateMetadata() {
    const metadata = await __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$data$2f$loaders$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["loaders"].getMetaData();
    return {
        title: metadata?.data?.title ?? "Lash Her by Nataliea",
        description: metadata?.data?.description ?? "Elevating beauty through bespoke lash artistry and professional education."
    };
}
async function RootLayout({ children }) {
    const globalDataResponse = await __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$data$2f$loaders$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["loaders"].getGlobalData();
    const globalData = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$error$2d$handler$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["validateApiResponse"])(globalDataResponse, "global page");
    console.dir(globalData, {
        depth: null
    });
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("html", {
        lang: "en",
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("body", {
            className: `${__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$montserrat_ae4835d8$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].variable} ${__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$cormorant_garamond_f0154786$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].variable} ${__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$luxurious_script_75dfedb7$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].variable} ${__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$poppins_402b5cd$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].variable} ${__TURBOPACK__imported__module__$5b$next$5d2f$internal$2f$font$2f$google$2f$playfair_display_f246dc54$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"].variable} antialiased`,
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$header$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["Header"], {
                    data: globalData?.header
                }, void 0, false, {
                    fileName: "[project]/frontend/src/app/layout.tsx",
                    lineNumber: 65,
                    columnNumber: 9
                }, this),
                children,
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$footer$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["Footer"], {
                    data: globalData?.footer
                }, void 0, false, {
                    fileName: "[project]/frontend/src/app/layout.tsx",
                    lineNumber: 68,
                    columnNumber: 9
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/frontend/src/app/layout.tsx",
            lineNumber: 62,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/frontend/src/app/layout.tsx",
        lineNumber: 61,
        columnNumber: 5
    }, this);
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__6b43308c._.js.map
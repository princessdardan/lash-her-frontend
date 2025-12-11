module.exports = [
"[externals]/next/dist/compiled/next-server/app-page-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-page-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[project]/frontend/src/lib/utils.ts [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "cn",
    ()=>cn,
    "getStrapiURL",
    ()=>getStrapiURL
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$clsx$2f$dist$2f$clsx$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/clsx/dist/clsx.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$tailwind$2d$merge$2f$dist$2f$bundle$2d$mjs$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/tailwind-merge/dist/bundle-mjs.mjs [app-ssr] (ecmascript)");
;
;
function cn(...inputs) {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$tailwind$2d$merge$2f$dist$2f$bundle$2d$mjs$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["twMerge"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$clsx$2f$dist$2f$clsx$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["clsx"])(inputs));
}
function getStrapiURL() {
    return ("TURBOPACK compile-time value", "http://localhost:1337") || "http://localhost:1337";
}
}),
"[project]/frontend/src/components/custom/layouts/header-wrapper.tsx [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "HeaderWrapper",
    ()=>HeaderWrapper,
    "useHeaderContext",
    ()=>useHeaderContext
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react-jsx-dev-runtime.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/lib/utils.ts [app-ssr] (ecmascript)");
"use client";
;
;
;
const HeaderContext = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["createContext"])({
    isActive: false
});
const useHeaderContext = ()=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useContext"])(HeaderContext);
function HeaderWrapper({ children }) {
    const [isScrolled, setIsScrolled] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"])(false);
    const [isHovered, setIsHovered] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"])(false);
    const isActive = isScrolled || isHovered;
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useEffect"])(()=>{
        const handleScroll = ()=>{
            setIsScrolled(window.scrollY > 50);
        };
        window.addEventListener("scroll", handleScroll);
        return ()=>window.removeEventListener("scroll", handleScroll);
    }, []);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(HeaderContext.Provider, {
        value: {
            isActive
        },
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["cn"])("sticky top-0 z-50 flex flex-col items-center px-4 py-4 shadow-md transition-colors duration-300", isActive ? "bg-brand-pink" : "bg-black"),
            onMouseEnter: ()=>setIsHovered(true),
            onMouseLeave: ()=>setIsHovered(false),
            children: children
        }, void 0, false, {
            fileName: "[project]/frontend/src/components/custom/layouts/header-wrapper.tsx",
            lineNumber: 30,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/frontend/src/components/custom/layouts/header-wrapper.tsx",
        lineNumber: 29,
        columnNumber: 5
    }, this);
}
}),
"[project]/frontend/src/components/ui/logo.tsx [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Logo",
    ()=>Logo
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react-jsx-dev-runtime.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/client/app-dir/link.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$layouts$2f$header$2d$wrapper$2e$tsx__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/custom/layouts/header-wrapper.tsx [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/lib/utils.ts [app-ssr] (ecmascript)");
"use client";
;
;
;
;
const styles = {
    link: "flex items-center gap-2",
    icon: "h-18 w-auto transition-colors duration-300",
    text: {
        base: "text-lg font-medium",
        light: "text-slate-900",
        dark: "text-white"
    }
};
function LashHerLogo(props) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
        ...props,
        xmlns: "http://www.w3.org/2000/svg",
        viewBox: "0 0 700 300",
        preserveAspectRatio: "xMidYMid meet",
        fill: "currentColor",
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
            transform: "translate(0,300) scale(0.1,-0.1)",
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M4402 2851 c-78 -37 -148 -73 -155 -80 -16 -17 11 -36 62 -45 21 -3 50 -15 65 -27 l26 -21 -2 -720 -3 -720 -32 -28 c-18 -16 -49 -32 -70 -36 -42 -7 -66 -22 -57 -35 8 -14 491 -12 500 2 9 15 -10 25 -57 33 -22 4 -53 19 -71 35 l-33 29 -3 289 c-2 158 0 303 3 322 9 47 85 124 158 161 77 38 152 41 217 8 94 -49 102 -88 98 -483 l-3 -297 -32 -28 c-18 -16 -49 -32 -70 -36 -42 -7 -66 -22 -57 -35 8 -14 491 -12 500 2 9 15 -10 25 -57 33 -22 4 -53 19 -71 35 l-33 29 -6 324 c-4 217 -10 336 -19 363 -40 128 -102 183 -234 206 -125 21 -203 -6 -310 -111 -40 -38 -76 -70 -79 -70 -4 0 -8 217 -9 482 -2 310 -7 482 -13 484 -5 1 -74 -28 -153 -65z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 27,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M2850 2837 c-89 -44 -145 -78 -145 -87 0 -9 22 -20 64 -31 36 -10 71 -25 78 -35 10 -14 13 -161 13 -730 l0 -712 -25 -30 c-17 -20 -41 -34 -75 -42 -53 -13 -83 -36 -58 -45 7 -3 121 -4 253 -3 201 3 240 5 240 17 0 9 -19 19 -48 27 -67 17 -94 38 -107 81 -8 25 -10 135 -8 324 l3 286 25 37 c14 20 55 58 92 83 64 44 72 47 145 50 98 5 155 -20 187 -82 20 -38 21 -60 24 -371 l3 -331 -25 -31 c-18 -20 -42 -34 -76 -42 -53 -13 -83 -36 -58 -45 7 -3 121 -4 253 -3 201 3 240 5 240 17 0 9 -18 19 -45 26 -119 31 -120 33 -120 387 0 219 -4 298 -16 348 -31 132 -96 197 -220 220 -136 26 -216 -1 -330 -111 -39 -38 -74 -69 -77 -69 -4 0 -7 218 -7 485 0 456 -1 485 -17 484 -10 0 -83 -33 -163 -72z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 30,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M44 2645 c-10 -24 5 -35 50 -35 64 0 131 -27 166 -66 l30 -35 0 -599 c0 -400 -4 -608 -11 -627 -25 -67 -85 -103 -189 -112 -56 -5 -65 -9 -65 -26 0 -20 7 -20 550 -22 303 -2 555 1 561 5 14 8 184 334 184 350 0 31 -35 5 -90 -68 -72 -95 -112 -134 -162 -161 -34 -17 -59 -19 -286 -19 -228 0 -250 2 -265 18 -15 17 -17 77 -17 658 0 351 4 644 8 651 16 26 89 46 185 51 94 5 97 5 97 28 l0 24 -370 0 c-315 0 -371 -2 -376 -15z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 33,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M5734 2126 c-193 -49 -335 -240 -359 -483 -25 -254 139 -505 353 -539 61 -10 169 13 250 53 74 36 212 153 212 178 0 28 -20 25 -67 -11 -105 -81 -242 -115 -340 -84 -150 47 -260 216 -251 390 l3 65 319 3 c231 2 323 6 334 14 41 34 -23 212 -114 316 -82 94 -211 131 -340 98z m135 -81 c50 -25 120 -113 136 -170 26 -88 35 -85 -221 -85 l-224 0 0 28 c0 67 84 190 155 226 38 20 117 20 154 1z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 36,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M6430 2080 c-165 -78 -180 -86 -180 -104 0 -9 12 -18 28 -22 58 -12 113 -36 122 -54 6 -11 10 -141 10 -322 0 -374 -1 -377 -127 -408 -26 -7 -43 -16 -43 -25 0 -13 41 -15 280 -15 241 0 280 2 280 15 0 8 -10 17 -22 20 -13 3 -45 10 -72 15 -60 13 -86 26 -108 54 -16 19 -18 51 -18 306 0 312 -1 304 64 373 57 61 114 64 229 15 l50 -22 28 32 c15 17 31 48 35 68 9 48 -8 63 -105 94 -105 34 -145 16 -236 -104 -27 -37 -53 -66 -57 -66 -5 0 -8 40 -8 89 0 87 -5 121 -19 121 -3 0 -62 -27 -131 -60z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 39,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M1545 2116 c-84 -26 -154 -78 -197 -145 -48 -77 -60 -161 -22 -161 7 0 45 14 84 31 l70 32 0 44 c0 51 21 97 51 114 68 36 133 29 190 -18 51 -43 59 -76 59 -233 l0 -140 -57 -28 c-32 -16 -116 -48 -188 -71 -151 -49 -201 -79 -232 -141 -86 -169 107 -361 283 -281 23 10 75 44 116 74 l76 56 17 -45 c9 -25 28 -58 42 -74 42 -51 109 -37 226 47 27 19 51 33 53 31 2 -3 7 -29 12 -59 7 -46 11 -54 27 -51 11 2 27 10 36 18 15 13 24 13 74 -2 76 -21 224 -16 275 10 108 57 160 137 160 245 0 131 -57 204 -249 323 -64 40 -135 92 -158 115 -37 37 -43 48 -43 85 0 54 32 119 69 141 35 21 100 22 144 3 42 -18 78 -57 119 -130 18 -32 38 -58 43 -57 6 0 10 46 10 113 l0 113 -45 25 c-40 22 -57 25 -145 25 -84 0 -108 -4 -146 -23 -154 -76 -220 -224 -159 -355 27 -58 106 -131 207 -192 109 -66 149 -100 179 -151 22 -38 26 -54 22 -100 -5 -61 -26 -96 -78 -131 -37 -26 -70 -28 -135 -12 -63 16 -120 69 -161 151 -20 39 -40 68 -47 65 -7 -2 -12 -24 -12 -56 0 -48 -3 -54 -29 -68 -34 -18 -90 -12 -117 13 -18 16 -19 37 -19 339 l0 323 -28 53 c-62 119 -233 180 -377 135z m235 -674 l0 -128 -32 -31 c-72 -69 -188 -94 -242 -52 -62 49 -75 138 -28 189 22 25 268 150 295 150 4 0 7 -58 7 -128z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 42,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M2920 796 c-74 -17 -100 -29 -139 -62 -38 -32 -62 -81 -55 -110 4 -16 -5 -24 -48 -42 -117 -48 -192 -167 -153 -241 19 -37 47 -45 125 -38 105 9 178 54 320 197 131 131 211 204 245 222 13 8 9 -1 -12 -26 -47 -52 -70 -103 -99 -214 -14 -53 -34 -110 -45 -125 -11 -15 -19 -33 -16 -40 2 -7 10 -1 17 13 51 96 294 338 390 388 73 37 141 43 174 15 20 -18 20 -18 4 7 -14 22 -23 25 -75 25 -49 0 -68 -6 -117 -35 -58 -34 -232 -196 -296 -275 -18 -22 -29 -31 -25 -20 4 11 23 60 42 110 56 148 98 206 141 191 13 -5 13 -3 -2 9 -11 8 -24 11 -30 6 -6 -4 -23 -11 -38 -15 -35 -8 -116 -73 -238 -191 -52 -50 -120 -110 -150 -134 -150 -119 -310 -137 -310 -34 0 72 53 139 148 187 95 48 176 43 188 -13 10 -44 12 -47 13 -15 1 42 -28 66 -89 72 -41 4 -50 8 -50 24 0 88 138 158 310 157 69 0 102 -4 185 -23 25 -6 27 -5 12 4 -25 16 -160 39 -222 39 -27 0 -75 -6 -105 -13z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 45,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M1193 785 c-123 -33 -219 -109 -271 -211 -30 -60 -52 -142 -52 -194 0 -26 -4 -29 -37 -32 -20 -2 -38 -9 -41 -16 -3 -10 7 -12 39 -10 41 3 45 1 64 -32 39 -66 118 -99 199 -80 21 4 44 14 50 21 8 9 7 10 -9 4 -35 -15 -125 -17 -156 -5 -32 14 -79 64 -79 84 0 10 15 10 73 -1 79 -16 197 -12 260 8 100 33 153 128 108 190 -13 17 -21 32 -19 33 1 1 24 10 50 20 65 24 101 68 95 115 -3 20 -8 45 -12 57 -5 17 1 23 34 39 23 10 39 20 37 23 -3 2 -24 -5 -46 -16 -41 -20 -42 -20 -83 -1 -50 22 -130 24 -204 4z m171 -4 c55 -13 66 -27 36 -48 -14 -9 -95 -87 -181 -173 -159 -160 -221 -205 -294 -212 l-30 -3 1 70 c0 88 32 153 119 241 105 106 232 152 349 125z m82 -106 c-16 -62 -108 -130 -158 -117 -15 4 -13 10 15 46 17 22 54 63 81 91 47 48 49 49 58 28 6 -12 8 -33 4 -48z m-128 -154 c19 -24 8 -87 -22 -125 -40 -53 -107 -80 -196 -80 -41 0 -97 3 -124 8 l-49 8 66 22 c80 27 160 80 219 145 35 39 48 47 68 43 14 -3 31 -12 38 -21z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 48,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M5081 698 c-53 -26 -292 -255 -314 -300 -17 -36 -13 -58 12 -58 21 0 100 51 127 81 10 12 -10 1 -45 -24 -68 -50 -81 -55 -81 -32 0 27 250 276 340 337 35 24 13 22 -39 -4z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 51,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M4159 637 c-121 -74 -269 -240 -252 -283 6 -17 37 -18 66 -2 32 16 108 80 103 85 -2 3 -30 -16 -61 -41 -104 -85 -117 -50 -19 54 57 60 72 70 103 71 31 2 32 3 8 6 -16 3 -27 8 -25 12 5 13 82 78 118 100 27 16 30 21 15 21 -11 0 -36 -10 -56 -23z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 54,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M5335 621 c-8 -15 3 -31 21 -31 9 0 14 7 12 17 -4 20 -24 28 -33 14z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 57,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M3574 530 c-49 -25 -133 -106 -140 -137 -8 -29 1 -53 19 -53 8 0 31 11 51 25 34 23 36 24 36 4 0 -47 54 -30 130 41 43 40 28 32 -54 -30 -21 -17 -43 -30 -48 -30 -21 0 -2 27 78 110 79 82 99 114 48 75 -25 -19 -35 -19 -28 0 9 22 -42 19 -92 -5z m77 -7 c-5 -10 -40 -48 -78 -84 -101 -98 -153 -119 -99 -40 52 75 211 186 177 124z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 60,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M4415 521 c-89 -51 -156 -144 -126 -174 9 -9 23 -6 60 14 47 27 47 27 47 5 -2 -38 37 -31 102 21 34 26 61 52 62 56 0 5 -21 -9 -47 -31 -119 -98 -127 -67 -13 50 79 82 94 106 45 74 -22 -14 -25 -15 -25 -1 0 24 -50 18 -105 -14z m95 8 c0 -15 -119 -133 -161 -158 -63 -39 -66 -23 -7 44 76 86 168 149 168 114z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 63,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M5243 511 c-112 -88 -159 -187 -80 -167 28 7 137 85 137 98 0 5 -21 -9 -47 -30 -135 -112 -135 -61 -1 71 75 73 70 91 -9 28z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 66,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M5624 521 c-82 -48 -137 -123 -120 -166 6 -18 48 -20 79 -4 36 19 117 82 117 92 0 5 -18 -7 -41 -27 -77 -66 -155 -86 -128 -34 19 37 61 78 81 78 28 0 96 37 107 59 22 41 -25 42 -95 2z m86 14 c0 -9 -46 -47 -69 -56 -40 -16 -35 -2 10 30 39 29 59 38 59 26z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 69,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M6044 530 c-49 -25 -133 -106 -140 -137 -8 -29 1 -53 19 -53 8 0 31 11 51 25 34 23 36 24 36 4 0 -47 54 -30 130 41 43 40 28 32 -54 -30 -21 -17 -43 -30 -48 -30 -21 0 -2 27 78 110 79 82 99 114 48 75 -25 -19 -35 -19 -28 0 9 22 -42 19 -92 -5z m77 -7 c-5 -10 -40 -48 -78 -84 -101 -98 -153 -119 -99 -40 52 75 211 186 177 124z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 72,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M1754 514 c-57 -38 -111 -93 -129 -131 -28 -58 4 -71 68 -27 21 14 36 28 33 31 -3 4 -14 -1 -23 -9 -10 -9 -28 -21 -40 -27 -45 -23 -23 11 64 100 88 91 96 109 27 63z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 75,
                    columnNumber: 7
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M1843 501 c-61 -49 -119 -110 -113 -119 10 -12 -185 -173 -245 -203 -102 -50 -206 -40 -245 23 -14 23 -20 27 -20 15 0 -27 42 -64 90 -78 33 -10 54 -10 103 0 118 24 229 99 352 237 39 44 87 98 109 121 48 54 33 55 -31 4z"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/ui/logo.tsx",
                    lineNumber: 78,
                    columnNumber: 7
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/frontend/src/components/ui/logo.tsx",
            lineNumber: 26,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/frontend/src/components/ui/logo.tsx",
        lineNumber: 19,
        columnNumber: 5
    }, this);
}
function Logo({ data }) {
    const { isActive } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$layouts$2f$header$2d$wrapper$2e$tsx__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useHeaderContext"])();
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["default"], {
        className: styles.link,
        href: "/",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(LashHerLogo, {
                className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["cn"])(styles.icon, isActive ? "text-brand-red" : "text-white")
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/ui/logo.tsx",
                lineNumber: 96,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: `${styles.text.base} ${data?.dark ? styles.text.dark : styles.text.light}`
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/ui/logo.tsx",
                lineNumber: 97,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/frontend/src/components/ui/logo.tsx",
        lineNumber: 95,
        columnNumber: 5
    }, this);
}
}),
"[externals]/next/dist/server/app-render/action-async-storage.external.js [external] (next/dist/server/app-render/action-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/action-async-storage.external.js", () => require("next/dist/server/app-render/action-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-unit-async-storage.external.js [external] (next/dist/server/app-render/work-unit-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-unit-async-storage.external.js", () => require("next/dist/server/app-render/work-unit-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-async-storage.external.js [external] (next/dist/server/app-render/work-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-async-storage.external.js", () => require("next/dist/server/app-render/work-async-storage.external.js"));

module.exports = mod;
}),
"[project]/frontend/src/components/ui/navigation.tsx [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Navigation",
    ()=>Navigation
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react-jsx-dev-runtime.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/client/app-dir/link.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/navigation.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/lib/utils.ts [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$layouts$2f$header$2d$wrapper$2e$tsx__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/custom/layouts/header-wrapper.tsx [app-ssr] (ecmascript)");
"use client";
;
;
;
;
;
const navLinks = [
    {
        href: "/",
        label: "Home"
    },
    {
        href: "/training",
        label: "Training"
    },
    {
        href: "/gallery",
        label: "Gallery"
    },
    {
        href: "/contact",
        label: "Contact"
    }
];
function Navigation() {
    const pathname = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["usePathname"])();
    const { isActive: isHeaderActive } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$layouts$2f$header$2d$wrapper$2e$tsx__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useHeaderContext"])();
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("nav", {
        className: "flex items-center gap-6",
        children: navLinks.map((link)=>{
            const isActive = pathname === link.href;
            return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["default"], {
                href: link.href,
                className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["cn"])("text-md font-light transition-colors", isActive ? "font-semibold" : "", isHeaderActive ? "text-brand-red hover:text-brand-red/70" : "text-brand-pink hover:text-brand-red"),
                children: link.label
            }, link.href, false, {
                fileName: "[project]/frontend/src/components/ui/navigation.tsx",
                lineNumber: 29,
                columnNumber: 11
            }, this);
        })
    }, void 0, false, {
        fileName: "[project]/frontend/src/components/ui/navigation.tsx",
        lineNumber: 25,
        columnNumber: 5
    }, this);
}
}),
"[project]/frontend/src/components/ui/button.tsx [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Button",
    ()=>Button,
    "buttonVariants",
    ()=>buttonVariants
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react-jsx-dev-runtime.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$slot$2f$dist$2f$index$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@radix-ui/react-slot/dist/index.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$class$2d$variance$2d$authority$2f$dist$2f$index$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/class-variance-authority/dist/index.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/lib/utils.ts [app-ssr] (ecmascript)");
;
;
;
;
const buttonVariants = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$class$2d$variance$2d$authority$2f$dist$2f$index$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["cva"])("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive", {
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
    const Comp = asChild ? __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$radix$2d$ui$2f$react$2d$slot$2f$dist$2f$index$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["Slot"] : "button";
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(Comp, {
        "data-slot": "button",
        className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["cn"])(buttonVariants({
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
"[project]/frontend/src/components/custom/layouts/header.tsx [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Header",
    ()=>Header
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react-jsx-dev-runtime.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/client/app-dir/link.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$ui$2f$logo$2e$tsx__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/ui/logo.tsx [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$ui$2f$navigation$2e$tsx__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/ui/navigation.tsx [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$ui$2f$button$2e$tsx__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/ui/button.tsx [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$layouts$2f$header$2d$wrapper$2e$tsx__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/custom/layouts/header-wrapper.tsx [app-ssr] (ecmascript)");
"use client";
;
;
;
;
;
;
function HeaderButton({ href, label }) {
    const { isActive } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$layouts$2f$header$2d$wrapper$2e$tsx__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useHeaderContext"])();
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["default"], {
        href: href,
        className: "absolute top-1/2 -translate-y-1/2 right-4",
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$ui$2f$button$2e$tsx__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["Button"], {
            className: `font-sans font-light text-2xl text-md italic px-4 py-3 transition-colors duration-300 ${isActive ? "bg-brand-red text-white hover:bg-brand-red/90" : "bg-brand-pink text-brand-red hover:bg-brand-red/90"}`,
            children: label
        }, void 0, false, {
            fileName: "[project]/frontend/src/components/custom/layouts/header.tsx",
            lineNumber: 21,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/frontend/src/components/custom/layouts/header.tsx",
        lineNumber: 20,
        columnNumber: 5
    }, this);
}
function Header({ data }) {
    if (!data) return null;
    const { logoText, ctaButton } = data;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$custom$2f$layouts$2f$header$2d$wrapper$2e$tsx__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["HeaderWrapper"], {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(HeaderButton, {
                href: ctaButton.href,
                label: ctaButton.label
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/layouts/header.tsx",
                lineNumber: 38,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$ui$2f$logo$2e$tsx__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["Logo"], {
                data: logoText
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/layouts/header.tsx",
                lineNumber: 39,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "flex items-center gap-4 mt-4",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$ui$2f$navigation$2e$tsx__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["Navigation"], {}, void 0, false, {
                    fileName: "[project]/frontend/src/components/custom/layouts/header.tsx",
                    lineNumber: 41,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/layouts/header.tsx",
                lineNumber: 40,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/frontend/src/components/custom/layouts/header.tsx",
        lineNumber: 37,
        columnNumber: 5
    }, this);
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__0ae1cdce._.js.map
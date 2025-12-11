(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/frontend/src/app/page.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>LandingPage
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$compiler$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/compiled/react/compiler-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$render$2f$components$2f$motion$2f$proxy$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/framer-motion/dist/es/render/components/motion/proxy.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$components$2f$AnimatePresence$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/framer-motion/dist/es/components/AnimatePresence/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/node_modules/next/navigation.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$ui$2f$button$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/ui/button.tsx [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
"use client";
;
;
;
;
;
const images = [
    "/path/to/image1.jpg",
    "/path/to/image2.jpg",
    "/path/to/image3.jpg",
    "/path/to/image4.jpg"
];
function LandingPage() {
    _s();
    const $ = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$compiler$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["c"])(38);
    if ($[0] !== "a66e46a1ed1901ac0e5a92bf38a3cd8f9ba5c24c01021f4ad1959ecca8f3930e") {
        for(let $i = 0; $i < 38; $i += 1){
            $[$i] = Symbol.for("react.memo_cache_sentinel");
        }
        $[0] = "a66e46a1ed1901ac0e5a92bf38a3cd8f9ba5c24c01021f4ad1959ecca8f3930e";
    }
    const [currentIndex, setCurrentIndex] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(0);
    const router = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRouter"])();
    let t0;
    let t1;
    if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
        t0 = ({
            "LandingPage[useEffect()]": ()=>{
                const interval = setInterval({
                    "LandingPage[useEffect() > setInterval()]": ()=>{
                        setCurrentIndex(_LandingPageUseEffectSetIntervalSetCurrentIndex);
                    }
                }["LandingPage[useEffect() > setInterval()]"], 3000);
                return ()=>clearInterval(interval);
            }
        })["LandingPage[useEffect()]"];
        t1 = [];
        $[1] = t0;
        $[2] = t1;
    } else {
        t0 = $[1];
        t1 = $[2];
    }
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])(t0, t1);
    let t2;
    if ($[3] !== router) {
        t2 = ({
            "LandingPage[handleEnter]": ()=>{
                router.push("/homepage");
            }
        })["LandingPage[handleEnter]"];
        $[3] = router;
        $[4] = t2;
    } else {
        t2 = $[4];
    }
    const handleEnter = t2;
    let t3;
    let t4;
    let t5;
    let t6;
    if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
        t3 = {
            opacity: 0,
            scale: 1.1
        };
        t4 = {
            opacity: 0.7,
            scale: 1
        };
        t5 = {
            opacity: 0,
            scale: 0.95
        };
        t6 = {
            duration: 1,
            ease: "easeInOut"
        };
        $[5] = t3;
        $[6] = t4;
        $[7] = t5;
        $[8] = t6;
    } else {
        t3 = $[5];
        t4 = $[6];
        t5 = $[7];
        t6 = $[8];
    }
    const t7 = images[currentIndex];
    const t8 = `Slide ${currentIndex + 1}`;
    let t9;
    if ($[9] !== t7 || $[10] !== t8) {
        t9 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("img", {
            src: t7,
            alt: t8,
            className: "h-full w-full object-cover"
        }, void 0, false, {
            fileName: "[project]/frontend/src/app/page.tsx",
            lineNumber: 88,
            columnNumber: 10
        }, this);
        $[9] = t7;
        $[10] = t8;
        $[11] = t9;
    } else {
        t9 = $[11];
    }
    let t10;
    if ($[12] !== currentIndex || $[13] !== t9) {
        t10 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$components$2f$AnimatePresence$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["AnimatePresence"], {
            mode: "wait",
            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$render$2f$components$2f$motion$2f$proxy$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["motion"].div, {
                initial: t3,
                animate: t4,
                exit: t5,
                transition: t6,
                className: "absolute inset-0",
                children: t9
            }, currentIndex, false, {
                fileName: "[project]/frontend/src/app/page.tsx",
                lineNumber: 97,
                columnNumber: 40
            }, this)
        }, void 0, false, {
            fileName: "[project]/frontend/src/app/page.tsx",
            lineNumber: 97,
            columnNumber: 11
        }, this);
        $[12] = currentIndex;
        $[13] = t9;
        $[14] = t10;
    } else {
        t10 = $[14];
    }
    let t11;
    let t12;
    let t13;
    if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
        t11 = {
            opacity: 0,
            y: -30
        };
        t12 = {
            opacity: 1,
            y: 0
        };
        t13 = {
            duration: 1,
            delay: 0.5
        };
        $[15] = t11;
        $[16] = t12;
        $[17] = t13;
    } else {
        t11 = $[15];
        t12 = $[16];
        t13 = $[17];
    }
    let t14;
    if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
        t14 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$render$2f$components$2f$motion$2f$proxy$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["motion"].div, {
            initial: t11,
            animate: t12,
            transition: t13,
            className: "text-center",
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("h1", {
                    className: "text-5xl font-bold text-white md:text-7xl",
                    children: "Lash Her"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/app/page.tsx",
                    lineNumber: 130,
                    columnNumber: 92
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                    className: "mt-4 text-xl text-white/90 md:text-2xl",
                    children: "Elevate Your Beauty"
                }, void 0, false, {
                    fileName: "[project]/frontend/src/app/page.tsx",
                    lineNumber: 130,
                    columnNumber: 163
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/frontend/src/app/page.tsx",
            lineNumber: 130,
            columnNumber: 11
        }, this);
        $[18] = t14;
    } else {
        t14 = $[18];
    }
    let t15;
    let t16;
    let t17;
    if ($[19] === Symbol.for("react.memo_cache_sentinel")) {
        t15 = {
            opacity: 0,
            y: 30
        };
        t16 = {
            opacity: 1,
            y: 0
        };
        t17 = {
            duration: 1,
            delay: 1
        };
        $[19] = t15;
        $[20] = t16;
        $[21] = t17;
    } else {
        t15 = $[19];
        t16 = $[20];
        t17 = $[21];
    }
    let t18;
    if ($[22] === Symbol.for("react.memo_cache_sentinel")) {
        t18 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$render$2f$components$2f$motion$2f$proxy$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["motion"].span, {
            className: "relative z-10",
            whileHover: {
                scale: 1.05
            },
            transition: {
                duration: 0.2
            },
            children: "Enter Site"
        }, void 0, false, {
            fileName: "[project]/frontend/src/app/page.tsx",
            lineNumber: 161,
            columnNumber: 11
        }, this);
        $[22] = t18;
    } else {
        t18 = $[22];
    }
    let t19;
    if ($[23] !== handleEnter) {
        t19 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$render$2f$components$2f$motion$2f$proxy$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["motion"].div, {
            initial: t15,
            animate: t16,
            transition: t17,
            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$ui$2f$button$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Button"], {
                onClick: handleEnter,
                size: "lg",
                className: "group relative overflow-hidden bg-white px-12 py-6 text-lg font-semibold text-black transition-all hover:scale-105",
                children: t18
            }, void 0, false, {
                fileName: "[project]/frontend/src/app/page.tsx",
                lineNumber: 172,
                columnNumber: 68
            }, this)
        }, void 0, false, {
            fileName: "[project]/frontend/src/app/page.tsx",
            lineNumber: 172,
            columnNumber: 11
        }, this);
        $[23] = handleEnter;
        $[24] = t19;
    } else {
        t19 = $[24];
    }
    let t20;
    let t21;
    let t22;
    if ($[25] === Symbol.for("react.memo_cache_sentinel")) {
        t20 = {
            opacity: 0
        };
        t21 = {
            opacity: 1
        };
        t22 = {
            duration: 1,
            delay: 1.5
        };
        $[25] = t20;
        $[26] = t21;
        $[27] = t22;
    } else {
        t20 = $[25];
        t21 = $[26];
        t22 = $[27];
    }
    let t23;
    if ($[28] !== currentIndex) {
        t23 = images.map({
            "LandingPage[images.map()]": (_, index)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                    onClick: {
                        "LandingPage[images.map() > <button>.onClick]": ()=>setCurrentIndex(index)
                    }["LandingPage[images.map() > <button>.onClick]"],
                    className: `h-2 w-2 rounded-full transition-all ${index === currentIndex ? "w-8 bg-white" : "bg-white/50 hover:bg-white/75"}`,
                    "aria-label": `Go to slide ${index + 1}`
                }, index, false, {
                    fileName: "[project]/frontend/src/app/page.tsx",
                    lineNumber: 203,
                    columnNumber: 50
                }, this)
        }["LandingPage[images.map()]"]);
        $[28] = currentIndex;
        $[29] = t23;
    } else {
        t23 = $[29];
    }
    let t24;
    if ($[30] !== t23) {
        t24 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$render$2f$components$2f$motion$2f$proxy$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["motion"].div, {
            initial: t20,
            animate: t21,
            transition: t22,
            className: "flex gap-2",
            children: t23
        }, void 0, false, {
            fileName: "[project]/frontend/src/app/page.tsx",
            lineNumber: 214,
            columnNumber: 11
        }, this);
        $[30] = t23;
        $[31] = t24;
    } else {
        t24 = $[31];
    }
    let t25;
    if ($[32] !== t19 || $[33] !== t24) {
        t25 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "relative z-10 flex h-full flex-col items-center justify-center gap-8 px-4",
            children: [
                t14,
                t19,
                t24
            ]
        }, void 0, true, {
            fileName: "[project]/frontend/src/app/page.tsx",
            lineNumber: 222,
            columnNumber: 11
        }, this);
        $[32] = t19;
        $[33] = t24;
        $[34] = t25;
    } else {
        t25 = $[34];
    }
    let t26;
    if ($[35] !== t10 || $[36] !== t25) {
        t26 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "relative h-screen w-full overflow-hidden bg-black",
            children: [
                t10,
                t25
            ]
        }, void 0, true, {
            fileName: "[project]/frontend/src/app/page.tsx",
            lineNumber: 231,
            columnNumber: 11
        }, this);
        $[35] = t10;
        $[36] = t25;
        $[37] = t26;
    } else {
        t26 = $[37];
    }
    return t26;
}
_s(LandingPage, "C1SIDquYeE4rJy24CPrwe3ZLCeI=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRouter"]
    ];
});
_c = LandingPage;
function _LandingPageUseEffectSetIntervalSetCurrentIndex(prev) {
    return (prev + 1) % images.length;
}
var _c;
__turbopack_context__.k.register(_c, "LandingPage");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# sourceMappingURL=frontend_src_app_page_tsx_8f61a0e4._.js.map
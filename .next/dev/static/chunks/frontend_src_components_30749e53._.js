(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/frontend/src/components/ui/strapi-image.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "StrapiImage",
    ()=>StrapiImage,
    "getStrapiMedia",
    ()=>getStrapiMedia
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$compiler$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/compiler-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$image$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/image.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/lib/utils.ts [app-client] (ecmascript)");
;
;
;
;
function getStrapiMedia(url) {
    const strapiURL = (0, __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$lib$2f$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getStrapiURL"])();
    if (url == null) return null;
    if (url.startsWith("data:")) return url;
    if (url.startsWith("http") || url.startsWith("//")) return url;
    return `${strapiURL}${url}`;
}
function StrapiImage(t0) {
    const $ = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$compiler$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["c"])(13);
    if ($[0] !== "2035362121f0a75ba63e7755b60cea5a393e05b517b54db02378444aca6f3203") {
        for(let $i = 0; $i < 13; $i += 1){
            $[$i] = Symbol.for("react.memo_cache_sentinel");
        }
        $[0] = "2035362121f0a75ba63e7755b60cea5a393e05b517b54db02378444aca6f3203";
    }
    let alt;
    let className;
    let rest;
    let src;
    if ($[1] !== t0) {
        ({ src, alt, className, ...rest } = t0);
        $[1] = t0;
        $[2] = alt;
        $[3] = className;
        $[4] = rest;
        $[5] = src;
    } else {
        alt = $[2];
        className = $[3];
        rest = $[4];
        src = $[5];
    }
    let t1;
    if ($[6] !== src) {
        t1 = getStrapiMedia(src);
        $[6] = src;
        $[7] = t1;
    } else {
        t1 = $[7];
    }
    const imageUrl = t1;
    if (!imageUrl) {
        return null;
    }
    const t2 = alt ?? "No alternative text provided";
    let t3;
    if ($[8] !== className || $[9] !== imageUrl || $[10] !== rest || $[11] !== t2) {
        t3 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$image$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
            src: imageUrl,
            alt: t2,
            className: className,
            ...rest
        }, void 0, false, {
            fileName: "[project]/frontend/src/components/ui/strapi-image.tsx",
            lineNumber: 65,
            columnNumber: 10
        }, this);
        $[8] = className;
        $[9] = imageUrl;
        $[10] = rest;
        $[11] = t2;
        $[12] = t3;
    } else {
        t3 = $[12];
    }
    return t3;
}
_c = StrapiImage;
var _c;
__turbopack_context__.k.register(_c, "StrapiImage");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/frontend/src/components/custom/layouts/gallery.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Gallery",
    ()=>Gallery
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$compiler$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/compiler-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$ui$2f$strapi$2d$image$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/frontend/src/components/ui/strapi-image.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2f$dist$2f$es$2f$react$2d$entry$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/node_modules/motion-plus/dist/es/react-entry.mjs [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2f$dist$2f$es$2f$components$2f$Carousel$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-plus/dist/es/components/Carousel/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2f$dist$2f$es$2f$components$2f$Ticker$2f$use$2d$ticker$2d$item$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-plus/dist/es/components/Ticker/use-ticker-item.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$render$2f$components$2f$motion$2f$proxy$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/framer-motion/dist/es/render/components/motion/proxy.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$value$2f$use$2d$transform$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/framer-motion/dist/es/value/use-transform.mjs [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
"use client";
;
;
;
;
function CoverflowItem(t0) {
    _s();
    const $ = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$compiler$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["c"])(24);
    if ($[0] !== "27676373289858fd1dc9e3ab87c5540af1e3f3328a1d28db4d59ca6bb16067af") {
        for(let $i = 0; $i < 24; $i += 1){
            $[$i] = Symbol.for("react.memo_cache_sentinel");
        }
        $[0] = "27676373289858fd1dc9e3ab87c5540af1e3f3328a1d28db4d59ca6bb16067af";
    }
    const { img, index } = t0;
    const { offset, props } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2f$dist$2f$es$2f$components$2f$Ticker$2f$use$2d$ticker$2d$item$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTickerItem"])();
    let t1;
    let t2;
    if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
        t1 = [
            -200,
            0,
            200
        ];
        t2 = [
            20,
            0,
            -20
        ];
        $[1] = t1;
        $[2] = t2;
    } else {
        t1 = $[1];
        t2 = $[2];
    }
    const rotateY = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$value$2f$use$2d$transform$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTransform"])(offset, t1, t2);
    let t3;
    let t4;
    if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
        t3 = [
            -200,
            0,
            200
        ];
        t4 = [
            0.7,
            1,
            0.7
        ];
        $[3] = t3;
        $[4] = t4;
    } else {
        t3 = $[3];
        t4 = $[4];
    }
    const scale = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$value$2f$use$2d$transform$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTransform"])(offset, t3, t4);
    let t5;
    let t6;
    if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
        t5 = [
            -800,
            -200,
            200,
            800
        ];
        t6 = [
            "100%",
            "0%",
            "0%",
            "-100%"
        ];
        $[5] = t5;
        $[6] = t6;
    } else {
        t5 = $[5];
        t6 = $[6];
    }
    const x = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$value$2f$use$2d$transform$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTransform"])(offset, t5, t6);
    const zIndex = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$value$2f$use$2d$transform$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTransform"])(offset, _CoverflowItemUseTransform);
    let t7;
    if ($[7] !== props.style || $[8] !== zIndex) {
        t7 = {
            ...props.style,
            zIndex
        };
        $[7] = props.style;
        $[8] = zIndex;
        $[9] = t7;
    } else {
        t7 = $[9];
    }
    let t8;
    if ($[10] !== rotateY || $[11] !== scale || $[12] !== x) {
        t8 = {
            transformPerspective: 500,
            x,
            rotateY,
            scale,
            willChange: "transform, opacity"
        };
        $[10] = rotateY;
        $[11] = scale;
        $[12] = x;
        $[13] = t8;
    } else {
        t8 = $[13];
    }
    const t9 = img.alternativeText || `Gallery image ${index + 1}`;
    let t10;
    if ($[14] !== img.url || $[15] !== t9) {
        t10 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$frontend$2f$src$2f$components$2f$ui$2f$strapi$2d$image$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["StrapiImage"], {
            src: img.url,
            alt: t9,
            className: "w-full h-full object-cover rounded-lg shadow-lg",
            width: 480,
            height: 720
        }, void 0, false, {
            fileName: "[project]/frontend/src/components/custom/layouts/gallery.tsx",
            lineNumber: 101,
            columnNumber: 11
        }, this);
        $[14] = img.url;
        $[15] = t9;
        $[16] = t10;
    } else {
        t10 = $[16];
    }
    let t11;
    if ($[17] !== t10 || $[18] !== t8) {
        t11 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$render$2f$components$2f$motion$2f$proxy$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["motion"].div, {
            className: "w-[400px] h-[600px] md:w-[480px] md:h-[720px] rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.3)]",
            style: t8,
            children: t10
        }, void 0, false, {
            fileName: "[project]/frontend/src/components/custom/layouts/gallery.tsx",
            lineNumber: 110,
            columnNumber: 11
        }, this);
        $[17] = t10;
        $[18] = t8;
        $[19] = t11;
    } else {
        t11 = $[19];
    }
    let t12;
    if ($[20] !== props || $[21] !== t11 || $[22] !== t7) {
        t12 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$render$2f$components$2f$motion$2f$proxy$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["motion"].li, {
            ...props,
            style: t7,
            children: t11
        }, void 0, false, {
            fileName: "[project]/frontend/src/components/custom/layouts/gallery.tsx",
            lineNumber: 119,
            columnNumber: 11
        }, this);
        $[20] = props;
        $[21] = t11;
        $[22] = t7;
        $[23] = t12;
    } else {
        t12 = $[23];
    }
    return t12;
}
_s(CoverflowItem, "revbpadh6BuozftrgKO7J7kfsg8=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2f$dist$2f$es$2f$components$2f$Ticker$2f$use$2d$ticker$2d$item$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTickerItem"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$value$2f$use$2d$transform$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTransform"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$value$2f$use$2d$transform$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTransform"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$value$2f$use$2d$transform$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTransform"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$value$2f$use$2d$transform$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTransform"]
    ];
});
_c = CoverflowItem;
function _CoverflowItemUseTransform(value) {
    return Math.max(0, Math.round(1000 - Math.abs(value)));
}
function Gallery(t0) {
    const $ = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$compiler$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["c"])(18);
    if ($[0] !== "27676373289858fd1dc9e3ab87c5540af1e3f3328a1d28db4d59ca6bb16067af") {
        for(let $i = 0; $i < 18; $i += 1){
            $[$i] = Symbol.for("react.memo_cache_sentinel");
        }
        $[0] = "27676373289858fd1dc9e3ab87c5540af1e3f3328a1d28db4d59ca6bb16067af";
    }
    const { data } = t0;
    if (!data) {
        return null;
    }
    const { heading, subHeading, description, image } = data;
    let t1;
    if ($[1] !== heading) {
        t1 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
            className: "section-heading-red ",
            children: heading
        }, void 0, false, {
            fileName: "[project]/frontend/src/components/custom/layouts/gallery.tsx",
            lineNumber: 154,
            columnNumber: 10
        }, this);
        $[1] = heading;
        $[2] = t1;
    } else {
        t1 = $[2];
    }
    let t2;
    if ($[3] !== subHeading) {
        t2 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
            className: "font-light text-black text-xl md:text-2xl lg:text-3xl",
            children: subHeading
        }, void 0, false, {
            fileName: "[project]/frontend/src/components/custom/layouts/gallery.tsx",
            lineNumber: 162,
            columnNumber: 10
        }, this);
        $[3] = subHeading;
        $[4] = t2;
    } else {
        t2 = $[4];
    }
    let t3;
    if ($[5] !== description) {
        t3 = description && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
            className: "mx-auto mt-4 max-w-2xl text-brand-black",
            children: description
        }, void 0, false, {
            fileName: "[project]/frontend/src/components/custom/layouts/gallery.tsx",
            lineNumber: 170,
            columnNumber: 25
        }, this);
        $[5] = description;
        $[6] = t3;
    } else {
        t3 = $[6];
    }
    let t4;
    if ($[7] !== t1 || $[8] !== t2 || $[9] !== t3) {
        t4 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "container mx-auto max-w-2xl",
            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "text-container max-w-4xl mx-auto",
                children: [
                    t1,
                    t2,
                    t3
                ]
            }, void 0, true, {
                fileName: "[project]/frontend/src/components/custom/layouts/gallery.tsx",
                lineNumber: 178,
                columnNumber: 55
            }, this)
        }, void 0, false, {
            fileName: "[project]/frontend/src/components/custom/layouts/gallery.tsx",
            lineNumber: 178,
            columnNumber: 10
        }, this);
        $[7] = t1;
        $[8] = t2;
        $[9] = t3;
        $[10] = t4;
    } else {
        t4 = $[10];
    }
    let t5;
    if ($[11] !== image) {
        t5 = image.map(_GalleryImageMap);
        $[11] = image;
        $[12] = t5;
    } else {
        t5 = $[12];
    }
    let t6;
    if ($[13] !== t5) {
        t6 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "container mx-auto overflow-hidden",
            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "mask-gradient flex items-center justify-center min-h-[800px] md:min-h-[800px]",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2f$dist$2f$es$2f$components$2f$Carousel$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Carousel"], {
                    className: "w-[400px] h-[600px] md:w-[480px] md:h-[720px] flex items-center justify-center mx-auto",
                    items: t5,
                    overflow: true,
                    gap: 0,
                    itemSize: "manual",
                    safeMargin: 200
                }, void 0, false, {
                    fileName: "[project]/frontend/src/components/custom/layouts/gallery.tsx",
                    lineNumber: 196,
                    columnNumber: 156
                }, this)
            }, void 0, false, {
                fileName: "[project]/frontend/src/components/custom/layouts/gallery.tsx",
                lineNumber: 196,
                columnNumber: 61
            }, this)
        }, void 0, false, {
            fileName: "[project]/frontend/src/components/custom/layouts/gallery.tsx",
            lineNumber: 196,
            columnNumber: 10
        }, this);
        $[13] = t5;
        $[14] = t6;
    } else {
        t6 = $[14];
    }
    let t7;
    if ($[15] !== t4 || $[16] !== t6) {
        t7 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("section", {
            className: "px-2 py-4 mx-auto md:px-6 lg:pt-12 lg:pb-16 bg-brand-pink overflow-hidden",
            children: [
                t4,
                t6
            ]
        }, void 0, true, {
            fileName: "[project]/frontend/src/components/custom/layouts/gallery.tsx",
            lineNumber: 204,
            columnNumber: 10
        }, this);
        $[15] = t4;
        $[16] = t6;
        $[17] = t7;
    } else {
        t7 = $[17];
    }
    return t7;
}
_c1 = Gallery;
function _GalleryImageMap(img, index) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(CoverflowItem, {
        img: img,
        index: index
    }, img.id, false, {
        fileName: "[project]/frontend/src/components/custom/layouts/gallery.tsx",
        lineNumber: 214,
        columnNumber: 10
    }, this);
}
var _c, _c1;
__turbopack_context__.k.register(_c, "CoverflowItem");
__turbopack_context__.k.register(_c1, "Gallery");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# sourceMappingURL=frontend_src_components_30749e53._.js.map
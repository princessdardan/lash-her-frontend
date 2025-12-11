module.exports = [
"[project]/frontend/node_modules/@swc/helpers/cjs/_interop_require_default.cjs [app-ssr] (ecmascript)", ((__turbopack_context__, module, exports) => {
"use strict";

function _interop_require_default(obj) {
    return obj && obj.__esModule ? obj : {
        default: obj
    };
}
exports._ = _interop_require_default;
}),
"[project]/frontend/node_modules/@swc/helpers/cjs/_interop_require_wildcard.cjs [app-ssr] (ecmascript)", ((__turbopack_context__, module, exports) => {
"use strict";

function _getRequireWildcardCache(nodeInterop) {
    if (typeof WeakMap !== "function") return null;
    var cacheBabelInterop = new WeakMap();
    var cacheNodeInterop = new WeakMap();
    return (_getRequireWildcardCache = function(nodeInterop) {
        return nodeInterop ? cacheNodeInterop : cacheBabelInterop;
    })(nodeInterop);
}
function _interop_require_wildcard(obj, nodeInterop) {
    if (!nodeInterop && obj && obj.__esModule) return obj;
    if (obj === null || typeof obj !== "object" && typeof obj !== "function") return {
        default: obj
    };
    var cache = _getRequireWildcardCache(nodeInterop);
    if (cache && cache.has(obj)) return cache.get(obj);
    var newObj = {
        __proto__: null
    };
    var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor;
    for(var key in obj){
        if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) {
            var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null;
            if (desc && (desc.get || desc.set)) Object.defineProperty(newObj, key, desc);
            else newObj[key] = obj[key];
        }
    }
    newObj.default = obj;
    if (cache) cache.set(obj, newObj);
    return newObj;
}
exports._ = _interop_require_wildcard;
}),
"[project]/frontend/node_modules/clsx/dist/clsx.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "clsx",
    ()=>clsx,
    "default",
    ()=>__TURBOPACK__default__export__
]);
function r(e) {
    var t, f, n = "";
    if ("string" == typeof e || "number" == typeof e) n += e;
    else if ("object" == typeof e) if (Array.isArray(e)) {
        var o = e.length;
        for(t = 0; t < o; t++)e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
    } else for(f in e)e[f] && (n && (n += " "), n += f);
    return n;
}
function clsx() {
    for(var e, t, f = 0, n = "", o = arguments.length; f < o; f++)(e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
    return n;
}
const __TURBOPACK__default__export__ = clsx;
}),
"[project]/node_modules/motion-utils/dist/es/format-error-message.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "formatErrorMessage",
    ()=>formatErrorMessage
]);
function formatErrorMessage(message, errorCode) {
    return errorCode ? `${message}. For more information and steps for solving, visit https://motion.dev/troubleshooting/${errorCode}` : message;
}
;
}),
"[project]/node_modules/motion-utils/dist/es/warn-once.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "hasWarned",
    ()=>hasWarned,
    "warnOnce",
    ()=>warnOnce
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$format$2d$error$2d$message$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/format-error-message.mjs [app-ssr] (ecmascript)");
;
const warned = new Set();
function hasWarned(message) {
    return warned.has(message);
}
function warnOnce(condition, message, errorCode) {
    if (condition || warned.has(message)) return;
    console.warn((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$format$2d$error$2d$message$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["formatErrorMessage"])(message, errorCode));
    warned.add(message);
}
;
}),
"[project]/node_modules/motion-utils/dist/es/array.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "addUniqueItem",
    ()=>addUniqueItem,
    "moveItem",
    ()=>moveItem,
    "removeItem",
    ()=>removeItem
]);
function addUniqueItem(arr, item) {
    if (arr.indexOf(item) === -1) arr.push(item);
}
function removeItem(arr, item) {
    const index = arr.indexOf(item);
    if (index > -1) arr.splice(index, 1);
}
// Adapted from array-move
function moveItem([...arr], fromIndex, toIndex) {
    const startIndex = fromIndex < 0 ? arr.length + fromIndex : fromIndex;
    if (startIndex >= 0 && startIndex < arr.length) {
        const endIndex = toIndex < 0 ? arr.length + toIndex : toIndex;
        const [item] = arr.splice(fromIndex, 1);
        arr.splice(endIndex, 0, item);
    }
    return arr;
}
;
}),
"[project]/node_modules/motion-utils/dist/es/subscription-manager.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "SubscriptionManager",
    ()=>SubscriptionManager
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$array$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/array.mjs [app-ssr] (ecmascript)");
;
class SubscriptionManager {
    constructor(){
        this.subscriptions = [];
    }
    add(handler) {
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$array$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["addUniqueItem"])(this.subscriptions, handler);
        return ()=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$array$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["removeItem"])(this.subscriptions, handler);
    }
    notify(a, b, c) {
        const numSubscriptions = this.subscriptions.length;
        if (!numSubscriptions) return;
        if (numSubscriptions === 1) {
            /**
             * If there's only a single handler we can just call it without invoking a loop.
             */ this.subscriptions[0](a, b, c);
        } else {
            for(let i = 0; i < numSubscriptions; i++){
                /**
                 * Check whether the handler exists before firing as it's possible
                 * the subscriptions were modified during this loop running.
                 */ const handler = this.subscriptions[i];
                handler && handler(a, b, c);
            }
        }
    }
    getSize() {
        return this.subscriptions.length;
    }
    clear() {
        this.subscriptions.length = 0;
    }
}
;
}),
"[project]/node_modules/motion-utils/dist/es/velocity-per-second.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/*
  Convert velocity into velocity per second

  @param [number]: Unit per frame
  @param [number]: Frame duration in ms
*/ __turbopack_context__.s([
    "velocityPerSecond",
    ()=>velocityPerSecond
]);
function velocityPerSecond(velocity, frameDuration) {
    return frameDuration ? velocity * (1000 / frameDuration) : 0;
}
;
}),
"[project]/node_modules/motion-utils/dist/es/global-config.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "MotionGlobalConfig",
    ()=>MotionGlobalConfig
]);
const MotionGlobalConfig = {};
;
}),
"[project]/node_modules/motion-utils/dist/es/noop.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/*#__NO_SIDE_EFFECTS__*/ __turbopack_context__.s([
    "noop",
    ()=>noop
]);
const noop = (any)=>any;
;
}),
"[project]/node_modules/motion-utils/dist/es/errors.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "invariant",
    ()=>invariant,
    "warning",
    ()=>warning
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$format$2d$error$2d$message$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/format-error-message.mjs [app-ssr] (ecmascript)");
;
let warning = ()=>{};
let invariant = ()=>{};
if ("TURBOPACK compile-time truthy", 1) {
    warning = (check, message, errorCode)=>{
        if (!check && typeof console !== "undefined") {
            console.warn((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$format$2d$error$2d$message$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["formatErrorMessage"])(message, errorCode));
        }
    };
    invariant = (check, message, errorCode)=>{
        if (!check) {
            throw new Error((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$format$2d$error$2d$message$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["formatErrorMessage"])(message, errorCode));
        }
    };
}
;
}),
"[project]/node_modules/motion-utils/dist/es/pipe.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Pipe
 * Compose other transformers to run linearily
 * pipe(min(20), max(40))
 * @param  {...functions} transformers
 * @return {function}
 */ __turbopack_context__.s([
    "pipe",
    ()=>pipe
]);
const combineFunctions = (a, b)=>(v)=>b(a(v));
const pipe = (...transformers)=>transformers.reduce(combineFunctions);
;
}),
"[project]/node_modules/motion-utils/dist/es/clamp.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "clamp",
    ()=>clamp
]);
const clamp = (min, max, v)=>{
    if (v > max) return max;
    if (v < min) return min;
    return v;
};
;
}),
"[project]/node_modules/motion-utils/dist/es/time-conversion.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Converts seconds to milliseconds
 *
 * @param seconds - Time in seconds.
 * @return milliseconds - Converted time in milliseconds.
 */ /*#__NO_SIDE_EFFECTS__*/ __turbopack_context__.s([
    "millisecondsToSeconds",
    ()=>millisecondsToSeconds,
    "secondsToMilliseconds",
    ()=>secondsToMilliseconds
]);
const secondsToMilliseconds = (seconds)=>seconds * 1000;
/*#__NO_SIDE_EFFECTS__*/ const millisecondsToSeconds = (milliseconds)=>milliseconds / 1000;
;
}),
"[project]/node_modules/motion-utils/dist/es/easing/cubic-bezier.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "cubicBezier",
    ()=>cubicBezier
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$noop$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/noop.mjs [app-ssr] (ecmascript)");
;
/*
  Bezier function generator
  This has been modified from Gaëtan Renaudeau's BezierEasing
  https://github.com/gre/bezier-easing/blob/master/src/index.js
  https://github.com/gre/bezier-easing/blob/master/LICENSE
  
  I've removed the newtonRaphsonIterate algo because in benchmarking it
  wasn't noticeably faster than binarySubdivision, indeed removing it
  usually improved times, depending on the curve.
  I also removed the lookup table, as for the added bundle size and loop we're
  only cutting ~4 or so subdivision iterations. I bumped the max iterations up
  to 12 to compensate and this still tended to be faster for no perceivable
  loss in accuracy.
  Usage
    const easeOut = cubicBezier(.17,.67,.83,.67);
    const x = easeOut(0.5); // returns 0.627...
*/ // Returns x(t) given t, x1, and x2, or y(t) given t, y1, and y2.
const calcBezier = (t, a1, a2)=>(((1.0 - 3.0 * a2 + 3.0 * a1) * t + (3.0 * a2 - 6.0 * a1)) * t + 3.0 * a1) * t;
const subdivisionPrecision = 0.0000001;
const subdivisionMaxIterations = 12;
function binarySubdivide(x, lowerBound, upperBound, mX1, mX2) {
    let currentX;
    let currentT;
    let i = 0;
    do {
        currentT = lowerBound + (upperBound - lowerBound) / 2.0;
        currentX = calcBezier(currentT, mX1, mX2) - x;
        if (currentX > 0.0) {
            upperBound = currentT;
        } else {
            lowerBound = currentT;
        }
    }while (Math.abs(currentX) > subdivisionPrecision && ++i < subdivisionMaxIterations)
    return currentT;
}
function cubicBezier(mX1, mY1, mX2, mY2) {
    // If this is a linear gradient, return linear easing
    if (mX1 === mY1 && mX2 === mY2) return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$noop$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["noop"];
    const getTForX = (aX)=>binarySubdivide(aX, 0, 1, mX1, mX2);
    // If animation is at start/end, return t without easing
    return (t)=>t === 0 || t === 1 ? t : calcBezier(getTForX(t), mY1, mY2);
}
;
}),
"[project]/node_modules/motion-utils/dist/es/easing/ease.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "easeIn",
    ()=>easeIn,
    "easeInOut",
    ()=>easeInOut,
    "easeOut",
    ()=>easeOut
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$cubic$2d$bezier$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/cubic-bezier.mjs [app-ssr] (ecmascript)");
;
const easeIn = /*@__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$cubic$2d$bezier$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["cubicBezier"])(0.42, 0, 1, 1);
const easeOut = /*@__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$cubic$2d$bezier$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["cubicBezier"])(0, 0, 0.58, 1);
const easeInOut = /*@__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$cubic$2d$bezier$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["cubicBezier"])(0.42, 0, 0.58, 1);
;
}),
"[project]/node_modules/motion-utils/dist/es/easing/utils/is-easing-array.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "isEasingArray",
    ()=>isEasingArray
]);
const isEasingArray = (ease)=>{
    return Array.isArray(ease) && typeof ease[0] !== "number";
};
;
}),
"[project]/node_modules/motion-utils/dist/es/easing/modifiers/mirror.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

// Accepts an easing function and returns a new one that outputs mirrored values for
// the second half of the animation. Turns easeIn into easeInOut.
__turbopack_context__.s([
    "mirrorEasing",
    ()=>mirrorEasing
]);
const mirrorEasing = (easing)=>(p)=>p <= 0.5 ? easing(2 * p) / 2 : (2 - easing(2 * (1 - p))) / 2;
;
}),
"[project]/node_modules/motion-utils/dist/es/easing/modifiers/reverse.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

// Accepts an easing function and returns a new one that outputs reversed values.
// Turns easeIn into easeOut.
__turbopack_context__.s([
    "reverseEasing",
    ()=>reverseEasing
]);
const reverseEasing = (easing)=>(p)=>1 - easing(1 - p);
;
}),
"[project]/node_modules/motion-utils/dist/es/easing/back.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "backIn",
    ()=>backIn,
    "backInOut",
    ()=>backInOut,
    "backOut",
    ()=>backOut
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$cubic$2d$bezier$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/cubic-bezier.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$modifiers$2f$mirror$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/modifiers/mirror.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$modifiers$2f$reverse$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/modifiers/reverse.mjs [app-ssr] (ecmascript)");
;
;
;
const backOut = /*@__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$cubic$2d$bezier$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["cubicBezier"])(0.33, 1.53, 0.69, 0.99);
const backIn = /*@__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$modifiers$2f$reverse$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["reverseEasing"])(backOut);
const backInOut = /*@__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$modifiers$2f$mirror$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["mirrorEasing"])(backIn);
;
}),
"[project]/node_modules/motion-utils/dist/es/easing/anticipate.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "anticipate",
    ()=>anticipate
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$back$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/back.mjs [app-ssr] (ecmascript)");
;
const anticipate = (p)=>(p *= 2) < 1 ? 0.5 * (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$back$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["backIn"])(p) : 0.5 * (2 - Math.pow(2, -10 * (p - 1)));
;
}),
"[project]/node_modules/motion-utils/dist/es/easing/circ.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "circIn",
    ()=>circIn,
    "circInOut",
    ()=>circInOut,
    "circOut",
    ()=>circOut
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$modifiers$2f$mirror$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/modifiers/mirror.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$modifiers$2f$reverse$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/modifiers/reverse.mjs [app-ssr] (ecmascript)");
;
;
const circIn = (p)=>1 - Math.sin(Math.acos(p));
const circOut = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$modifiers$2f$reverse$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["reverseEasing"])(circIn);
const circInOut = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$modifiers$2f$mirror$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["mirrorEasing"])(circIn);
;
}),
"[project]/node_modules/motion-utils/dist/es/easing/utils/is-bezier-definition.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "isBezierDefinition",
    ()=>isBezierDefinition
]);
const isBezierDefinition = (easing)=>Array.isArray(easing) && typeof easing[0] === "number";
;
}),
"[project]/node_modules/motion-utils/dist/es/easing/utils/map.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "easingDefinitionToFunction",
    ()=>easingDefinitionToFunction
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$errors$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/errors.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$noop$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/noop.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$anticipate$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/anticipate.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$back$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/back.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$circ$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/circ.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$cubic$2d$bezier$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/cubic-bezier.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$ease$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/ease.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$utils$2f$is$2d$bezier$2d$definition$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/utils/is-bezier-definition.mjs [app-ssr] (ecmascript)");
;
;
;
;
;
;
;
;
const easingLookup = {
    linear: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$noop$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["noop"],
    easeIn: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$ease$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["easeIn"],
    easeInOut: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$ease$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["easeInOut"],
    easeOut: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$ease$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["easeOut"],
    circIn: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$circ$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["circIn"],
    circInOut: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$circ$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["circInOut"],
    circOut: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$circ$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["circOut"],
    backIn: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$back$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["backIn"],
    backInOut: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$back$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["backInOut"],
    backOut: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$back$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["backOut"],
    anticipate: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$anticipate$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["anticipate"]
};
const isValidEasing = (easing)=>{
    return typeof easing === "string";
};
const easingDefinitionToFunction = (definition)=>{
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$utils$2f$is$2d$bezier$2d$definition$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["isBezierDefinition"])(definition)) {
        // If cubic bezier definition, create bezier curve
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$errors$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["invariant"])(definition.length === 4, `Cubic bezier arrays must contain four numerical values.`, "cubic-bezier-length");
        const [x1, y1, x2, y2] = definition;
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$cubic$2d$bezier$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["cubicBezier"])(x1, y1, x2, y2);
    } else if (isValidEasing(definition)) {
        // Else lookup from table
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$errors$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["invariant"])(easingLookup[definition] !== undefined, `Invalid easing type '${definition}'`, "invalid-easing-type");
        return easingLookup[definition];
    }
    return definition;
};
;
}),
"[project]/node_modules/motion-utils/dist/es/progress.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/*
  Progress within given range

  Given a lower limit and an upper limit, we return the progress
  (expressed as a number 0-1) represented by the given value, and
  limit that progress to within 0-1.

  @param [number]: Lower limit
  @param [number]: Upper limit
  @param [number]: Value to find progress within given range
  @return [number]: Progress of value within range as expressed 0-1
*/ /*#__NO_SIDE_EFFECTS__*/ __turbopack_context__.s([
    "progress",
    ()=>progress
]);
const progress = (from, to, value)=>{
    const toFromDifference = to - from;
    return toFromDifference === 0 ? 1 : (value - from) / toFromDifference;
};
;
}),
"[project]/node_modules/motion-utils/dist/es/is-numerical-string.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Check if value is a numerical string, ie a string that is purely a number eg "100" or "-100.1"
 */ __turbopack_context__.s([
    "isNumericalString",
    ()=>isNumericalString
]);
const isNumericalString = (v)=>/^-?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(v);
;
}),
"[project]/node_modules/motion-utils/dist/es/is-zero-value-string.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Check if the value is a zero value string like "0px" or "0%"
 */ __turbopack_context__.s([
    "isZeroValueString",
    ()=>isZeroValueString
]);
const isZeroValueString = (v)=>/^0[^.\s]+$/u.test(v);
;
}),
"[project]/node_modules/motion-utils/dist/es/memo.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/*#__NO_SIDE_EFFECTS__*/ __turbopack_context__.s([
    "memo",
    ()=>memo
]);
function memo(callback) {
    let result;
    return ()=>{
        if (result === undefined) result = callback();
        return result;
    };
}
;
}),
"[project]/node_modules/motion-utils/dist/es/is-object.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "isObject",
    ()=>isObject
]);
function isObject(value) {
    return typeof value === "object" && value !== null;
}
;
}),
"[project]/node_modules/motion-utils/dist/es/wrap.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "wrap",
    ()=>wrap
]);
const wrap = (min, max, v)=>{
    const rangeSize = max - min;
    return ((v - min) % rangeSize + rangeSize) % rangeSize + min;
};
;
}),
"[project]/node_modules/motion-utils/dist/es/easing/utils/get-easing-for-segment.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "getEasingForSegment",
    ()=>getEasingForSegment
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$wrap$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/wrap.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$utils$2f$is$2d$easing$2d$array$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/easing/utils/is-easing-array.mjs [app-ssr] (ecmascript)");
;
;
function getEasingForSegment(easing, i) {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$easing$2f$utils$2f$is$2d$easing$2d$array$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["isEasingArray"])(easing) ? easing[(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$wrap$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["wrap"])(0, easing.length, i)] : easing;
}
;
}),
"[project]/node_modules/motion-plus-dom/dist/es/split-text/index.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "splitText",
    ()=>splitText
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$dom$2f$dist$2f$es$2f$utils$2f$resolve$2d$elements$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-dom/dist/es/utils/resolve-elements.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$errors$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-utils/dist/es/errors.mjs [app-ssr] (ecmascript)");
;
;
function createSpan(className, index) {
    const span = document.createElement("span");
    if (className) {
        span.className = className;
    }
    if (index !== undefined) {
        span.dataset.index = index.toString();
    }
    span.style.display = "inline-block";
    return span;
}
function addToken(element, token, className, index) {
    const charSpan = createSpan(className, index);
    charSpan.textContent = token;
    element.appendChild(charSpan);
    return charSpan;
}
/**
 * Splits text content of an element into characters, words, and lines.
 *
 * @param elementOrSelector - The element or selector of the element to split. If multiple elements are found, only the first will be split.
 * @param options - Options.
 * @returns An object the chars, words, and lines DOM nodes as a list.
 */ function splitText(elementOrSelector, { splitBy = " ", charClass = "split-char", wordClass = "split-word", lineClass = "split-line" } = {}) {
    /**
     * We currently only support splitting a single element.
     * This could be changed in a future version.
     */ const [element] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$dom$2f$dist$2f$es$2f$utils$2f$resolve$2d$elements$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["resolveElements"])(elementOrSelector);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$utils$2f$dist$2f$es$2f$errors$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["invariant"])(Boolean(element), "Element not found");
    const text = element.textContent || "";
    element.setAttribute("aria-label", text);
    element.textContent = "";
    /**
     * Keep lists of split elements.
     */ const splitElements = {
        chars: [],
        words: [],
        lines: []
    };
    /**
     * Split the text into words using the provided delimiter.
     */ const words = text.split(splitBy);
    const wordElements = [];
    const spacerElements = [];
    /**
     * Write: Create all word and character spans before measuring top offsets.
     */ for(let wordIndex = 0; wordIndex < words.length; wordIndex++){
        const word = words[wordIndex];
        const wordSpan = createSpan(wordClass, wordIndex);
        splitElements.words.push(wordSpan);
        wordElements.push(wordSpan);
        /**
         * Create a span for each character in the word.
         */ const chars = Array.from(word);
        for(let charIndex = 0; charIndex < chars.length; charIndex++){
            const char = chars[charIndex];
            const charSpan = addToken(wordSpan, char, charClass, charIndex);
            splitElements.chars.push(charSpan);
        }
        /**
         * Add the word span to the parent element.
         */ element.appendChild(wordSpan);
        /**
         * Add the delimiter after the word. If the delimiter is a space,
         * add a space text node directly to the parent element, otherwise
         * add the delimited as a character to allow it to be animated.
         */ if (wordIndex < words.length - 1) {
            if (splitBy === " ") {
                const spaceNode = document.createTextNode(" ");
                element.appendChild(spaceNode);
                spacerElements.push(spaceNode);
            } else {
                const delimiterSpan = addToken(wordSpan, splitBy, `${charClass}-delimiter`);
                splitElements.chars.push(delimiterSpan);
            }
        }
    }
    // TODO: Would it be worth allowing early return without line splitting?
    /**
     * Read: Measure the top offset of each word.
     */ const wordData = wordElements.map((wordSpan, index)=>{
        return {
            element: wordSpan,
            top: wordSpan.offsetTop,
            index,
            spacer: index < spacerElements.length ? spacerElements[index] : null
        };
    });
    /**
     * Write: Group words into lines based on measured top offsets.
     */ const lines = [];
    let currentLine = [];
    let currentTop = wordData[0]?.top ?? 0;
    let lineIndex = 0;
    for(let i = 0; i < wordData.length; i++){
        const { element, top, spacer } = wordData[i];
        // Check if word starts a new line
        if (top > currentTop && currentLine.length > 0) {
            // Complete current line and start a new one
            lines.push({
                elements: currentLine,
                lineIndex: lineIndex++
            });
            currentLine = [];
            currentTop = top;
        }
        // Add word to current line
        currentLine.push(element);
        // Add spacer if it exists
        if (spacer) {
            currentLine.push(spacer);
        }
    }
    // Add the last line if it has any elements
    if (currentLine.length > 0) {
        lines.push({
            elements: currentLine,
            lineIndex
        });
    }
    /**
     * Write: Rebuild element with lines.
     */ element.textContent = "";
    for (const { elements, lineIndex } of lines){
        const lineSpan = createSpan(lineClass, lineIndex);
        lineSpan.style.display = "inline-block";
        splitElements.lines.push(lineSpan);
        // Build the line with the word elements.
        for (const node of elements){
            lineSpan.appendChild(node);
        }
        element.appendChild(lineSpan);
    }
    return splitElements;
}
;
}),
"[project]/node_modules/motion-plus-dom/dist/es/typewriter/needs-backspace.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "needsBackspace",
    ()=>needsBackspace
]);
function needsBackspace(currentText, fullText) {
    return currentText.length > fullText.length || currentText.length > 0 && !fullText.startsWith(currentText);
}
;
}),
"[project]/node_modules/motion-plus-dom/dist/es/typewriter/delay.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "getTypewriterDelay",
    ()=>getTypewriterDelay
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2d$dom$2f$dist$2f$es$2f$typewriter$2f$needs$2d$backspace$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-plus-dom/dist/es/typewriter/needs-backspace.mjs [app-ssr] (ecmascript)");
;
/**
 * Natural typing variance patterns based on research
 * Returns delay as a multiple of the base interval using realistic typing patterns
 */ function mix(a, b, t) {
    return a + (b - a) * t;
}
/**
 * Calculate a delay before typing the next character in the text.
 */ function getTypewriterDelay(fullText, currentText, interval, variance, backspaceFactor) {
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2d$dom$2f$dist$2f$es$2f$typewriter$2f$needs$2d$backspace$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["needsBackspace"])(currentText, fullText)) {
        return interval * backspaceFactor;
    }
    if (variance === "natural") {
        return getNaturalDelay(fullText, currentText, interval);
    }
    if (typeof variance === "number" && variance > 0) {
        // Apply percentage-based random variance
        const varianceAmount = interval * (variance / 100);
        return interval + mix(-varianceAmount, varianceAmount, Math.random());
    }
    return interval;
}
function getNaturalDelay(fullText, currentText, interval) {
    const currentIndex = currentText.length;
    const char = fullText[currentIndex];
    const previousChar = fullText[currentIndex - 1];
    if (!char) return interval;
    // Find current position in word and full word boundaries
    const beforeText = fullText.slice(0, currentIndex);
    const lastSpaceIndex = beforeText.lastIndexOf(" ");
    const positionInWord = currentIndex - lastSpaceIndex - 1;
    // Find the full word boundaries (start and end)
    const wordStart = lastSpaceIndex + 1;
    const afterCurrentIndex = fullText.slice(currentIndex);
    const nextSpaceIndex = afterCurrentIndex.indexOf(" ");
    const wordEnd = nextSpaceIndex === -1 ? fullText.length : currentIndex + nextSpaceIndex;
    const wordLength = wordEnd - wordStart;
    // Start with base multiplier
    let delayMultiplier = 1.0;
    // Thinking pauses at sentence boundaries (major effect)
    if (previousChar && /[.!?]/.test(previousChar) && char === " ") {
        delayMultiplier *= 3; // 200% longer pause for thinking
    }
    // Short words (1-3 chars) are faster due to high frequency and muscle memory
    if (wordLength <= 3) {
        delayMultiplier *= 0.7; // 30% faster for short/common words
    } else {
        // Slower at beginning of words (muscle memory activation)
        if (positionInWord === 0 && char !== " ") {
            delayMultiplier *= 1.5;
        }
        // Slower at end of words (preparation for next word)
        if (positionInWord === wordLength - 1) {
            delayMultiplier *= 1.4;
        }
    }
    // Acceleration in word middle (people speed up mid-word) - only for longer words
    if (positionInWord > 0 && positionInWord < wordLength - 1 && wordLength > 3) {
        const middleBoost = Math.min(positionInWord / wordLength, 0.4);
        delayMultiplier *= 1.0 - middleBoost;
    }
    // Slower for punctuation (check the character being typed)
    if (punctuation.has(char)) {
        delayMultiplier *= 1.5;
    }
    // Extra slowdown for Shift-modifier characters (check the character being typed)
    if (shiftRequired.has(char)) {
        delayMultiplier *= 1.5;
    }
    // Numbers are slower to type (check the character being typed)
    if (/\d/.test(char)) {
        delayMultiplier *= 1.3;
    }
    // Long words slow down slightly (concentration required)
    if (wordLength > 8) {
        delayMultiplier *= 1.3;
    }
    // Slower for uppercase letters (check the character being typed)
    if (char !== char.toLowerCase()) {
        delayMultiplier *= 1.25;
    }
    // Fatigue over long texts (gradual slowdown)
    const fatigueThreshold = 200; // Start fatigue after 200 characters
    if (currentIndex > fatigueThreshold) {
        const fatigueAmount = Math.min((currentIndex - fatigueThreshold) / 1000, 0.3); // Up to 30% slower
        delayMultiplier *= 1.0 + fatigueAmount;
    }
    // Add random variance (±25% of current delay)
    const randomVariance = mix(-0.25, 0.25, Math.random());
    delayMultiplier *= 1.0 + randomVariance;
    // Apply multiplier to base interval
    const finalDelay = interval * delayMultiplier;
    // Minimum delay of 20% of base speed (prevent too fast typing)
    return Math.max(interval * 0.2, finalDelay);
}
const punctuation = new Set([
    ".",
    ",",
    "!",
    "?",
    ":",
    ";",
    "'",
    '"',
    "-",
    "(",
    ")"
]);
const shiftRequired = new Set([
    "!",
    "@",
    "#",
    "$",
    "%",
    "^",
    "&",
    "*",
    "(",
    ")",
    "_",
    "+",
    "{",
    "}",
    "|",
    ":",
    '"',
    "<",
    ">",
    "?"
]);
;
}),
"[project]/node_modules/motion-plus-dom/dist/es/typewriter/find-previous-word-index.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "findPreviousWordIndex",
    ()=>findPreviousWordIndex
]);
function findPreviousWordIndex(text, fromIndex) {
    // Start from the current position and go backwards
    let i = fromIndex - 1;
    // Skip any trailing whitespace
    while(i >= 0 && /\s/.test(text[i])){
        i--;
    }
    // Find the start of the current word
    while(i >= 0 && !/\s/.test(text[i])){
        i--;
    }
    // Return the position after the space (start of the word we want to keep)
    return Math.max(0, i + 1);
}
;
}),
"[project]/node_modules/motion-plus-dom/dist/es/typewriter/find-common-prefix-index.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "findCommonPrefixIndex",
    ()=>findCommonPrefixIndex
]);
function findCommonPrefixIndex(current, target) {
    const commonPrefixLength = Math.min(current.length, target.length);
    let prefixLength = 0;
    for(let i = 0; i < commonPrefixLength; i++){
        if (current[i] === target[i]) {
            prefixLength = i + 1;
        } else {
            break;
        }
    }
    return prefixLength;
}
;
}),
"[project]/node_modules/motion-plus-dom/dist/es/typewriter/get-next-text.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "getNextText",
    ()=>getNextText
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2d$dom$2f$dist$2f$es$2f$typewriter$2f$find$2d$common$2d$prefix$2d$index$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-plus-dom/dist/es/typewriter/find-common-prefix-index.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2d$dom$2f$dist$2f$es$2f$typewriter$2f$find$2d$previous$2d$word$2d$index$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-plus-dom/dist/es/typewriter/find-previous-word-index.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2d$dom$2f$dist$2f$es$2f$typewriter$2f$needs$2d$backspace$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-plus-dom/dist/es/typewriter/needs-backspace.mjs [app-ssr] (ecmascript)");
;
;
;
function getNextText(current, target, replace, backspace) {
    if (replace === "type" && (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2d$dom$2f$dist$2f$es$2f$typewriter$2f$needs$2d$backspace$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["needsBackspace"])(current, target)) {
        if (backspace === "all") {
            return target.slice(0, (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2d$dom$2f$dist$2f$es$2f$typewriter$2f$find$2d$common$2d$prefix$2d$index$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["findCommonPrefixIndex"])(current, target));
        } else if (backspace === "word") {
            // Backspace one word at a time
            const newLength = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2d$dom$2f$dist$2f$es$2f$typewriter$2f$find$2d$previous$2d$word$2d$index$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["findPreviousWordIndex"])(current, current.length);
            return current.slice(0, newLength);
        } else {
            // backspace === "character" - backspace one character at a time
            return current.slice(0, -1);
        }
    }
    return target.slice(0, current.length + 1);
}
;
}),
"[project]/node_modules/motion-plus-dom/dist/es/wheel/index.mjs [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "wheel",
    ()=>wheel
]);
function calcDirection(delta) {
    return -Math.sign(delta);
}
function wheel(element, { axis = "y", onWheel, onSwipe, swipeThreshold = 100, swipeTimeout = 150, jitterThreshold = 2, lineHeight = 16 }) {
    let state = "IDLE";
    /**
     * The accumulated delta value. Once this becomes greater than
     * swipeThreshold, a swipe is triggered. It gets reset to 0 either when
     * swipe is interrupted, or after a timeout from wheel events.
     */ let accumulator = 0;
    /**
     * The direction of the swipe.
     * 1 = forward, -1 = backward, 0 = no swipe.
     */ let swipeDirection = 0;
    /**
     * The last delta value. Used to detect momentum scrolls and decide
     * when a new wheel sessions has started via touchpad.
     */ let lastDelta = 0;
    /**
     * True when the wheel delta is decelerating. If this is true, then further
     * wheel acceleration will be considered a new gesture and wheel events
     * will start firing.
     */ let isDecelerating = false;
    let accelerationCount = 0;
    /**
     * Whether the gesture has swiped in the wheel session. This caps the number
     * of swipes per session to 1.
     */ let hasSwipedInSession = false;
    /**
     * The timeout ID for the session.
     */ let sessionTimeoutId = null;
    const wheelHandler = (event)=>{
        const primaryDelta = axis === "x" && !event.shiftKey ? event.deltaX : event.deltaY;
        const perpendicularDelta = axis === "x" && !event.shiftKey ? event.deltaY : event.deltaX;
        // Only fire if the magnitude in the specified axis is greater than or equal to the perpendicular axis
        if (Math.abs(primaryDelta) < Math.abs(perpendicularDelta)) {
            return;
        }
        if (onWheel || onSwipe) event.preventDefault();
        let delta = -(event.deltaMode === WheelEvent.DOM_DELTA_LINE ? primaryDelta * lineHeight : primaryDelta);
        if (delta === 0) return;
        if (sessionTimeoutId) clearTimeout(sessionTimeoutId);
        sessionTimeoutId = setTimeout(()=>{
            state = "IDLE";
            hasSwipedInSession = false;
            accumulator = 0;
        }, swipeTimeout);
        if (state === "IDLE") state = "WHEELING";
        const newDirection = calcDirection(delta);
        function startSwipe(triggeringDelta, currentAccumulator) {
            state = "SWIPING";
            hasSwipedInSession = true;
            swipeDirection = calcDirection(currentAccumulator);
            // Reset momentum detection state for the new swipe
            isDecelerating = false;
            accelerationCount = 0;
            lastDelta = Math.abs(triggeringDelta);
            onSwipe?.(swipeDirection);
            // Set the accumulator to the remainder of the swipe delta
            accumulator = Math.abs(currentAccumulator) % swipeThreshold * swipeDirection;
        }
        switch(state){
            case "WHEELING":
                {
                    const newAccumulator = accumulator + delta;
                    if (onSwipe && !hasSwipedInSession && Math.abs(newAccumulator) >= swipeThreshold) {
                        startSwipe(delta, newAccumulator);
                    } else {
                        accumulator = newAccumulator;
                        onWheel?.(delta);
                    }
                    break;
                }
            case "SWIPING":
                {
                    const deltaAbs = Math.abs(delta);
                    // Determine if a new gesture has started, either by direction change or momentum change.
                    const isDirectionChange = newDirection !== swipeDirection;
                    let isMomentumChange = false;
                    if (lastDelta > 0) {
                        const deltaDiff = deltaAbs - lastDelta;
                        if (deltaDiff < 0) isDecelerating = true;
                        if (isDecelerating && deltaDiff > jitterThreshold) {
                            accelerationCount++;
                            if (accelerationCount > 2) isMomentumChange = true;
                        } else {
                            accelerationCount = 0;
                        }
                    }
                    if (isDirectionChange || isMomentumChange) {
                        // A new gesture has been detected. Reset the session lock.
                        hasSwipedInSession = false;
                        // Treat this event as the start of a new wheeling action.
                        const newAccumulator = delta;
                        if (onSwipe && !hasSwipedInSession && Math.abs(newAccumulator) >= swipeThreshold) {
                            startSwipe(delta, newAccumulator);
                        } else {
                            // Otherwise, transition to wheeling with this new delta.
                            state = "WHEELING";
                            accumulator = newAccumulator;
                            onWheel?.(delta);
                        }
                        break;
                    }
                    // If no interrupt, just update lastDelta for the next event.
                    lastDelta = deltaAbs;
                    break;
                }
        }
    };
    element.addEventListener("wheel", wheelHandler, {
        passive: false
    });
    return ()=>{
        if (sessionTimeoutId) clearTimeout(sessionTimeoutId);
        element.removeEventListener("wheel", wheelHandler);
    };
}
;
}),
"[project]/node_modules/motion-plus-dom/dist/es/index.mjs [app-ssr] (ecmascript) <locals>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2d$dom$2f$dist$2f$es$2f$split$2d$text$2f$index$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-plus-dom/dist/es/split-text/index.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2d$dom$2f$dist$2f$es$2f$typewriter$2f$delay$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-plus-dom/dist/es/typewriter/delay.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2d$dom$2f$dist$2f$es$2f$typewriter$2f$find$2d$previous$2d$word$2d$index$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-plus-dom/dist/es/typewriter/find-previous-word-index.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2d$dom$2f$dist$2f$es$2f$typewriter$2f$get$2d$next$2d$text$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-plus-dom/dist/es/typewriter/get-next-text.mjs [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$motion$2d$plus$2d$dom$2f$dist$2f$es$2f$wheel$2f$index$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/motion-plus-dom/dist/es/wheel/index.mjs [app-ssr] (ecmascript)");
;
;
;
;
;
}),
];

//# sourceMappingURL=_647d2d54._.js.map
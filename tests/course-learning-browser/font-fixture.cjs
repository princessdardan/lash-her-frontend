// Authoring interaction checks use a bundled font and make no Google request.
// This is not typography or live-provider certification.
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
const { resolve } = require("node:path");
const font = resolve(
  __dirname,
  "../../node_modules/next/dist/next-devtools/server/font/geist-latin.woff2",
);
const css = (family) => `/* latin */
@font-face { font-family: '${family}'; font-style: normal; font-weight: 100 900; src: url(${font}) format('woff2'); }`;
module.exports = {
  "https://fonts.googleapis.com/css2?family=Bebas+Neue:wght@400&display=swap":
    css("Bebas Neue"),
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap":
    css("Inter"),
};

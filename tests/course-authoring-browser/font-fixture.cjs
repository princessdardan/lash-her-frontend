// Authoring interaction checks use a bundled font and make no Google request.
// This is not typography or live-provider certification.
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
const { resolve } = require("node:path");
const font = resolve(
  __dirname,
  "../../node_modules/next/dist/next-devtools/server/font/geist-latin.woff2",
);
module.exports = new Proxy(
  {},
  {
    get(_target, url) {
      if (
        typeof url !== "string" ||
        !url.startsWith("https://fonts.googleapis.com/css2?")
      )
        return undefined;
      const family = url.includes("family=Bebas+Neue")
        ? "Bebas Neue"
        : url.includes("family=Inter")
          ? "Inter"
          : null;
      if (!family) throw new Error("Unexpected authoring font fixture request");
      return `/* latin */\n@font-face { font-family: '${family}'; font-style: normal; font-weight: 100 900; src: url(${font}) format('woff2'); }`;
    },
  },
);

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM buildpack-deps:trixie@sha256:059b2051d977584f515d03f39881bbf3c53cad9a0d1938c69d1b108ccddda48b AS zlib-build
COPY runtime/ /runtime/
RUN ulimit -c 0; sh /runtime/build.sh

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:a6c34457f6da4295807e051411c7783739c65b997a324fed14e4fa292615ae91
WORKDIR /app
COPY --from=zlib-build /out/rootfs/ /
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.mjs oidc.mjs policy.mjs admission.mjs p2-certification-fault.mjs private-tls.mjs operations.mjs routes.json release-probe.mjs ./
ENV NODE_ENV=production
ENV PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER nonroot:nonroot
ENTRYPOINT []
EXPOSE 8443
CMD ["node", "server.mjs"]

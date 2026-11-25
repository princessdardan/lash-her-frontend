FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM buildpack-deps:trixie@sha256:059b2051d977584f515d03f39881bbf3c53cad9a0d1938c69d1b108ccddda48b AS zlib-build
COPY runtime/ /runtime/
RUN ulimit -c 0; sh /runtime/build.sh

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:6abfcb367ebc291572c774c1592a986be2ab26a2486f73093401327495a5962a AS distroless-node
FROM buildpack-deps:trixie@sha256:059b2051d977584f515d03f39881bbf3c53cad9a0d1938c69d1b108ccddda48b AS node-runtime
COPY runtime/build-node.sh runtime/node-inputs.lock.json runtime/*-cve-*.patch /node-runtime/
RUN --mount=from=distroless-node,target=/distroless,ro sh /node-runtime/build-node.sh

FROM scratch AS node-reference
COPY --from=node-runtime /node-rootfs/usr/share/lash-runtime/node.json /node.json

FROM gcr.io/distroless/base-nossl-debian13:nonroot@sha256:89815d620ac01d8de13cdaf04d19ed874447ca2296d4985b14b818f6e5e47854
WORKDIR /app
COPY --from=node-runtime /node-rootfs/ /
COPY --from=zlib-build /out/rootfs/ /
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.mjs oidc.mjs policy.mjs admission.mjs assessment-attempt.mjs lesson-resume-position.mjs p2-certification-fault.mjs private-tls.mjs operations.mjs routes.json release-probe.mjs ./
COPY staging-owner-authoring.mjs staging-owner-authoring-fixture.json staging-review-course.mjs staging-review-media.mjs staging-review-community.mjs staging-review-notifications.mjs ./
ENV NODE_ENV=production
ENV PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER nonroot:nonroot
ENTRYPOINT []
EXPOSE 8443
CMD ["node", "server.mjs"]

// Generated from the Course dispute resolution projection. Run npm run contracts:generate.
export interface paths {
    "/v1/internal/entitlements/grants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post_v1_internal_entitlements_grants"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/entitlements/revocations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post_v1_internal_entitlements_revocations"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: never;
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: {
        /** @description Effective request identifier. A valid caller value is echoed; otherwise a UUID is generated. */
        RequestId: string;
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    post_v1_internal_entitlements_grants: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    courseId: string;
                    /** Format: date-time */
                    disputeStartedAt: string;
                    externalPaymentId: string;
                    /** Format: date-time */
                    grantedAt: string;
                    /** @enum {string} */
                    grantReason: "dispute_resolution";
                    idempotencyKey: string;
                    orderId: string;
                    provider: "helcim" | "square";
                    /** Format: date-time */
                    purchaseCapturedAt: string;
                    /** Format: uuid */
                    userId: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            409: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
    };
    post_v1_internal_entitlements_revocations: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    courseId: string;
                    financialReason: "refund" | "dispute";
                    grantIdempotencyKey: string;
                    idempotencyKey: string;
                    orderId: string;
                    /** Format: date-time */
                    revokedAt: string;
                    /** @enum {string} */
                    revokeReason: "purchase_fence";
                    /** Format: uuid */
                    userId: string;
                };
            };
        };
        responses: {
            /** @description Purchase grant fence committed */
            204: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            409: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
    };
}

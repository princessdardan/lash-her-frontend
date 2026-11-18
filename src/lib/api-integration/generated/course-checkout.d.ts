// Generated from the pinned integration bundle. Run npm run contracts:generate.
export interface paths {
    "/v1/internal/checkout-offer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["readFrontendCourseCheckoutOffer"];
        put?: never;
        post?: never;
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
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    readFrontendCourseCheckoutOffer: {
        parameters: {
            query: {
                courseId: string;
                userId: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    /** @description Effective request identifier. A valid caller value is echoed; otherwise a UUID is generated. */
                    "X-Request-ID"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        courseId: string;
                        /** @enum {string} */
                        currency: "CAD";
                        hasAccess: boolean;
                        priceCents: number;
                        revision: number;
                        slug: string;
                        taxClassification: string;
                        title: string;
                        /** Format: uuid */
                        userId: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    /** @description Effective request identifier. A valid caller value is echoed; otherwise a UUID is generated. */
                    "X-Request-ID"?: string;
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
            /** @description Default Response */
            401: {
                headers: {
                    /** @description Effective request identifier. A valid caller value is echoed; otherwise a UUID is generated. */
                    "X-Request-ID"?: string;
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
            /** @description Default Response */
            403: {
                headers: {
                    /** @description Effective request identifier. A valid caller value is echoed; otherwise a UUID is generated. */
                    "X-Request-ID"?: string;
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
            /** @description Default Response */
            404: {
                headers: {
                    /** @description Effective request identifier. A valid caller value is echoed; otherwise a UUID is generated. */
                    "X-Request-ID"?: string;
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
            /** @description Request rate limit exceeded */
            429: {
                headers: {
                    /** @description Effective request identifier. A valid caller value is echoed; otherwise a UUID is generated. */
                    "X-Request-ID"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "TOO_MANY_REQUESTS";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    /** @description Effective request identifier. A valid caller value is echoed; otherwise a UUID is generated. */
                    "X-Request-ID"?: string;
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

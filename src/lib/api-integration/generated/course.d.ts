// Generated from the pinned integration bundle. Run npm run contracts:generate.
export interface paths {
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLiveness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/courses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get_v1_admin_courses"];
        put?: never;
        post: operations["post_v1_admin_courses"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/courses/{courseId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patch_v1_admin_courses_By_courseId"];
        trace?: never;
    };
    "/v1/admin/courses/{courseId}/modules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post_v1_admin_courses_By_courseId_modules"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/entitlements/commands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Inspect immutable administrator entitlement commands and effects
         * @description Read-only audit view of administrator entitlement commands, including canonical actor identity, required reason, target scope, outcome, and deterministic immutable grant effects.
         */
        get: operations["get_v1_admin_entitlements_commands"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/entitlements/enrollments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Inspect enrollment projection records
         * @description Read-only support view. Email filters match only the locally cached users.email projection and may omit users whose external identity data has not been synchronized.
         */
        get: operations["get_v1_admin_entitlements_enrollments"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/entitlements/grants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Inspect entitlement grant ledger records
         * @description Read-only support view. Email filters match only the locally cached users.email projection and may omit users whose external identity data has not been synchronized.
         */
        get: operations["get_v1_admin_entitlements_grants"];
        put?: never;
        /** Create an audited administrator entitlement grant */
        post: operations["post_v1_admin_entitlements_grants"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/entitlements/revocations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Inspect immutable internal entitlement revocation commands
         * @description Read-only support view of internal service revocation commands. Manual administrator actions are recorded separately and available through the administrator command/effect audit endpoint. Email filters match only the locally cached users.email projection and may omit users whose external identity data has not been synchronized.
         */
        get: operations["get_v1_admin_entitlements_revocations"];
        put?: never;
        /**
         * Create an audited administrator entitlement revocation
         * @description The required scope discriminator makes one-grant and user/course-wide revocations explicit. It is never inferred from optional target fields.
         */
        post: operations["post_v1_admin_entitlements_revocations"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/lessons/{lessonId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patch_v1_admin_lessons_By_lessonId"];
        trace?: never;
    };
    "/v1/admin/lessons/{lessonId}/video-upload": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createAdminLessonVideoUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/modules/{moduleId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patch_v1_admin_modules_By_moduleId"];
        trace?: never;
    };
    "/v1/admin/modules/{moduleId}/lessons": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post_v1_admin_modules_By_moduleId_lessons"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/courses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get_v1_courses"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/courses/{slug}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get_v1_courses_By_slug"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/community/enrollment-snapshots": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post_v1_internal_community_enrollment_snapshots"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/community/enrollment-snapshots/{snapshotId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get_v1_internal_community_enrollment_snapshots_By_snapshotId"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/community/enrollment-snapshots/{snapshotId}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get_v1_internal_community_enrollment_snapshots_By_snapshotId_items"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/community/enrollment-streams/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post_v1_internal_community_enrollment_streams_resolve"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/community/entitlements/check": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post_v1_internal_community_entitlements_check"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/entitlements": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["get_v1_internal_entitlements"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
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
    "/v1/internal/entitlements/reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["post_v1_internal_entitlements_reconcile"];
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
    "/v1/student/courses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listStudentCourses"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/student/courses/{courseId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getStudentCourse"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/student/courses/{courseId}/lessons": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listStudentCourseLessons"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/student/lessons/{lessonId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getStudentLesson"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/student/lessons/{lessonId}/playback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["authorizeStudentLessonPlayback"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/student/lessons/{lessonId}/progress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["recordStudentLessonProgress"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/student/progress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listStudentProgress"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhooks/mux": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["processMuxWebhook"];
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
    responses: {
        /** @description Request rate limit exceeded */
        TooManyRequests: {
            headers: {
                "X-Request-ID": components["headers"]["RequestId"];
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
    };
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
    getLiveness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        status: "ok";
                    };
                };
            };
            429: components["responses"]["TooManyRequests"];
        };
    };
    get_v1_admin_courses: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        courses: {
                            currency: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            modules: {
                                /** Format: uuid */
                                courseId: string;
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                lessons: {
                                    content: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    isPreview: boolean;
                                    /** Format: uuid */
                                    moduleId: string;
                                    position: number;
                                    slug: string;
                                    title: string;
                                }[];
                                position: number;
                                slug: string;
                                title: string;
                            }[];
                            priceCents: number;
                            slug: string;
                            status: "draft" | "published" | "archived";
                            title: string;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            429: components["responses"]["TooManyRequests"];
        };
    };
    post_v1_admin_courses: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    currency?: string;
                    description?: string | null;
                    priceCents?: number;
                    slug: string;
                    status?: "draft" | "published" | "archived";
                    title: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        course: {
                            currency: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            modules: {
                                /** Format: uuid */
                                courseId: string;
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                lessons: {
                                    content: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    isPreview: boolean;
                                    /** Format: uuid */
                                    moduleId: string;
                                    position: number;
                                    slug: string;
                                    title: string;
                                }[];
                                position: number;
                                slug: string;
                                title: string;
                            }[];
                            priceCents: number;
                            slug: string;
                            status: "draft" | "published" | "archived";
                            title: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            429: components["responses"]["TooManyRequests"];
        };
    };
    patch_v1_admin_courses_By_courseId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                courseId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    currency?: string;
                    description?: string | null;
                    priceCents?: number;
                    slug?: string;
                    status?: "draft" | "published" | "archived";
                    title?: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        course: {
                            currency: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            modules: {
                                /** Format: uuid */
                                courseId: string;
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                lessons: {
                                    content: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    isPreview: boolean;
                                    /** Format: uuid */
                                    moduleId: string;
                                    position: number;
                                    slug: string;
                                    title: string;
                                }[];
                                position: number;
                                slug: string;
                                title: string;
                            }[];
                            priceCents: number;
                            slug: string;
                            status: "draft" | "published" | "archived";
                            title: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            429: components["responses"]["TooManyRequests"];
        };
    };
    post_v1_admin_courses_By_courseId_modules: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                courseId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    position: number;
                    slug: string;
                    title: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        module: {
                            /** Format: uuid */
                            courseId: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            lessons: {
                                content: string | null;
                                /** Format: uuid */
                                id: string;
                                isPreview: boolean;
                                /** Format: uuid */
                                moduleId: string;
                                position: number;
                                slug: string;
                                title: string;
                            }[];
                            position: number;
                            slug: string;
                            title: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            429: components["responses"]["TooManyRequests"];
        };
    };
    get_v1_admin_entitlements_commands: {
        parameters: {
            query?: {
                action?: "grant" | "revoke";
                actorUserId?: string;
                commandId?: string;
                courseId?: string;
                /** @description Opaque filter-bound cursor returned by the previous page. */
                cursor?: string;
                /** @description Inclusive lower bound for the administrator command effective timestamp. */
                effectiveAtFrom?: string;
                /** @description Inclusive upper bound for the administrator command effective timestamp. */
                effectiveAtTo?: string;
                grantId?: string;
                idempotencyKey?: string;
                limit?: number;
                outcome?: "applied" | "noop";
                scope?: "userCourse" | "grantId";
                userId?: string;
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
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        commands: {
                            action: "grant" | "revoke";
                            actorUserId: string;
                            affectedGrantCount: number;
                            /** Format: uuid */
                            commandId: string;
                            /** Format: uuid */
                            courseId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            effectiveAt: string;
                            effects: {
                                effectType: "grant_created" | "grant_revoked" | "no_change";
                                /** Format: uuid */
                                grantId: string;
                                previousStatus: ("active" | "revoked" | "expired") | null;
                                resultingStatus: "active" | "revoked" | "expired";
                            }[];
                            idempotencyKey: string;
                            outcome: "applied" | "noop";
                            reason: string;
                            scope: "userCourse" | "grantId";
                            targetGrantId: string | null;
                            /** Format: uuid */
                            userId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    get_v1_admin_entitlements_enrollments: {
        parameters: {
            query?: {
                courseId?: string;
                /** @description Opaque cursor returned by the previous page. */
                cursor?: string;
                /** @description Exact match against the locally cached users.email projection. Results are incomplete when external identity data has not been synchronized. */
                email?: string;
                limit?: number;
                source?: "purchase" | "admin" | "import" | "promotion";
                status?: "active" | "revoked" | "refunded";
                userId?: string;
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
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        emailLookup: {
                            /** @enum {boolean} */
                            complete: false;
                            /** @enum {string} */
                            source: "local_users_projection";
                        };
                        enrollments: {
                            /** Format: uuid */
                            courseId: string;
                            courseSlug: string;
                            courseTitle: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            enrollmentId: string;
                            /** Format: date-time */
                            grantedAt: string;
                            refundedAt: string | null;
                            revokedAt: string | null;
                            source: "purchase" | "admin" | "import" | "promotion";
                            status: "active" | "revoked" | "refunded";
                            /** Format: date-time */
                            updatedAt: string;
                            userEmail: string | null;
                            /** Format: uuid */
                            userId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    get_v1_admin_entitlements_grants: {
        parameters: {
            query?: {
                courseId?: string;
                /** @description Opaque cursor returned by the previous page. */
                cursor?: string;
                /** @description Exact match against the locally cached users.email projection. Results are incomplete when external identity data has not been synchronized. */
                email?: string;
                grantId?: string;
                grantReason?: "purchase" | "manual" | "promotion" | "import";
                idempotencyKey?: string;
                limit?: number;
                orderId?: string;
                provider?: "helcim" | "square" | "manual";
                revokeIdempotencyKey?: string;
                revokeReason?: "refund" | "dispute" | "expiry" | "manual";
                status?: "active" | "revoked" | "expired";
                userId?: string;
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
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        emailLookup: {
                            /** @enum {boolean} */
                            complete: false;
                            /** @enum {string} */
                            source: "local_users_projection";
                        };
                        grants: {
                            /** Format: uuid */
                            courseId: string;
                            courseSlug: string;
                            courseTitle: string;
                            /** Format: date-time */
                            createdAt: string;
                            enrollmentId: string | null;
                            expiresAt: string | null;
                            externalPaymentId: string | null;
                            /** Format: date-time */
                            grantedAt: string;
                            /** Format: uuid */
                            grantId: string;
                            grantReason: "purchase" | "manual" | "promotion" | "import";
                            idempotencyKey: string;
                            orderId: string | null;
                            provider: ("helcim" | "square" | "manual") | null;
                            revokedAt: string | null;
                            revokeIdempotencyKey: string | null;
                            revokeReason: ("refund" | "dispute" | "expiry" | "manual") | null;
                            status: "active" | "revoked" | "expired";
                            /** Format: date-time */
                            updatedAt: string;
                            userEmail: string | null;
                            /** Format: uuid */
                            userId: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    post_v1_admin_entitlements_grants: {
        parameters: {
            query?: never;
            header: {
                "x-idempotency-key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    courseId: string;
                    idempotencyKey: string;
                    reason: string;
                    /** Format: uuid */
                    userId: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        action: "grant" | "revoke";
                        actorUserId: string;
                        affectedGrantCount: number;
                        /** Format: uuid */
                        commandId: string;
                        /** Format: uuid */
                        courseId: string;
                        /** Format: date-time */
                        effectiveAt: string;
                        effects: {
                            effectType: "grant_created" | "grant_revoked" | "no_change";
                            /** Format: uuid */
                            grantId: string;
                            previousStatus: ("active" | "revoked" | "expired") | null;
                            resultingStatus: "active" | "revoked" | "expired";
                        }[];
                        /** @enum {boolean} */
                        idempotentReplay?: true;
                        outcome: "applied" | "noop";
                        reason: string;
                        scope: "userCourse" | "grantId";
                        targetGrantId: string | null;
                        /** Format: uuid */
                        userId: string;
                    };
                };
            };
            /** @description Default Response */
            201: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        action: "grant" | "revoke";
                        actorUserId: string;
                        affectedGrantCount: number;
                        /** Format: uuid */
                        commandId: string;
                        /** Format: uuid */
                        courseId: string;
                        /** Format: date-time */
                        effectiveAt: string;
                        effects: {
                            effectType: "grant_created" | "grant_revoked" | "no_change";
                            /** Format: uuid */
                            grantId: string;
                            previousStatus: ("active" | "revoked" | "expired") | null;
                            resultingStatus: "active" | "revoked" | "expired";
                        }[];
                        /** @enum {boolean} */
                        idempotentReplay?: true;
                        outcome: "applied" | "noop";
                        reason: string;
                        scope: "userCourse" | "grantId";
                        targetGrantId: string | null;
                        /** Format: uuid */
                        userId: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    get_v1_admin_entitlements_revocations: {
        parameters: {
            query?: {
                courseId?: string;
                /** @description Opaque cursor returned by the previous page. */
                cursor?: string;
                /** @description Exact match against the locally cached users.email projection. Results are incomplete when external identity data has not been synchronized. */
                email?: string;
                grantId?: string;
                idempotencyKey?: string;
                limit?: number;
                orderId?: string;
                revocationId?: string;
                /** @description Inclusive lower bound for the revocation command timestamp. */
                revokedAtFrom?: string;
                /** @description Inclusive upper bound for the revocation command timestamp. */
                revokedAtTo?: string;
                revokeReason?: "refund" | "dispute" | "expiry" | "manual";
                userId?: string;
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
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        emailLookup: {
                            /** @enum {boolean} */
                            complete: false;
                            /** @enum {string} */
                            source: "local_users_projection";
                        };
                        nextCursor: string | null;
                        revocations: {
                            /** Format: uuid */
                            courseId: string;
                            courseSlug: string;
                            courseTitle: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            grantId: string;
                            idempotencyKey: string;
                            orderId: string | null;
                            /** Format: uuid */
                            revocationId: string;
                            /** Format: date-time */
                            revokedAt: string;
                            revokeReason: "refund" | "dispute" | "expiry" | "manual";
                            userEmail: string | null;
                            /** Format: uuid */
                            userId: string;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    post_v1_admin_entitlements_revocations: {
        parameters: {
            query?: never;
            header: {
                "x-idempotency-key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    courseId?: unknown;
                    /** Format: uuid */
                    grantId: string;
                    idempotencyKey: string;
                    reason: string;
                    /** @enum {string} */
                    scope: "grantId";
                    userId?: unknown;
                } | {
                    /** Format: uuid */
                    courseId: string;
                    grantId?: unknown;
                    idempotencyKey: string;
                    reason: string;
                    /** @enum {string} */
                    scope: "userCourse";
                    /** Format: uuid */
                    userId: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        action: "grant" | "revoke";
                        actorUserId: string;
                        affectedGrantCount: number;
                        /** Format: uuid */
                        commandId: string;
                        /** Format: uuid */
                        courseId: string;
                        /** Format: date-time */
                        effectiveAt: string;
                        effects: {
                            effectType: "grant_created" | "grant_revoked" | "no_change";
                            /** Format: uuid */
                            grantId: string;
                            previousStatus: ("active" | "revoked" | "expired") | null;
                            resultingStatus: "active" | "revoked" | "expired";
                        }[];
                        /** @enum {boolean} */
                        idempotentReplay?: true;
                        outcome: "applied" | "noop";
                        reason: string;
                        scope: "userCourse" | "grantId";
                        targetGrantId: string | null;
                        /** Format: uuid */
                        userId: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    patch_v1_admin_lessons_By_lessonId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                lessonId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content?: string | null;
                    isPreview?: boolean;
                    position?: number;
                    slug?: string;
                    title?: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        lesson: {
                            content: string | null;
                            /** Format: uuid */
                            id: string;
                            isPreview: boolean;
                            /** Format: uuid */
                            moduleId: string;
                            position: number;
                            slug: string;
                            title: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            429: components["responses"]["TooManyRequests"];
        };
    };
    createAdminLessonVideoUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                lessonId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        upload: {
                            id: string;
                            timeoutSeconds: number;
                            url: string;
                        };
                        videoAsset: {
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            lessonId: string;
                            status: "pending" | "uploading" | "processing" | "ready" | "errored";
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    patch_v1_admin_modules_By_moduleId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                moduleId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    position?: number;
                    slug?: string;
                    title?: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        module: {
                            /** Format: uuid */
                            courseId: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            lessons: {
                                content: string | null;
                                /** Format: uuid */
                                id: string;
                                isPreview: boolean;
                                /** Format: uuid */
                                moduleId: string;
                                position: number;
                                slug: string;
                                title: string;
                            }[];
                            position: number;
                            slug: string;
                            title: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            429: components["responses"]["TooManyRequests"];
        };
    };
    post_v1_admin_modules_By_moduleId_lessons: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                moduleId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content?: string | null;
                    isPreview?: boolean;
                    position: number;
                    slug: string;
                    title: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        lesson: {
                            content: string | null;
                            /** Format: uuid */
                            id: string;
                            isPreview: boolean;
                            /** Format: uuid */
                            moduleId: string;
                            position: number;
                            slug: string;
                            title: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            429: components["responses"]["TooManyRequests"];
        };
    };
    get_v1_courses: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        courses: {
                            currency: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            priceCents: number;
                            slug: string;
                            title: string;
                        }[];
                    };
                };
            };
            429: components["responses"]["TooManyRequests"];
        };
    };
    get_v1_courses_By_slug: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        course: {
                            currency: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            priceCents: number;
                            slug: string;
                            title: string;
                        } & {
                            modules: {
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                lessons: {
                                    /** Format: uuid */
                                    id: string;
                                    /** @enum {boolean} */
                                    isPreview: true;
                                    position: number;
                                    slug: string;
                                    title: string;
                                }[];
                                position: number;
                                slug: string;
                                title: string;
                            }[];
                        };
                    };
                };
            };
            /** @description Default Response */
            404: {
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
            429: components["responses"]["TooManyRequests"];
        };
    };
    post_v1_internal_community_enrollment_snapshots: {
        parameters: {
            query?: never;
            header: {
                "x-idempotency-key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    idempotencyKey: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        completedAt: string | null;
                        expiresAt: string | null;
                        failureCode: string | null;
                        idempotentReplay: boolean;
                        /** Format: date-time */
                        requestedAt: string;
                        rowCount: number | null;
                        /** Format: uuid */
                        snapshotId: string;
                        startedAt: string | null;
                        status: "requested" | "building" | "ready" | "failed" | "expired";
                    };
                };
            };
            /** @description Default Response */
            202: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        completedAt: string | null;
                        expiresAt: string | null;
                        failureCode: string | null;
                        idempotentReplay: boolean;
                        /** Format: date-time */
                        requestedAt: string;
                        rowCount: number | null;
                        /** Format: uuid */
                        snapshotId: string;
                        startedAt: string | null;
                        status: "requested" | "building" | "ready" | "failed" | "expired";
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            /** @description Default Response */
            410: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    get_v1_internal_community_enrollment_snapshots_By_snapshotId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                snapshotId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        completedAt: string | null;
                        expiresAt: string | null;
                        failureCode: string | null;
                        /** Format: date-time */
                        requestedAt: string;
                        rowCount: number | null;
                        /** Format: uuid */
                        snapshotId: string;
                        startedAt: string | null;
                        status: "requested" | "building" | "ready" | "failed" | "expired";
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            /** @description Default Response */
            410: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    get_v1_internal_community_enrollment_snapshots_By_snapshotId_items: {
        parameters: {
            query?: {
                afterStreamId?: string;
                limit?: number;
            };
            header?: never;
            path: {
                snapshotId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** Format: uuid */
                            courseId: string;
                            /** Format: date-time */
                            effectiveAt: string;
                            state: "active" | "revoked";
                            /** Format: uuid */
                            streamId: string;
                            /** Format: uuid */
                            userId: string;
                            version: number;
                        }[];
                        nextAfterStreamId: string | null;
                        /** Format: uuid */
                        snapshotId: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            /** @description Default Response */
            410: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    post_v1_internal_community_enrollment_streams_resolve: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    minimumVersion: number;
                    /** Format: uuid */
                    streamId: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        courseId: string;
                        /** Format: date-time */
                        effectiveAt: string;
                        state: "active" | "revoked";
                        /** Format: uuid */
                        streamId: string;
                        /** Format: uuid */
                        userId: string;
                        version: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            /** @description Default Response */
            410: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    post_v1_internal_community_entitlements_check: {
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
                    /** Format: uuid */
                    userId: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        courseId: string;
                        /** Format: date-time */
                        evaluatedAt: string;
                        expiresAt: string | null;
                        hasAccess: boolean;
                        /** Format: uuid */
                        userId: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            /** @description Default Response */
            410: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    get_v1_internal_entitlements: {
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
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        courseId: string;
                        expiresAt: string | null;
                        grantId: string | null;
                        hasAccess: boolean;
                        /** Format: uuid */
                        userId: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    post_v1_internal_entitlements_grants: {
        parameters: {
            query?: never;
            header: {
                "x-idempotency-key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    courseId: string;
                    expiresAt?: string | null;
                    externalPaymentId?: string;
                    /** Format: date-time */
                    grantedAt: string;
                    grantReason: "purchase" | "promotion" | "import";
                    idempotencyKey: string;
                    orderId: string;
                    provider?: "helcim" | "square";
                    /** Format: uuid */
                    userId: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        courseId: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        grantId: string;
                        /** @enum {boolean} */
                        idempotentReplay?: true;
                        status: "active" | "revoked" | "expired";
                        /** Format: uuid */
                        userId: string;
                    };
                };
            };
            /** @description Default Response */
            201: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        courseId: string;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: uuid */
                        grantId: string;
                        /** @enum {boolean} */
                        idempotentReplay?: true;
                        status: "active" | "revoked" | "expired";
                        /** Format: uuid */
                        userId: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            /** @description Default Response */
            422: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    post_v1_internal_entitlements_reconcile: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    checkpoint?: string | null;
                    grants: {
                        /** Format: uuid */
                        courseId: string;
                        expectedStatus: "active" | "revoked" | "missing";
                        orderId: string;
                        /** Format: uuid */
                        userId: string;
                    }[];
                    /** @default 100 */
                    pageSize?: number;
                    scopes?: {
                        /** Format: uuid */
                        courseId: string;
                        /** Format: uuid */
                        userId: string;
                    }[];
                    /** @default false */
                    snapshotComplete?: boolean;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: date-time */
                        checkpoint: string;
                        mismatches: {
                            actualStatus: "active" | "revoked" | "expired" | "missing";
                            /** Format: uuid */
                            courseId: string;
                            expectedStatus: "active" | "revoked" | "missing";
                            mismatchType: "missing_active_grant" | "unexpected_active_grant" | "status_mismatch" | "source_requires_review" | "missing_user" | "missing_course" | "duplicate_grant" | "admin_override" | "expired_grant" | "order_not_found";
                            orderId: string;
                            suggestedAction: "grant" | "revoke" | "investigate";
                            /** Format: uuid */
                            userId: string;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
            header: {
                "x-idempotency-key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    courseId: string;
                    idempotencyKey: string;
                    orderId: string;
                    /** Format: date-time */
                    revokedAt: string;
                    revokeReason: "refund" | "dispute" | "expiry";
                    /** Format: uuid */
                    userId: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        courseId: string;
                        /** Format: uuid */
                        grantId: string;
                        /** @enum {boolean} */
                        idempotentReplay?: true;
                        /** Format: date-time */
                        revokedAt: string;
                        status: "active" | "revoked" | "expired";
                        /** Format: uuid */
                        userId: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
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
            /** @description Default Response */
            401: {
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
            /** @description Default Response */
            403: {
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
            /** @description Default Response */
            404: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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
    listStudentCourses: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        courses: {
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            progress: {
                                completedLessons: number;
                                continueLessonId: string | null;
                                continuePositionSeconds: number | null;
                                lastActivityAt: string | null;
                                percentComplete: number;
                                totalLessons: number;
                            };
                            slug: string;
                            status: "published" | "archived";
                            title: string;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "UNAUTHORIZED";
                            message: string;
                        };
                    };
                };
            };
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "INTERNAL_SERVER_ERROR";
                            message: string;
                        };
                    };
                };
            };
        };
    };
    getStudentCourse: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                courseId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        course: {
                            currency: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            priceCents: number;
                            slug: string;
                            title: string;
                        } & {
                            modules: {
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                lessons: {
                                    content: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    isPreview: boolean;
                                    /** Format: uuid */
                                    moduleId: string;
                                    position: number;
                                    slug: string;
                                    title: string;
                                }[];
                                position: number;
                                slug: string;
                                title: string;
                            }[];
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "BAD_REQUEST";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "UNAUTHORIZED";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: "ACTIVE_ENROLLMENT_REQUIRED" | "ENTITLEMENT_REVOKED";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "COURSE_NOT_FOUND";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            410: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "COURSE_ARCHIVED";
                            message: string;
                        };
                    };
                };
            };
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "INTERNAL_SERVER_ERROR";
                            message: string;
                        };
                    };
                };
            };
        };
    };
    listStudentCourseLessons: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                courseId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        course: {
                            currency: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            priceCents: number;
                            slug: string;
                            title: string;
                        } & {
                            modules: {
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                lessons: {
                                    content: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    isPreview: boolean;
                                    /** Format: uuid */
                                    moduleId: string;
                                    position: number;
                                    slug: string;
                                    title: string;
                                }[];
                                position: number;
                                slug: string;
                                title: string;
                            }[];
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "BAD_REQUEST";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "UNAUTHORIZED";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: "ACTIVE_ENROLLMENT_REQUIRED" | "ENTITLEMENT_REVOKED";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "COURSE_NOT_FOUND";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            410: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "COURSE_ARCHIVED";
                            message: string;
                        };
                    };
                };
            };
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "INTERNAL_SERVER_ERROR";
                            message: string;
                        };
                    };
                };
            };
        };
    };
    getStudentLesson: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                lessonId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        lesson: {
                            content: string | null;
                            /** Format: uuid */
                            id: string;
                            isPreview: boolean;
                            /** Format: uuid */
                            moduleId: string;
                            position: number;
                            slug: string;
                            title: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "BAD_REQUEST";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "UNAUTHORIZED";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: "ACTIVE_ENROLLMENT_REQUIRED" | "ENTITLEMENT_REVOKED";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "LESSON_NOT_FOUND";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            410: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "COURSE_ARCHIVED";
                            message: string;
                        };
                    };
                };
            };
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "INTERNAL_SERVER_ERROR";
                            message: string;
                        };
                    };
                };
            };
        };
    };
    authorizeStudentLessonPlayback: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                lessonId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: date-time */
                        expiresAt: string;
                        playbackId: string;
                        playbackToken: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "BAD_REQUEST";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "UNAUTHORIZED";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: "ACTIVE_ENROLLMENT_REQUIRED" | "ENTITLEMENT_REVOKED";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "LESSON_NOT_FOUND";
                            message: string;
                        };
                    };
                };
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
                            /** @enum {string} */
                            code: "VIDEO_PROCESSING";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            410: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "COURSE_ARCHIVED";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            422: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "VIDEO_UNAVAILABLE";
                            message: string;
                        };
                    };
                };
            };
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "INTERNAL_SERVER_ERROR";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            502: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "BAD_GATEWAY";
                            message: string;
                        };
                    };
                };
            };
        };
    };
    recordStudentLessonProgress: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                lessonId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    event?: "lesson_started" | "lesson_completed";
                    maxPositionSeconds?: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        progress: {
                            completedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            enrollmentId: string | null;
                            /** Format: uuid */
                            id: string;
                            lastWatchedAt: string | null;
                            /** Format: uuid */
                            lessonId: string;
                            maxPositionSeconds: number;
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            userId: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "BAD_REQUEST";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "UNAUTHORIZED";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: "ACTIVE_ENROLLMENT_REQUIRED" | "ENTITLEMENT_REVOKED";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "LESSON_NOT_FOUND";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            410: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "COURSE_ARCHIVED";
                            message: string;
                        };
                    };
                };
            };
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "INTERNAL_SERVER_ERROR";
                            message: string;
                        };
                    };
                };
            };
        };
    };
    listStudentProgress: {
        parameters: {
            query?: {
                courseId?: string;
                lessonId?: string;
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
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        progress: {
                            completedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            enrollmentId: string | null;
                            /** Format: uuid */
                            id: string;
                            lastWatchedAt: string | null;
                            /** Format: uuid */
                            lessonId: string;
                            maxPositionSeconds: number;
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            userId: string;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "BAD_REQUEST";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "UNAUTHORIZED";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: "ACTIVE_ENROLLMENT_REQUIRED" | "ENTITLEMENT_REVOKED";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: "COURSE_NOT_FOUND" | "LESSON_NOT_FOUND";
                            message: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            410: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "COURSE_ARCHIVED";
                            message: string;
                        };
                    };
                };
            };
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            /** @enum {string} */
                            code: "INTERNAL_SERVER_ERROR";
                            message: string;
                        };
                    };
                };
            };
        };
    };
    processMuxWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        videoAsset: {
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            lessonId: string;
                            status: "pending" | "uploading" | "processing" | "ready" | "errored";
                        };
                    };
                };
            };
            /** @description Default Response */
            204: {
                headers: {
                    "X-Request-ID": components["headers"]["RequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
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
            429: components["responses"]["TooManyRequests"];
            /** @description Default Response */
            500: {
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

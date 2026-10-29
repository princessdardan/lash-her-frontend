// Generated from the pinned integration bundle. Run npm run contracts:generate.
export type paths = Record<string, never>;
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        AccountLifecycleCommand: {
            accountVersion: number;
            /** @enum {string} */
            action: "suspend" | "restore" | "export" | "delete";
            commandId: string;
            /** Format: date-time */
            issuedAt: string;
            userId: string;
            /** @constant */
            version: 1;
        };
        AccountLifecycleReceipt: {
            accountVersion: number;
            commandId: string;
            /** @enum {string} */
            status: "accepted" | "duplicate";
        };
        CommunityAdminClaims: {
            /** @constant */
            aud: "lash-her-community-api:admin";
            capabilities: "community-moderator"[];
            exp: number;
            iat: number;
            /** @constant */
            iss: "lash-her-frontend";
            /** Format: uuid */
            jti: string;
            sub: string;
            /** @constant */
            version: 1;
        };
        CommunityError: {
            error: {
                code: string;
                message: string;
            };
            requestId: string;
        };
        CommunityMemberClaims: {
            /** @constant */
            aud: "lash-her-community-api:member";
            exp: number;
            iat: number;
            /** @constant */
            iss: "lash-her-frontend";
            /** Format: uuid */
            jti: string;
            sub: string;
            /** @constant */
            version: 1;
        };
        CourseAdminClaims: {
            /** @constant */
            aud: "lash-her-course-api:admin";
            capabilities: ("course-editor" | "course-support")[];
            exp: number;
            iat: number;
            /** @constant */
            iss: "lash-her-frontend";
            /** Format: uuid */
            jti: string;
            sub: string;
            /** @constant */
            version: 1;
        };
        CourseError: {
            error: {
                code: string;
                message: string;
            };
        };
        CourseLearnerClaims: {
            /** @constant */
            aud: "lash-her-course-api:learner";
            exp: number;
            iat: number;
            /** @constant */
            iss: "lash-her-frontend";
            /** Format: uuid */
            jti: string;
            sub: string;
            /** @constant */
            version: 1;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
